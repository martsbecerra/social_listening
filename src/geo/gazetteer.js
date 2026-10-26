// ==========================================================================
// geo/gazetteer.js
// --------------------------------------------------------------------------
// El índice de lugares con nombre (fase H). Port de
// app/pipeline/gazetteer.py del proyecto georreferenciacion, con una
// diferencia: allá se buscaba cada nombre del índice ADENTRO del texto del
// tweet; acá el modelo ya separó el `nombre_lugar` y se lo compara contra el
// índice, entero.
//
// - Fuentes (config/geo-config.json → gazetteer.fuentes): espacios verdes
//   (CSV con el polígono en WKT: centroide; también "<clasificación>
//   <nombre>", porque muchos vienen sin "Plaza"), estaciones de subte y de
//   tren ("Estación <nombre>"; de tren, solo las que caen en la Ciudad),
//   hospitales ("Hospital <nombre>"; EPSG:9498), clubes, espacios culturales
//   y escuelas (EPSG:9498; solo valen con un indicador adelante: sus nombres
//   son siglas). Lo que se guarda en data/geo/gazetteer.json es el índice
//   CRUDO; los filtros se aplican al cargar.
// - Filtros (SPEC.md, "Frases comunes"): menos de 2 palabras, genérico,
//   excluido, entidad lineal, lugar de afuera, menos de 8 letras. Una frase
//   común ("La Ventana") no se borra: solo vale con un indicador adelante.
// - Búsqueda: por nombre exacto normalizado, por conjunto de palabras
//   (tolera "9 DE JULIO AV.") y por el núcleo del nombre (sin artículos,
//   títulos ni iniciales: "Hospital Durand" encuentra "Hospital Dr. C.
//   Durand"); NUNCA por un pedazo. Se prueba el nombre entero y sin los
//   indicadores_a_quitar ("cancha de", "cruce peatonal de"…); gana la
//   versión más larga que encuentra algo. Un barrio o una comuna suelta no
//   es un lugar (sin indicador).
// - lugares_extra: lo que ningún dataset nombra así ("cancha de Huracán",
//   "Obelisco"). Apuntan a una entrada del índice (`club`, `lugar`) o a una
//   dirección que se ubica con USIG (`direccion`, resuelta en resolver.js).
// ==========================================================================

const { geoConfig } = require('./config');
const { conCache, bajar } = require('./datasets');
const { leerCsv, poligonosWkt, poligonosGeojson, centroide } = require('./geometria');
const { caba2019ALonLat, esPlana } = require('./proyecciones');
const { normalizarLugar } = require('./texto');
const territorios = require('../territorios');

const VERSION = 1;
const ARTICULOS = new Set(['la', 'el', 'los', 'las', 'de', 'del']);
// Lo que no hace al nombre de un lugar: artículos, conectores, títulos.
const NO_NUCLEO = new Set([...ARTICULOS, 'y', 'e', 'doctor', 'doctora', 'dra', 'ingeniero', 'ing', 'profesor', 'prof', 'presidente', 'pdte', 'teniente', 'general', 'coronel', 'n', 'nro', 'no']);

// ---------------------------------------------------------------- fuentes

function punto(x, y) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return null;
  return esPlana(x, y) ? caba2019ALonLat(x, y) : { lon: Number(x), lat: Number(y) };
}

function deGeojson(geojson, tipo, { campoNombre, prefijo = null, campoDireccion = null, separarDedicatoria = false }) {
  const filas = [];
  for (const f of (geojson && geojson.features) || []) {
    const p = f.properties || {};
    const nombre = typeof p[campoNombre] === 'string' ? p[campoNombre].trim() : '';
    if (!nombre || !f.geometry) continue;
    const coords = f.geometry.type === 'Point' ? { x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] } : centroide(poligonosGeojson(f.geometry));
    const pt = coords && punto(coords.x, coords.y);
    if (!pt) continue;
    const direccion = campoDireccion && typeof p[campoDireccion] === 'string' && p[campoDireccion].trim() ? p[campoDireccion].trim() : null;
    // "Once - 30 De Diciembre", "Tribunales - Teatro Colón": la estación se
    // nombra por la primera parte; la dedicatoria también vale.
    const partes = separarDedicatoria && nombre.includes(' - ') ? [nombre, ...nombre.split(' - ')] : [nombre];
    for (const parte of partes) {
      filas.push({ nombre: prefijo ? `${prefijo} ${parte.trim()}` : parte.trim(), tipo, x: pt.lon, y: pt.lat, direccion });
    }
  }
  return filas;
}

const CARGADORES = {
  espacio_verde: async (url) => {
    const filas = [];
    for (const r of leerCsv(await bajar(url, { formato: 'texto' }))) {
      const nombre = String(r.nombre || '').trim();
      const c = nombre ? centroide(poligonosWkt(r.geometry)) : null;
      if (!c) continue;
      const base = { tipo: 'espacio_verde', x: c.x, y: c.y, direccion: null, barrio: r.barrio || null };
      filas.push({ ...base, nombre });
      const clase = String(r.clasificac || '').trim();
      const clasif = normalizarLugar(clase);
      if (clasif && !normalizarLugar(nombre).startsWith(clasif.split(' ')[0])) {
        const legible = clase.charAt(0) + clase.slice(1).toLowerCase();
        filas.push({ ...base, nombre: `${legible} ${nombre}` });
      }
    }
    return filas;
  },
  estacion_subte: async (url) => deGeojson(await bajar(url), 'estacion_subte', { campoNombre: 'estacion', prefijo: 'Estación', separarDedicatoria: true }),
  estacion_tren: async (url) => {
    const filas = deGeojson(await bajar(url), 'estacion_tren', { campoNombre: 'nombre', prefijo: 'Estación' });
    const enLaCiudad = [];
    for (const f of filas) if (await territorios.ubicarPunto(f.x, f.y)) enLaCiudad.push(f);
    return enLaCiudad;
  },
  hospital: async (url) => deGeojson(await bajar(url), 'hospital', { campoNombre: 'nam', prefijo: 'Hospital', campoDireccion: 'dir' }),
  club: async (url) => deGeojson(await bajar(url), 'club', { campoNombre: 'nombre', campoDireccion: 'direccion' }),
  espacio_cultural: async (url) => deGeojson(await bajar(url), 'espacio_cultural', { campoNombre: 'ESTABLECIM', campoDireccion: 'DIRECCION' }),
  escuela: async (url) => deGeojson(await bajar(url), 'escuela', { campoNombre: 'nam', campoDireccion: 'dir' }),
};

/** Baja todas las fuentes de la configuración y arma el índice crudo. Si una falla, falla todo. */
async function construirCrudo(fuentes = geoConfig().gazetteer.fuentes) {
  const filas = [];
  for (const [tipo, url] of Object.entries(fuentes || {})) {
    if (!CARGADORES[tipo]) {
      console.warn(`[geo] gazetteer: fuente desconocida "${tipo}", se ignora`);
      continue;
    }
    filas.push(...(await CARGADORES[tipo](url)));
  }
  return filas;
}

async function obtenerCrudo({ ahora, forzar } = {}) {
  const c = geoConfig();
  return conCache('gazetteer', VERSION, () => construirCrudo(c.gazetteer.fuentes), { dias: c.gazetteer.refresco_dias || 30, ahora, forzar });
}

// ---------------------------------------------------------------- filtros

const tokensClave = (n) => [...new Set(n.split(' ').filter(Boolean))].sort().join(' ');
const nucleoClave = (n) => tokensClave(n.split(' ').filter((t) => !NO_NUCLEO.has(t) && t.length > 1).join(' '));

function listaNormalizada(lista) {
  const exactos = new Set();
  const tokens = new Set();
  for (const n of lista || []) {
    const v = normalizarLugar(n);
    if (!v) continue;
    exactos.add(v);
    tokens.add(tokensClave(v));
  }
  return { exactos, tokens, tiene: (n) => exactos.has(n) || tokens.has(tokensClave(n)) };
}

/**
 * Las reglas de exclusión sobre el índice crudo, al cargar. Devuelve el
 * índice para buscar y el resumen de lo descartado (para revisar).
 */
function filtrar(filas, config = geoConfig()) {
  const g = config.gazetteer;
  const genericos = new Set((g.nombres_genericos || []).map(normalizarLugar));
  const excluidos = new Set((g.nombres_excluidos || []).map(normalizarLugar));
  const lineales = listaNormalizada(config.entidades_lineales);
  const afuera = listaNormalizada(config.lugares_fuera_de_caba);
  const conIndicador = new Set(g.tipos_con_indicador || []);
  const descartados = {};
  const entradas = [];
  const vistos = new Set();
  for (const f of filas) {
    const n = normalizarLugar(f.nombre);
    let motivo = null;
    if (!n || n.split(' ').length < (g.minimo_tokens_nombre || 2)) motivo = 'una_sola_palabra';
    else if (genericos.has(n)) motivo = 'generico';
    else if (excluidos.has(n)) motivo = 'excluido';
    else if (lineales.tiene(n)) motivo = 'entidad_lineal';
    else if (afuera.tiene(n)) motivo = 'fuera_de_caba';
    else if (n.length < (g.longitud_minima_nombre || 8)) motivo = 'muy_corto';
    if (motivo) {
      descartados[motivo] = (descartados[motivo] || 0) + 1;
      continue;
    }
    if (vistos.has(n)) continue;
    vistos.add(n);
    const palabras = n.split(' ');
    const fraseComun = palabras.length <= 3 && ARTICULOS.has(palabras[0]);
    entradas.push({ ...f, clave: n, requiereIndicador: fraseComun || conIndicador.has(f.tipo) });
  }
  return { entradas, resumen: { crudo: filas.length, filtrado: entradas.length, descartados } };
}

// ---------------------------------------------------------------- búsqueda

function indexar(entradas) {
  const porClave = new Map();
  const porTokens = new Map();
  const porNucleo = new Map();
  for (const e of entradas) {
    if (!porClave.has(e.clave)) porClave.set(e.clave, e);
    const t = tokensClave(e.clave);
    if (!porTokens.has(t)) porTokens.set(t, e);
    const nu = nucleoClave(e.clave);
    // Un núcleo de una sola palabra es demasiado poco ("hospital durand" →
    // "durand" no: "hospital durand" sí, porque "hospital" queda).
    if (nu.includes(' ') && !porNucleo.has(nu)) porNucleo.set(nu, e);
  }
  return { porClave, porTokens, porNucleo };
}

/** Las versiones del nombre a probar, de la más larga a la más corta. */
function versiones(nombre, config = geoConfig()) {
  const n = normalizarLugar(nombre);
  if (!n) return [];
  const quitar = (config.indicadores_a_quitar || []).map(normalizarLugar).filter(Boolean).sort((a, b) => b.length - a.length);
  const salida = [{ texto: n, conIndicador: false }];
  let resto = n;
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const ind = quitar.find((q) => resto.startsWith(`${q} `));
    if (!ind) break;
    resto = resto.slice(ind.length + 1).trim();
    if (resto) salida.push({ texto: resto, conIndicador: true, indicador: ind });
  }
  // El nombre entero ya trae su indicador si arrancaba con uno.
  salida[0].conIndicador = salida.length > 1;
  return salida;
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ¿El nombre vino con un indicador adelante? Una frase común ("La Ventana")
 * o una escuela solo valen así: la persona lo escribió con su indicador
 * ("el bar La Ventana", "la escuela Raggio", sin contar el artículo del
 * principio) o el texto completo lo trae justo antes del nombre.
 */
function conIndicadorDelante(entrada, version, original, textoCompleto, config) {
  const propios = config.gazetteer.indicadores_por_tipo && config.gazetteer.indicadores_por_tipo[entrada.tipo];
  const indicadores = (propios || config.indicadores_de_lugar || []).map(normalizarLugar).filter(Boolean);
  const escrito = original.replace(/^(?:la|el|los|las)\s+/, '');
  if (indicadores.some((i) => escrito.startsWith(`${i} `))) return true;
  const texto = normalizarLugar(textoCompleto || '');
  return indicadores.some((i) => new RegExp(`\\b${escapar(i)}\\s+(?:la |el |los |las )?${escapar(version.texto)}\\b`).test(texto));
}

/**
 * Busca un lugar por el nombre que escribió la persona.
 * @param {string} nombreLugar
 * @param {{ entradas, porClave, porTokens, porNucleo, extras }} indice
 * @param {{ textoCompleto?: string, barrios?: string[] }} [opts] barrios:
 *   nombres de barrio normalizados (un barrio suelto no es un lugar).
 * @returns {{ lugar: object|null, motivo: string|null }} motivo:
 *   'barrio_sin_indicador' | 'ambiguo_sin_indicador' | 'no_encontrado'
 */
function buscar(nombreLugar, indice, { textoCompleto = '', barrios = [], config = geoConfig() } = {}) {
  const opciones = versiones(nombreLugar, config);
  if (!opciones.length) return { lugar: null, motivo: 'no_encontrado' };
  const exclusionBarrios = new Set([...(config.barrios_y_comunas_excluidos || []).map(normalizarLugar), ...barrios]);
  let motivo = 'no_encontrado';
  for (const v of opciones) {
    // Las variantes de un lugar extra van sin el artículo de adelante: "la
    // estación Villa Pueyrredón" es "estación villa pueyrredon".
    const extra = indice.extras && (indice.extras.get(v.texto) || indice.extras.get(v.texto.replace(/^(?:el|la|los|las) /, '')));
    if (extra) return { lugar: extra, motivo: null };
    if (exclusionBarrios.has(v.texto) && !v.conIndicador) {
      motivo = 'barrio_sin_indicador';
      continue;
    }
    const e = indice.porClave.get(v.texto) || indice.porTokens.get(tokensClave(v.texto)) || indice.porNucleo.get(nucleoClave(v.texto));
    if (!e) continue;
    if (e.requiereIndicador && !conIndicadorDelante(e, v, opciones[0].texto, textoCompleto, config)) {
      motivo = 'ambiguo_sin_indicador';
      continue;
    }
    return { lugar: e, motivo: null };
  }
  return { lugar: null, motivo };
}

/**
 * Las variantes de lugares_extra → su entrada. Las de `club` y `lugar`
 * salen del índice (punto y dirección del dataset); las de `direccion`, de
 * `ubicarDireccion` (resolver.js, con USIG), que puede no estar (tests).
 * Una que cae fuera de su barrio no se usa: se avisa por log. Si USIG falla
 * de paso (caído, 502), las de `direccion` que faltan quedan en `pasajeros`
 * y no frenan las demás: el resto del índice sigue sirviendo.
 */
async function armarExtras(entradasCrudas, { ubicarDireccion = null, config = geoConfig() } = {}) {
  const porNombre = new Map(entradasCrudas.map((e) => [e.nombre, e]));
  const extras = new Map();
  const sinUbicar = [];
  const pasajeros = [];
  for (const l of config.lugares_extra || []) {
    let base = null;
    if (l.club || l.lugar) {
      const e = porNombre.get(l.club || l.lugar);
      if (e) base = { x: e.x, y: e.y, direccion: e.direccion || null, fuente: e.tipo };
    } else if (l.direccion && ubicarDireccion) {
      // Con USIG ya caído en esta pasada, las que faltan ni se preguntan.
      if (pasajeros.length) {
        pasajeros.push(l.nombre);
        continue;
      }
      let r;
      try {
        r = await ubicarDireccion(l.direccion);
      } catch (err) {
        if (!err || !err.transient) throw err;
        pasajeros.push(l.nombre);
        continue;
      }
      if (r && Number.isFinite(r.x) && Number.isFinite(r.y)) base = { x: r.x, y: r.y, direccion: r.direccionNormalizada || l.direccion, fuente: 'lugares_extra' };
    }
    if (!base) {
      if (l.club || l.lugar || ubicarDireccion) sinUbicar.push(l.nombre);
      continue;
    }
    if (l.barrio) {
      const t = await territorios.ubicarPunto(base.x, base.y);
      if (!t || normalizarLugar(t.barrio) !== normalizarLugar(l.barrio)) {
        console.warn(`[geo] lugares_extra: "${l.nombre}" cae en ${t ? t.barrio : 'ningún barrio'}, no en ${l.barrio}: no se usa`);
        sinUbicar.push(l.nombre);
        continue;
      }
    }
    const entrada = { nombre: l.nombre, tipo: 'lugar_extra', clave: normalizarLugar(l.nombre), requiereIndicador: false, ...base };
    for (const v of [l.nombre, ...(l.variantes || [])]) {
      const k = normalizarLugar(v);
      if (k && !extras.has(k)) extras.set(k, entrada);
    }
  }
  if (sinUbicar.length) console.warn(`[geo] lugares_extra sin ubicar: ${sinUbicar.join(', ')}`);
  if (pasajeros.length) console.warn(`[geo] lugares_extra: USIG no contestó; ${pasajeros.length} se vuelven a pedir en ${REINTENTO_EXTRAS_MIN} min`);
  return { extras, sinUbicar, pasajeros };
}

// Un índice con lugares extra que faltan por una falla de USIG se rearma
// recién pasado este tiempo: con USIG caído, cada búsqueda esperaría sus
// reintentos.
const REINTENTO_EXTRAS_MIN = 10;

let memo = null;

/**
 * El índice listo para buscar: el crudo (data/geo/gazetteer.json, 30 días),
 * filtrado con la configuración, más los lugares extra.
 */
async function obtenerIndice({ ahora, forzar, ubicarDireccion = null } = {}) {
  const crudo = await obtenerCrudo({ ahora, forzar });
  const t = ahora ? new Date(ahora).getTime() : Date.now();
  if (memo && memo.fetchedAt === crudo.fetchedAt && memo.config === geoConfig() && memo.conDirecciones === Boolean(ubicarDireccion) && !(memo.reintentarEn && t >= memo.reintentarEn)) return memo;
  const { entradas, resumen } = filtrar(crudo.filas);
  const { extras, sinUbicar, pasajeros } = await armarExtras(crudo.filas, { ubicarDireccion });
  memo = {
    fetchedAt: crudo.fetchedAt,
    config: geoConfig(),
    conDirecciones: Boolean(ubicarDireccion),
    reintentarEn: pasajeros.length ? t + REINTENTO_EXTRAS_MIN * 60000 : null,
    entradas,
    resumen,
    extras,
    extrasSinUbicar: sinUbicar,
    ...indexar(entradas),
  };
  return memo;
}

module.exports = { construirCrudo, filtrar, indexar, versiones, buscar, armarExtras, obtenerIndice };
