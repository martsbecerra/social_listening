// ==========================================================================
// geo/resolver.js
// --------------------------------------------------------------------------
// De la ubicación de un reclamo a un punto, con su precisión, o a un motivo
// (fase H, openspec/changes/geo-pro). El modelo extrae la ubicación en
// campos (src/prompt.js); acá se resuelve, en este orden:
//
//   1. villa (o el texto nombra una): villas.js, precisión `area`.
//   2. calle y altura / cruce: USIG (usig.js), precisión `puntual` /
//      `cruce`. Antes, los patrones de dirección inválida sobre el texto
//      entero ("hasta las 18" no es una altura) y la altura mínima (una
//      menor a 10 vale solo pegada a su calle en el texto).
//   3. lugar: el índice de lugares (gazetteer.js), precisión `lugar`.
//   4. barrio: sin punto, una mención territorial con comuna y barrio.
//   5. el resto: sin ubicar, con su motivo (`lineal`, `fuera_de_caba`,
//      `ambigua`, `no_encontrada`, `sin_direccion`).
//
// Todo punto lleva comuna y barrio (territorios.js); uno que cae fuera de la
// Ciudad es `fuera_de_caba` y pierde el punto. El (0,0) nunca es un punto.
// Lo que viene de X y del importador (texto libre, sin campos) entra por
// desdeTextoLibre. Un error pasajero (USIG o un dataset caído) se propaga
// con err.transient: el reclamo queda pendiente, nunca "no encontrado".
//
// Las cachés: geocode_cache por consulta (calle y altura, cruce, texto) y
// lugar_cache por lugar; nunca una falla pasajera.
// ==========================================================================

const db = require('../db');
const territorios = require('../territorios');
const usig = require('./usig');
const villas = require('./villas');
const gazetteer = require('./gazetteer');
const { geoConfig } = require('./config');
const { normalizarLugar, limpiarTexto } = require('./texto');

const TIPOS = ['calle_altura', 'cruce', 'lugar', 'villa', 'barrio', 'lineal', 'ninguna'];

// ---------------------------------------------------------------- cachés

// Consultas a USIG con caché (las claves llevan "usig2:" para no reusar las
// del geocode.js anterior, que el 25/10/2026 cacheó "no encontrada" por una
// falla de USIG).
async function conCacheUsig(clave, consultar) {
  const enCache = db.getGeocodeCache(clave);
  if (enCache && enCache.status === 'ok' && usig.puntoValido(enCache.lng, enCache.lat)) {
    return { estado: 'ok', x: enCache.lng, y: enCache.lat, calle: enCache.calle, altura: enCache.altura, cruce: enCache.cruce, direccion: enCache.displayName };
  }
  if (enCache && (enCache.status === 'not_found' || enCache.status === 'ambigua')) {
    return { estado: enCache.status === 'ambigua' ? 'ambigua' : 'no_encontrada' };
  }
  if (enCache && enCache.status === 'fuera_caba') return { estado: 'fuera_caba', direccion: enCache.displayName };
  const r = await consultar(); // un error pasajero sale de acá sin cachear nada
  const status = r.estado === 'ok' ? 'ok' : r.estado === 'ambigua' ? 'ambigua' : r.estado === 'fuera_caba' ? 'fuera_caba' : 'not_found';
  db.setGeocodeCache({
    queryKey: clave,
    lat: r.estado === 'ok' ? r.y : null,
    lng: r.estado === 'ok' ? r.x : null,
    displayName: r.direccion || null,
    status,
    calle: r.calle || null,
    altura: r.altura ?? null,
    cruce: r.cruce || null,
  });
  return r;
}

const claveDe = (tipo, ...partes) => `usig2:${tipo}:${partes.map((p) => limpiarTexto(String(p ?? ''))).join('|')}`;

const calleAltura = (calle, altura) => conCacheUsig(claveDe('ca', calle, altura), () => usig.calleAltura(calle, altura));
const cruce = (calle, calle2) => conCacheUsig(claveDe('cr', calle, calle2), () => usig.cruce(calle, calle2));
const textoLibre = (texto) => conCacheUsig(claveDe('tx', texto), () => usig.textoLibre(texto));

// La dirección para mostrar un lugar sin la suya en el dataset: la inversa
// de USIG, cacheada para siempre por lugar.
async function direccionDeLugar(lugar) {
  if (lugar.direccion) return lugar.direccion;
  const clave = `lugar:${lugar.clave || normalizarLugar(lugar.nombre)}`;
  const enCache = db.getLugarCache(clave);
  if (enCache && enCache.direccion) return enCache.direccion;
  const direccion = await usig.inversa(lugar.x, lugar.y);
  if (direccion) db.setLugarCache({ clave, nombre: lugar.nombre, x: lugar.x, y: lugar.y, direccion, fuente: lugar.tipo });
  return direccion || null;
}

// Lo que se le pasa al índice para ubicar los lugares_extra con `direccion`.
async function ubicarDireccionExtra(direccion) {
  const clave = `extra:${normalizarLugar(direccion)}`;
  const enCache = db.getLugarCache(clave);
  if (enCache && usig.puntoValido(enCache.x, enCache.y)) return { x: enCache.x, y: enCache.y, direccionNormalizada: enCache.direccion };
  const r = await textoLibre(direccion);
  if (r.estado !== 'ok') return null;
  db.setLugarCache({ clave, nombre: direccion, x: r.x, y: r.y, direccion: r.direccion, fuente: 'lugares_extra' });
  return { x: r.x, y: r.y, direccionNormalizada: r.direccion };
}

// ---------------------------------------------------------------- reglas

function patronesInvalidos() {
  return (geoConfig().patrones_direccion_invalida || []).map((p) => new RegExp(p, 'gi'));
}

/**
 * ¿La altura sale de un número que no es una altura ("hasta las 18", "2
 * horas", "ley 1120")? Se busca en el texto entero: el patrón que la
 * contiene la delata.
 */
function alturaInvalida(altura, textos) {
  const n = String(altura);
  for (const texto of textos) {
    const t = limpiarTexto(texto);
    for (const re of patronesInvalidos()) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) if (new RegExp(`(?:^|\\D)${n}(?:\\D|$)`).test(m[0])) return true;
    }
  }
  return false;
}

// Una altura de un dígito vale solo si en el texto aparece pegada a su calle.
function alturaChicaPegada(calle, altura, textos) {
  const palabras = limpiarTexto(calle).split(' ').filter(Boolean);
  if (!palabras.length) return false;
  const ultima = palabras[palabras.length - 1];
  return textos.some((t) => new RegExp(`\\b${ultima}\\s+(?:al\\s+)?${altura}\\b`).test(limpiarTexto(t)));
}

function esLineal(nombre) {
  const n = normalizarLugar(nombre);
  const lista = (geoConfig().entidades_lineales || []).map(normalizarLugar);
  const tokens = (s) => [...new Set(s.split(' '))].sort().join(' ');
  return lista.includes(n) || lista.map(tokens).includes(tokens(n));
}

// ---------------------------------------------------------------- salidas

const sinUbicar = (motivo, extra = {}) => ({
  ubicacionTipo: extra.ubicacionTipo || null,
  precision: 'ninguna',
  x: null,
  y: null,
  direccionNormalizada: null,
  calle: null,
  altura: null,
  cruce: null,
  nombreLugar: extra.nombreLugar || null,
  comuna: null,
  barrio: null,
  motivoSinUbicar: motivo,
  geoStatus: motivo === 'fuera_de_caba' ? 'fuera_caba' : motivo === 'sin_direccion' ? 'sin_direccion' : 'no_encontrada',
});

async function conPunto(base) {
  const t = await territorios.ubicarPunto(base.x, base.y);
  if (!t) return sinUbicar('fuera_de_caba', { ubicacionTipo: base.ubicacionTipo, nombreLugar: base.nombreLugar });
  return { calle: null, altura: null, cruce: null, nombreLugar: null, ...base, comuna: t.comuna, barrio: t.barrio, motivoSinUbicar: null, geoStatus: 'ok' };
}

async function mencionDeBarrio(nombre) {
  const b = nombre ? await territorios.barrioPorNombre(nombre) : null;
  if (!b) return null;
  return { ...sinUbicar(null, { ubicacionTipo: 'barrio' }), comuna: b.comuna, barrio: b.barrio, motivoSinUbicar: null, geoStatus: 'sin_direccion' };
}

// ---------------------------------------------------------------- resolver

// El índice queda en memoria (gazetteer.obtenerIndice) y se rearma solo si
// venció su caché de 30 días o cambió la configuración.
const indiceDeLugares = () => gazetteer.obtenerIndice({ ubicarDireccion: ubicarDireccionExtra });

/**
 * La villa que nombra la ubicación. Si el modelo dijo calle y altura (o un
 * cruce), la villa gana solo si la altura o las calles son parte de su
 * nombre ("1 11 14" no es la calle 1 al 11): una dirección puntual al lado
 * de una villa es más precisa que el área.
 */
async function villaDe(u, tramo) {
  const V = await villas.obtenerVillas();
  const enNombre = u.nombre_lugar ? villas.buscarVilla(u.nombre_lugar, V) : { villa: null, tramos: [] };
  const enTramo = villas.buscarVilla(tramo, V);
  const villa = enNombre.villa || enTramo.villa;
  if (!villa) return null;
  if (u.tipo !== 'calle_altura' && u.tipo !== 'cruce') return villa;
  const adentro = (s) => {
    const n = normalizarLugar(s);
    return Boolean(n) && enTramo.tramos.some(([i, f]) => normalizarLugar(tramo.slice(i, f)).split(' ').includes(n.split(' ')[0]));
  };
  return adentro(u.altura) || adentro(u.calle) || adentro(u.calle2) ? villa : null;
}

async function resolverLugar(nombre, { textoCompleto, ubicacionTipo = 'lugar' }) {
  const indice = await indiceDeLugares();
  const barrios = await territorios.nombresDeBarrios();
  const r = gazetteer.buscar(nombre, indice, { textoCompleto, barrios });
  if (r.lugar) {
    const direccion = await direccionDeLugar(r.lugar);
    return conPunto({ ubicacionTipo: 'lugar', precision: 'lugar', x: r.lugar.x, y: r.lugar.y, direccionNormalizada: direccion || r.lugar.nombre, nombreLugar: r.lugar.nombre });
  }
  // No es un lugar del índice: ¿es un barrio ("locales de Once")?
  for (const v of gazetteer.versiones(nombre)) {
    const m = await mencionDeBarrio(v.texto);
    if (m) return m;
  }
  return sinUbicar('no_encontrada', { ubicacionTipo });
}

/**
 * @param {object} ubicacion la del modelo ({ tipo, calle, altura, calle2,
 *   nombre_lugar, barrio_o_comuna, texto_original, fuera_de_caba }) o la de
 *   desdeTextoLibre ({ tipo: 'texto', texto, tipoUbicacion })
 * @param {{ texto?: string }} [ctx] el texto entero del reclamo
 * @returns {Promise<object>} los campos de db.updateReclamoGeo
 */
async function resolver(ubicacion, { texto = '' } = {}) {
  const u = ubicacion || {};
  const tramo = String(u.texto_original || u.texto || '').trim();
  const textos = [tramo, texto].filter(Boolean);
  if (!u.tipo || u.tipo === 'ninguna') {
    if (u.fuera_de_caba) return sinUbicar('fuera_de_caba', { ubicacionTipo: 'ninguna' });
    if (!u.tipo && !tramo) return sinUbicar('sin_direccion');
  }

  // 1. villa: el modelo la marcó, o la ubicación nombra una.
  const villa = await villaDe(u, tramo);
  if (villa) {
    return conPunto({ ubicacionTipo: 'villa', precision: 'area', x: villa.x, y: villa.y, direccionNormalizada: villa.nombre, nombreLugar: villa.nombre });
  }
  if (u.tipo === 'villa') return resolverLugar(u.nombre_lugar || tramo, { textoCompleto: texto, ubicacionTipo: 'villa' });

  if (u.fuera_de_caba) return sinUbicar('fuera_de_caba', { ubicacionTipo: u.tipo || null });

  // 2. calle y altura, cruce.
  if (u.tipo === 'calle_altura') {
    const altura = Number(u.altura);
    const minima = Number(geoConfig().altura_minima_direccion) || 0;
    if (!u.calle) return sinUbicar('sin_direccion', { ubicacionTipo: 'calle_altura' });
    if (!Number.isInteger(altura) || altura <= 0 || alturaInvalida(altura, textos) || (altura < minima && !alturaChicaPegada(u.calle, altura, textos))) {
      return sinUbicar('lineal', { ubicacionTipo: 'lineal' });
    }
    return deUsig(await calleAltura(u.calle, altura), 'calle_altura');
  }
  if (u.tipo === 'cruce') {
    if (!u.calle || !u.calle2) return sinUbicar('lineal', { ubicacionTipo: 'lineal' });
    return deUsig(await cruce(u.calle, u.calle2), 'cruce');
  }

  // 3. lugar.
  if (u.tipo === 'lugar') return resolverLugar(u.nombre_lugar || tramo, { textoCompleto: texto });

  // 4. barrio.
  if (u.tipo === 'barrio') {
    const m = await mencionDeBarrio(u.barrio_o_comuna || u.nombre_lugar || tramo);
    return m || sinUbicar('no_encontrada', { ubicacionTipo: 'barrio' });
  }

  // Texto libre (X, el importador, una corrección): USIG, y si no, el índice.
  if (u.tipo === 'texto') return resolverTexto(tramo, { texto, tipoUbicacion: u.tipoUbicacion });

  // 5. lineal y ninguna.
  if (u.tipo === 'lineal') return sinUbicar('lineal', { ubicacionTipo: 'lineal' });
  return sinUbicar('sin_direccion', { ubicacionTipo: 'ninguna' });
}

async function deUsig(r, tipo) {
  if (r.estado === 'ok') {
    const esCruce = Boolean(r.cruce) || tipo === 'cruce';
    return conPunto({ ubicacionTipo: esCruce ? 'cruce' : 'calle_altura', precision: esCruce ? 'cruce' : 'puntual', x: r.x, y: r.y, direccionNormalizada: r.direccion, calle: r.calle || null, altura: r.altura ?? null, cruce: r.cruce || null });
  }
  if (r.estado === 'ambigua') return sinUbicar('ambigua', { ubicacionTipo: tipo });
  if (r.estado === 'fuera_caba') return sinUbicar('fuera_de_caba', { ubicacionTipo: tipo });
  return sinUbicar('no_encontrada', { ubicacionTipo: tipo });
}

// "Cabildo entre Juramento y Mendoza" → "Cabildo y Juramento" (como el
// preprocesamiento de direcciones.py).
function tramoACruce(texto) {
  const m = String(texto).match(/^\s*(?:en\s+)?(.+?),?\s+entre\s+(.+?)\s+y\s+.+$/i);
  return m ? `${m[1]} y ${m[2]}` : texto;
}

async function resolverTexto(tramo, { texto, tipoUbicacion }) {
  if (!tramo) return sinUbicar('sin_direccion');
  if (tipoUbicacion === 'lugar_nombrado') return resolverLugar(tramo, { textoCompleto: texto });
  const consulta = tipoUbicacion === 'tramo' ? tramoACruce(tramo) : tramo;
  const r = await textoLibre(consulta);
  if (r.estado === 'ok' || r.estado === 'ambigua' || r.estado === 'fuera_caba') return deUsig(r, r.tipo || 'calle_altura');
  // USIG no la reconoce: ¿un lugar o un barrio?
  const lugar = await resolverLugar(tramo, { textoCompleto: texto });
  if (lugar.geoStatus === 'ok' || lugar.ubicacionTipo === 'barrio') return lugar;
  return sinUbicar('no_encontrada');
}

/**
 * La ubicación de un reclamo que no la trae en campos (X, el importador,
 * los de antes de la fase H): su texto y, si se sabe, el tipo de antes
 * (calle_altura | cruce | tramo | lugar_nombrado).
 */
function desdeTextoLibre(direccionDetectada, tipoUbicacion = null) {
  const texto = String(direccionDetectada || '').trim();
  if (!texto) return null;
  return { tipo: 'texto', texto, tipoUbicacion: tipoUbicacion || null };
}

module.exports = { resolver, desdeTextoLibre, tramoACruce, alturaInvalida, TIPOS };
