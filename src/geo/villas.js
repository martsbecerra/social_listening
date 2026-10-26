// ==========================================================================
// geo/villas.js
// --------------------------------------------------------------------------
// Villas y asentamientos como lugares de precisión de ÁREA (fase H). Port de
// app/pipeline/villas.py del proyecto georreferenciacion:
//
// - Fuente: el dataset "Barrios populares" del GCBA, un polígono por
//   manzana. Declara WGS84 pero viene en Gauss-Krüger Buenos Aires: si las
//   coordenadas no pueden ser grados, se convierten (proyecciones.js).
// - Se filtran los tipos incluidos, se disuelve por NOMBRE (centroide de
//   área de todas sus manzanas, en metros) y se agregan barrio y comuna por
//   punto en polígono. Lo que se guarda en data/geo/villas.json es eso.
// - Los grupos y variantes de config/geo-config.json ("la 31", "1 11 14",
//   "once catorce", "ciudad oculta") se aplican al cargar: cambiar una lista
//   vale sin volver a bajar el dataset. Lo que no está en ningún grupo entra
//   con su nombre oficial y su nombre de mapa.
// - La búsqueda es una regex tolerante (mayúsculas, acentos, separadores
//   "-", ".", "/") por variante, la más larga primero; devuelve también los
//   tramos del texto que matchearon, para que no lleguen a USIG como una
//   altura ("1 11 14").
// ==========================================================================

const { geoConfig } = require('./config');
const { conCache, bajar } = require('./datasets');
const { poligonosGeojson, centroide } = require('./geometria');
const { gkBaALonLat, esPlana } = require('./proyecciones');
const { normalizarLugar } = require('./texto');
const territorios = require('../territorios');

const VERSION = 1;
const SEPARADORES = '[\\s.\\-/·,]+';
const LIMITE_IZQ = '(?<![0-9a-záéíóúüñ])';
const LIMITE_DER = '(?![0-9a-záéíóúüñ])';
const CLASES_ACENTO = { a: '[aá]', e: '[eé]', i: '[ií]', o: '[oó]', u: '[uúü]', n: '[nñ]', ñ: '[ñn]' };

/** Del GeoJSON a una fila por villa (sin los grupos de la configuración). */
async function construirCrudo(geojson, { tiposIncluidos }) {
  const tipos = new Set(tiposIncluidos || []);
  const porNombre = new Map();
  for (const f of (geojson && geojson.features) || []) {
    const p = f.properties || {};
    const nombre = String(p.NOMBRE || '').trim();
    if (!nombre || (tipos.size && !tipos.has(String(p.TIPO_ASENT)))) continue;
    if (!porNombre.has(nombre)) porNombre.set(nombre, { poligonos: [], nombreMapa: null, tipo: String(p.TIPO_ASENT), alias: null });
    const v = porNombre.get(nombre);
    v.poligonos.push(...poligonosGeojson(f.geometry));
    if (!v.nombreMapa && typeof p.NOM_MAP === 'string' && p.NOM_MAP.trim()) v.nombreMapa = p.NOM_MAP.trim();
    if (!v.alias && typeof p.ALIAS === 'string' && p.ALIAS.trim()) v.alias = p.ALIAS.trim();
  }
  const filas = [];
  for (const [nombre, v] of porNombre) {
    const c = centroide(v.poligonos);
    if (!c) continue;
    const { lon, lat } = esPlana(c.x, c.y) ? gkBaALonLat(c.x, c.y) : { lon: c.x, lat: c.y };
    const t = await territorios.ubicarPunto(lon, lat);
    filas.push({ nombreDataset: nombre, nombreMapa: v.nombreMapa, tipo: v.tipo, alias: v.alias, x: lon, y: lat, barrio: t ? t.barrio : null, comuna: t ? t.comuna : null });
  }
  return filas;
}

/** Las filas guardadas en data/geo/villas.json (las arma si no están o vencieron). */
async function obtenerCrudo({ ahora, forzar } = {}) {
  const c = geoConfig();
  return conCache(
    'villas',
    VERSION,
    async () => construirCrudo(await bajar(c.villas.fuente), { tiposIncluidos: c.villas.tipos_incluidos }),
    { dias: c.gazetteer.refresco_dias || 30, ahora, forzar }
  );
}

// "1-11-14" y "21/24" pasan a espacios ANTES de normalizar (si no, "11114").
function normalizarVariante(texto) {
  return normalizarLugar(String(texto || '').replace(new RegExp(SEPARADORES, 'g'), ' '));
}

function regexVariante(variante) {
  const tokens = variante.split(' ').map((t) => [...t].map((ch) => CLASES_ACENTO[ch] || ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''));
  return new RegExp(LIMITE_IZQ + tokens.join(SEPARADORES) + LIMITE_DER, 'gi');
}

/**
 * El dataset más los grupos de la configuración: una entrada por villa (o
 * grupo), con su punto, barrio, comuna y variantes.
 */
function armarVillas(filas, config = geoConfig()) {
  const porNombre = new Map(filas.map((r) => [r.nombreDataset, r]));
  const usados = new Set();
  const excluidos = new Set(config.villas.dataset_excluidos || []);
  const entradas = [];
  for (const g of config.villas.grupos || []) {
    const del = (g.dataset || []).map((n) => porNombre.get(n)).filter(Boolean);
    if (!del.length) continue;
    del.forEach((r) => usados.add(r.nombreDataset));
    const variantes = new Set((g.variantes || []).map(normalizarVariante));
    for (const r of del) {
      variantes.add(normalizarVariante(r.nombreDataset));
      if (r.nombreMapa) variantes.add(normalizarVariante(r.nombreMapa));
    }
    entradas.push({
      nombre: g.nombre,
      x: del.reduce((s, r) => s + r.x, 0) / del.length,
      y: del.reduce((s, r) => s + r.y, 0) / del.length,
      barrio: del[0].barrio,
      comuna: del[0].comuna,
      variantes: [...variantes].filter(Boolean),
    });
  }
  for (const [nombre, r] of porNombre) {
    if (usados.has(nombre) || excluidos.has(nombre)) continue;
    const variantes = new Set([normalizarVariante(nombre)]);
    if (r.nombreMapa) variantes.add(normalizarVariante(r.nombreMapa));
    entradas.push({ nombre, x: r.x, y: r.y, barrio: r.barrio, comuna: r.comuna, variantes: [...variantes].filter(Boolean) });
  }
  const patrones = [];
  for (const e of entradas) for (const v of e.variantes) patrones.push({ re: regexVariante(v), largo: v.length, entrada: e });
  patrones.sort((a, b) => b.largo - a.largo);
  return { entradas, patrones };
}

/**
 * La villa que nombra el texto (la de la variante más larga) y todos los
 * tramos [inicio, fin) que matchearon alguna, para enmascararlos.
 */
function buscarVilla(texto, { patrones }) {
  if (typeof texto !== 'string' || !texto) return { villa: null, tramos: [] };
  const tramos = [];
  let villa = null;
  for (const { re, entrada } of patrones) {
    re.lastIndex = 0;
    for (const m of texto.matchAll(re)) {
      const ini = m.index;
      const fin = ini + m[0].length;
      if (tramos.some(([i, f]) => ini < f && i < fin)) continue;
      tramos.push([ini, fin]);
      if (!villa) villa = entrada;
    }
  }
  return { villa, tramos: tramos.sort((a, b) => a[0] - b[0]) };
}

/** El texto con los tramos de villa tapados (mismas posiciones para el resto). */
function enmascarar(texto, tramos) {
  if (!tramos.length || typeof texto !== 'string') return texto;
  const letras = [...texto];
  for (const [i, f] of tramos) for (let k = i; k < f; k++) letras[k] = ' ';
  return letras.join('').replace(/ {2,}/g, ' ').trim();
}

let memo = null;

/** Las villas listas para buscar (caché en disco + grupos de la configuración). */
async function obtenerVillas(opts = {}) {
  const crudo = await obtenerCrudo(opts);
  if (!memo || memo.fetchedAt !== crudo.fetchedAt || memo.config !== geoConfig()) {
    memo = { fetchedAt: crudo.fetchedAt, config: geoConfig(), ...armarVillas(crudo.filas) };
  }
  return memo;
}

module.exports = { construirCrudo, armarVillas, buscarVilla, enmascarar, obtenerVillas };
