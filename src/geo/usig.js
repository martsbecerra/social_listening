// ==========================================================================
// geo/usig.js
// --------------------------------------------------------------------------
// Los servicios de USIG (GCBA) que usa la georreferenciación (fase H). Lo
// que se vio el 25/10/2026 y decide cómo se usan:
//
// - servicios.usig.buenosaires.gob.ar/normalizar con `geocodificar=true` (y
//   la geocodificación inversa por lat/lng) se cuelga: no devuelve nada en
//   30 s. Sin `geocodificar` responde (lento: de 2 a 30 s) con los
//   candidatos y sus códigos de calle; un cruce trae además su punto.
// - ws.usig.buenosaires.gob.ar responde en menos de medio segundo:
//   `rest/normalizar_y_geocodificar_direcciones` (calle y altura por
//   separado; avisa la ambigüedad con `desambiguar=0`),
//   `geocoder/2.2/geocoding` (por código de calle y altura, o dos códigos
//   para un cruce) y `geocoder/2.2/reversegeocoding` (la puerta y la esquina
//   de un punto). Sus coordenadas son Gauss-Krüger: proyecciones.js.
//
// Entonces: calle y altura → ws; cruce y texto libre → el normalizador (sin
// geocodificar) para los candidatos y sus códigos, y el punto de su
// respuesta o de ws; la inversa → ws. Más de `usig.opciones_maximas` (2)
// candidatos distintos es "ambigua": no se elige uno al azar.
//
// Todo pedido va por geoLimiter, con reintentos y tope de tiempo. Una
// respuesta que no es 200, un corte o un tiempo agotado es un error
// PASAJERO (err.transient): no dice nada de la dirección y nunca se cachea.
// ==========================================================================

const { geoLimiter, errorPasajero } = require('./datasets');
const { geoConfig } = require('./config');
const { gkBaALonLat, lonLatAGkBa } = require('./proyecciones');
const { normalizarLugar, prepararParaUsig, conCaba } = require('./texto');

const WS = 'https://ws.usig.buenosaires.gob.ar';
const NORMALIZADOR = 'https://servicios.usig.buenosaires.gob.ar/normalizar';
const INTENTOS = 3;
const ESPERA_BASE_MS = 500;
const TIMEOUT_WS_MS = 10000;
const TIMEOUT_NORMALIZADOR_MS = 35000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET con reintentos. Devuelve el cuerpo ya leído (JSON, o el texto si no lo es). */
async function pedir(url, { timeoutMs }) {
  let ultimo;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    try {
      return await geoLimiter.run(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(url, { signal: controller.signal });
          if (resp.status !== 200) throw errorPasajero(`USIG HTTP ${resp.status}`);
          const texto = await resp.text();
          // geocoder/2.2 contesta "({...})".
          const limpio = texto.trim().replace(/^\(([\s\S]*)\)$/, '$1');
          try {
            return JSON.parse(limpio);
          } catch {
            return limpio;
          }
        } catch (err) {
          throw err.transient ? err : errorPasajero(`USIG: ${err.name === 'AbortError' ? 'sin respuesta a tiempo' : err.message}`);
        } finally {
          clearTimeout(timer);
        }
      }, 'usig');
    } catch (err) {
      ultimo = err;
      if (intento < INTENTOS) await dormir(ESPERA_BASE_MS * 2 ** (intento - 1));
    }
  }
  throw ultimo;
}

const numero = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Un punto que se puede mostrar: las dos coordenadas y no el (0,0). */
function puntoValido(x, y) {
  return x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0);
}

function deGk(x, y) {
  const gx = numero(x);
  const gy = numero(y);
  if (!puntoValido(gx, gy)) return null;
  const { lon, lat } = gkBaALonLat(gx, gy);
  return { x: lon, y: lat };
}

function opcionesMaximas() {
  const c = geoConfig();
  return (c.usig && Number(c.usig.opciones_maximas)) || 2;
}

// El candidato cuyo nombre es el buscado ("SAN MARTIN" para "San Martín",
// antes que "ESCALADA DE SAN MARTIN, R."); si ninguno, el primero.
function elegir(candidatos, nombreBuscado, nombreDe) {
  const buscado = normalizarLugar(nombreBuscado).replace(/\bavenida\b/g, '').trim();
  return candidatos.find((c) => normalizarLugar(nombreDe(c)).replace(/\bavenida\b/g, '').trim() === buscado) || candidatos[0];
}

async function puntoPorCodigo({ codCalle, altura = null, codCruce = null }) {
  const url = new URL(`${WS}/geocoder/2.2/geocoding/`);
  if (codCruce) {
    url.searchParams.set('cod_calle1', codCalle);
    url.searchParams.set('cod_calle2', codCruce);
  } else {
    url.searchParams.set('cod_calle', codCalle);
    url.searchParams.set('altura', altura);
  }
  const r = await pedir(url, { timeoutMs: TIMEOUT_WS_MS });
  return r && typeof r === 'object' ? deGk(r.x, r.y) : null;
}

/**
 * Calle y altura (ws). Resultado: { estado: 'ok', x, y, calle, altura,
 * direccion } | { estado: 'ambigua', opciones } | { estado: 'no_encontrada' }.
 */
async function calleAltura(calle, altura) {
  const url = new URL(`${WS}/rest/normalizar_y_geocodificar_direcciones`);
  url.searchParams.set('calle', prepararParaUsig(calle));
  url.searchParams.set('altura', String(altura));
  url.searchParams.set('desambiguar', '0');
  const r = await pedir(url, { timeoutMs: TIMEOUT_WS_MS });
  const norm = r && r.Normalizacion;
  if (!norm) return { estado: 'no_encontrada' };
  const lista = (norm.DireccionesCalleAltura && norm.DireccionesCalleAltura.direcciones) || [];
  if (norm.TipoResultado === 'DireccionNormalizada' && lista[0]) {
    const p = deGk(r.GeoCodificacion && r.GeoCodificacion.x, r.GeoCodificacion && r.GeoCodificacion.y) || (await puntoPorCodigo({ codCalle: lista[0].CodigoCalle, altura }));
    if (!p) return { estado: 'no_encontrada' };
    return { estado: 'ok', ...p, calle: lista[0].Calle, altura: Number(lista[0].Altura), direccion: `${lista[0].Calle} ${lista[0].Altura}` };
  }
  if (norm.TipoResultado === 'Ambiguedad' && lista.length) {
    if (lista.length > opcionesMaximas()) return { estado: 'ambigua', opciones: lista.map((d) => `${d.Calle} ${d.Altura}`) };
    const d = elegir(lista, calle, (c) => c.Calle);
    const p = await puntoPorCodigo({ codCalle: d.CodigoCalle, altura });
    if (!p) return { estado: 'no_encontrada' };
    return { estado: 'ok', ...p, calle: d.Calle, altura: Number(d.Altura), direccion: `${d.Calle} ${d.Altura}` };
  }
  return { estado: 'no_encontrada' };
}

// Los candidatos del normalizador, sin geocodificar (ver arriba).
async function normalizar(texto) {
  const url = new URL(NORMALIZADOR);
  url.searchParams.set('direccion', texto);
  const r = await pedir(url, { timeoutMs: TIMEOUT_NORMALIZADOR_MS });
  return (r && Array.isArray(r.direccionesNormalizadas) && r.direccionesNormalizadas) || [];
}

// Dos candidatos con los mismos códigos ("BACACAY" y "BACACAY AV.") son uno.
function distintos(candidatos) {
  const vistos = new Map();
  for (const c of candidatos) {
    const k = `${c.cod_calle}|${c.cod_calle_cruce ?? ''}|${c.altura ?? ''}`;
    if (!vistos.has(k)) vistos.set(k, c);
  }
  return [...vistos.values()];
}

async function puntoDeCandidato(c) {
  const coords = c.coordenadas;
  if (coords && String(coords.srid || '4326') === '4326') {
    const x = numero(coords.x);
    const y = numero(coords.y);
    if (puntoValido(x, y)) return { x, y };
  }
  if (!c.cod_calle) return null;
  if (c.tipo === 'calle_y_calle' && c.cod_calle_cruce) return puntoPorCodigo({ codCalle: c.cod_calle, codCruce: c.cod_calle_cruce });
  if (numero(c.altura)) return puntoPorCodigo({ codCalle: c.cod_calle, altura: numero(c.altura) });
  return null;
}

function resultadoDe(c, p) {
  return {
    estado: 'ok',
    ...p,
    calle: c.nombre_calle || null,
    altura: numero(c.altura),
    cruce: c.nombre_calle_cruce || null,
    direccion: String(c.direccion || '').replace(/, CABA$/, ''),
    tipo: c.tipo === 'calle_y_calle' ? 'cruce' : 'calle_altura',
  };
}

/** Un cruce de dos calles: los candidatos del normalizador y el punto. */
async function cruce(calle, calle2) {
  const enCaba = distintos((await normalizar(conCaba(`${prepararParaUsig(calle)} y ${prepararParaUsig(calle2)}`))).filter((c) => c.cod_partido === 'caba' && c.tipo === 'calle_y_calle'));
  if (!enCaba.length) return { estado: 'no_encontrada' };
  if (enCaba.length > opcionesMaximas()) return { estado: 'ambigua', opciones: enCaba.map((c) => c.direccion) };
  const c = elegir(enCaba, calle, (x) => x.nombre_calle);
  const p = await puntoDeCandidato(c);
  return p ? resultadoDe(c, p) : { estado: 'no_encontrada' };
}

/**
 * Una dirección escrita de cualquier forma (el texto de X, el importador,
 * una corrección a mano): calle y altura o un cruce. Si la Ciudad no la
 * reconoce, se pregunta sin ", CABA" para saber si es de otro partido.
 */
async function textoLibre(texto) {
  const consulta = conCaba(texto);
  if (!consulta) return { estado: 'no_encontrada' };
  const candidatos = await normalizar(consulta);
  const enCaba = distintos(candidatos.filter((c) => c && c.cod_partido === 'caba' && (c.tipo === 'calle_altura' || c.tipo === 'calle_y_calle')));
  if (enCaba.length > opcionesMaximas()) return { estado: 'ambigua', opciones: enCaba.map((c) => c.direccion) };
  if (enCaba.length) {
    for (const c of enCaba) {
      const p = await puntoDeCandidato(c);
      if (p) return resultadoDe(c, p);
    }
    return { estado: 'no_encontrada' };
  }
  // CABA no reconoció nada: ¿es de otro partido? (Antes de mirar afuera se
  // descartan los candidatos de la Ciudad sin punto: "Plaza Italia" existe
  // también en La Plata.)
  if (candidatos.some((c) => c && c.cod_partido === 'caba')) return { estado: 'no_encontrada' };
  const afuera = (await normalizar(prepararParaUsig(texto))).find((c) => c && c.cod_partido && c.cod_partido !== 'caba');
  return afuera ? { estado: 'fuera_caba', direccion: afuera.direccion || texto } : { estado: 'no_encontrada' };
}

/** La puerta (o la esquina) más cercana a un punto, para mostrar un lugar. */
async function inversa(lon, lat) {
  const { x, y } = lonLatAGkBa(lon, lat);
  const url = new URL(`${WS}/geocoder/2.2/reversegeocoding/`);
  url.searchParams.set('x', x.toFixed(3));
  url.searchParams.set('y', y.toFixed(3));
  const r = await pedir(url, { timeoutMs: TIMEOUT_WS_MS });
  if (!r || typeof r !== 'object') return null;
  return r.puerta || r.esquina || null;
}

module.exports = { calleAltura, cruce, textoLibre, inversa, puntoValido };
