// ==========================================================================
// importers/tabla.js
// --------------------------------------------------------------------------
// Lectura de una tabla arbitraria (.xlsx o .csv) para importar reclamos:
// detección de columnas por nombre, reparación de encoding y parseo de
// coordenadas. No sabe nada de LLM ni de la base — sólo deja las filas en una
// forma consistente para scripts/import-reclamos.js.
// ==========================================================================

const path = require('path');
// Fork mantenido de SheetJS: `main` migró a este paquete y sacó `xlsx` de las
// dependencias. La API es la misma (readFile + utils.sheet_to_json).
const XLSX = require('@stackline/xlsx');

// --------------------------------------------------------------------------
// Detección de columnas
// --------------------------------------------------------------------------

/**
 * Campo interno -> variantes de nombre aceptadas (plegadas: sin acentos, sin
 * mayúsculas, sin separadores). El orden importa: gana la primera que aparezca.
 */
const VARIANTES = {
  texto: ['texto', 'comentario', 'contenido', 'mensaje', 'hitsentence', 'hit_sentence', 'tweet', 'post'],
  fecha: ['fecha', 'date', 'mes', 'fechahora', 'created_at', 'createdat'],
  autor: ['autor', 'usuario', 'cuenta', 'user', 'username', 'author'],
  link: ['link', 'url', 'enlace', 'permalink'],
  // Opcionales: si no están, se vive sin ellas.
  direccion: ['direccion', 'domicilio', 'ubicacion', 'address'],
  categoria: ['categoria', 'category', 'tema', 'rubro'],
  x: ['x', 'lon', 'lng', 'longitud', 'longitude'],
  y: ['y', 'lat', 'latitud', 'latitude'],
  comuna: ['comuna'],
};

/** Campos sin los cuales no se puede importar. */
const OBLIGATORIOS = ['texto'];

function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_.-]+/g, '')
    .trim();
}

/**
 * @param {string[]} columnas nombres tal como vienen en el archivo
 * @param {Record<string,string>} manual campo -> nombre de columna, para pisar la detección
 * @returns {{ mapeo: Record<string,string|null>, faltan: string[] }}
 */
function detectarColumnas(columnas, manual = {}) {
  const porFold = new Map();
  for (const c of columnas) {
    const k = fold(c);
    if (!porFold.has(k)) porFold.set(k, c);
  }

  const mapeo = {};
  for (const [campo, variantes] of Object.entries(VARIANTES)) {
    if (manual[campo]) {
      const existe = columnas.find((c) => fold(c) === fold(manual[campo]));
      mapeo[campo] = existe || null;
      continue;
    }
    mapeo[campo] = null;
    for (const v of variantes) {
      const hit = porFold.get(fold(v));
      if (hit) {
        mapeo[campo] = hit;
        break;
      }
    }
  }

  const faltan = OBLIGATORIOS.filter((c) => !mapeo[c]);
  return { mapeo, faltan };
}

// --------------------------------------------------------------------------
// Encoding
// --------------------------------------------------------------------------

// Mojibake típico de UTF-8 leído como Latin-1: "QuÃ©", "porteÃ±o", "aÃ±os".
// La secuencia delatora es Ã/Â seguida de un byte de continuación.
// CP1252 usa el rango 0x80-0x9F para caracteres que Latin-1 deja vacio. El
// mojibake de este tipo de archivos viene de ahi, no de Latin-1 puro: los
// bytes de un emoji (0x9F, 0x93, 0x91...) aparecen como Y-dieresis, comillas
// tipograficas, etc. Revertir con latin1 los pierde y arruina la reparacion
// de TODO el texto, aunque las vocales acentuadas si se puedan recuperar.
const CP1252_INVERSO = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const MOJIBAKE_LIDER = new Set([0x00c3, 0x00c2]);

// La secuencia delatora es U+00C3 o U+00C2 seguida de un byte de continuacion
// (U+0080..U+00BF). Se compara por codigo y no con literales para que el
// patron no dependa de con que encoding se guardo ESTE archivo.
function pareceMojibake(texto) {
  const s = String(texto || '');
  for (let i = 0; i < s.length - 1; i++) {
    if (MOJIBAKE_LIDER.has(s.charCodeAt(i))) {
      const sig = s.charCodeAt(i + 1);
      if (sig >= 0x0080 && sig <= 0x00bf) return true;
    }
  }
  return false;
}

/**
 * Revierte el mojibake releyendo los bytes como UTF-8.
 * @returns {string|null} null si la reparación no es confiable (quedó con
 *   caracteres de reemplazo), para que quien llama pueda abortar en vez de
 *   guardar texto corrupto: un texto roto clasifica mal y queda mal para siempre.
 */
function repararMojibake(texto) {
  const s = String(texto == null ? '' : texto);
  if (!s) return s;

  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff) {
      bytes.push(cp);
      continue;
    }
    const byte = CP1252_INVERSO.get(cp);
    if (byte == null) return null; // no vino de CP1252: no lo tocamos.
    bytes.push(byte);
  }

  const reparado = Buffer.from(bytes).toString('utf8');
  if (reparado.includes('�')) return null;
  return reparado;
}

/**
 * Diagnostica el encoding de una muestra de textos.
 * @returns {{ afectados: number, total: number, reparables: number, ejemplos: Array<{antes:string,despues:string}> }}
 */
function diagnosticarEncoding(textos) {
  let afectados = 0;
  let reparables = 0;
  const ejemplos = [];
  for (const t of textos) {
    if (!pareceMojibake(t)) continue;
    afectados += 1;
    const r = repararMojibake(t);
    if (r != null) {
      reparables += 1;
      if (ejemplos.length < 3) {
        ejemplos.push({ antes: String(t).slice(0, 70), despues: r.slice(0, 70) });
      }
    }
  }
  return { afectados, total: textos.length, reparables, ejemplos };
}

// --------------------------------------------------------------------------
// Coordenadas
// --------------------------------------------------------------------------

// Caja de CABA, con un margen chico. Sirve para validar, no para recortar.
const CABA_BBOX = { latMin: -34.71, latMax: -34.53, lonMin: -58.54, lonMax: -58.33 };

function enCaba(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= CABA_BBOX.latMin &&
    lat <= CABA_BBOX.latMax &&
    lon >= CABA_BBOX.lonMin &&
    lon <= CABA_BBOX.lonMax
  );
}

/** -58489321 -> -58.489321: mete el punto después de los dos primeros dígitos. */
function insertarDecimal(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return NaN;
  const s = String(Math.abs(n));
  if (!/^\d+$/.test(s) || s.length < 3) return NaN;
  const conPunto = Number(`${s.slice(0, 2)}.${s.slice(2)}`);
  return n < 0 ? -conPunto : conPunto;
}

/**
 * Convierte el par (x, y) del archivo a {lon, lat}, o null si no se puede
 * confiar en el resultado.
 *
 * La columna viene MEZCLADA: en el archivo de prueba, 1043 filas traen el
 * entero sin punto (-58489321) y 294 ya vienen como decimal correcto
 * (-58.372033). Aplicar la conversión a ciegas rompe las segundas, así que
 * primero se prueba el valor tal cual y sólo se inserta el decimal si hace
 * falta. En ambos casos se valida contra la caja de CABA: lo que no cae
 * adentro se descarta y esa fila se manda a geocodificar con USIG.
 *
 * `x` es longitud e `y` es latitud (verificado contra los datos, no asumido).
 *
 * @returns {{ lon: number, lat: number, formato: 'decimal'|'entero' } | null}
 */
function parsearCoordenadas(xRaw, yRaw) {
  if (xRaw == null || yRaw == null || xRaw === '' || yRaw === '' || xRaw === 'NULL' || yRaw === 'NULL') {
    return null;
  }

  const xn = Number(xRaw);
  const yn = Number(yRaw);
  if (enCaba(yn, xn)) return { lon: xn, lat: yn, formato: 'decimal' };

  const xc = insertarDecimal(xRaw);
  const yc = insertarDecimal(yRaw);
  if (enCaba(yc, xc)) return { lon: xc, lat: yc, formato: 'entero' };

  return null;
}

// --------------------------------------------------------------------------
// Lectura
// --------------------------------------------------------------------------

/**
 * Lee .xlsx o .csv y devuelve filas como objetos, con las columnas tal cual.
 * @returns {{ columnas: string[], filas: object[], hoja: string }}
 */
function leerTabla(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.xlsx', '.xls', '.xlsm', '.csv', '.tsv'].includes(ext)) {
    throw new Error(`Extensión no soportada: "${ext}". Se aceptan .xlsx y .csv.`);
  }

  const wb = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const hoja = wb.SheetNames[0];
  if (!hoja) throw new Error('El archivo no tiene ninguna hoja.');

  const filas = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { defval: null });
  if (filas.length === 0) throw new Error('El archivo no tiene filas de datos.');

  // Unión de claves: una fila suelta puede no traer todas las columnas.
  const vistas = new Set();
  for (const f of filas.slice(0, 50)) for (const k of Object.keys(f)) vistas.add(k);

  return { columnas: [...vistas], filas, hoja };
}

module.exports = {
  VARIANTES,
  OBLIGATORIOS,
  CABA_BBOX,
  leerTabla,
  detectarColumnas,
  pareceMojibake,
  repararMojibake,
  diagnosticarEncoding,
  parsearCoordenadas,
  insertarDecimal,
  enCaba,
  fold,
};
