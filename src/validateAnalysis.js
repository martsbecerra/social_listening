// ==========================================================================
// validateAnalysis.js
// --------------------------------------------------------------------------
// Normaliza el JSON que devuelve el modelo (structured output) en el
// análisis de publicación de Instagram. La API ya valida el schema, pero acá
// corregimos enums raros, filas de reclamos incompletas, índices que no
// existen, temas sin nombre y, en la síntesis, números de comentarios o de
// temas que no existen y sugerencias de figuras para quien no corresponde.
//
// Un comentario que el modelo NO devolvió queda sin clasificar (null), no
// como neutral: "analizados" es la cantidad de clasificados de verdad
// (src/analyzeComments.js), y un relleno contaba de más. Desde la fase F no
// hay tipo de cuenta (openspec/changes/analisis-pro).
// ==========================================================================

const { SENTIMENTS, POSTURAS, TIPOS_UBICACION, TIPOS_UBICACION_H, CONFIANZAS } = require('./analysisSchema');
const { applyClassificationHeuristics } = require('./classificationHeuristics');
const { normalizeTematica } = require('./tematica');
const { normalizeCategoria } = require('./categoriaReclamo');
const { sanitizarSugerencia } = require('./figuras');

const SENTIMENT_SET = new Set(SENTIMENTS);
const POSTURA_SET = new Set(POSTURAS);
const MAX_NOMBRE_TEMA = 60;
const MAX_PEDIDOS = 8;

/** Si el valor no está en el enum acordado, usamos fallback (no rompe el agregado). */
function pickEnum(value, allowed, fallback) {
  if (typeof value === 'string' && allowed.has(value)) return value;
  return fallback;
}

const textoCorto = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 160) : '');

/**
 * La ubicación de un reclamo (fase H, openspec/changes/geo-pro): el tipo
 * tiene que ser uno de la lista y la altura un entero; los campos que el
 * tipo no usa quedan vacíos; al que le falta lo suyo se le baja el tipo
 * (una calle sin altura es una calle sola, `lineal`), y lo que no valida
 * queda `ninguna`. barrio_o_comuna vale en cualquier tipo.
 */
function sanitizeUbicacion(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const altura = Number.isInteger(u.altura) && u.altura > 0 ? u.altura : typeof u.altura === 'string' && /^\d{1,5}$/.test(u.altura.trim()) ? Number(u.altura.trim()) : 0;
  const out = {
    tipo: TIPOS_UBICACION_H.includes(u.tipo) ? u.tipo : 'ninguna',
    calle: textoCorto(u.calle),
    altura,
    calle2: textoCorto(u.calle2),
    nombre_lugar: textoCorto(u.nombre_lugar),
    barrio_o_comuna: textoCorto(u.barrio_o_comuna),
    texto_original: textoCorto(u.texto_original),
    confianza: CONFIANZAS.includes(u.confianza) ? u.confianza : 'baja',
    fuera_de_caba: u.fuera_de_caba === true,
  };
  if (out.tipo === 'calle_altura' && (!out.calle || !out.altura)) out.tipo = out.calle ? 'lineal' : 'ninguna';
  if (out.tipo === 'cruce' && (!out.calle || !out.calle2)) out.tipo = out.calle ? 'lineal' : 'ninguna';
  if ((out.tipo === 'lugar' || out.tipo === 'villa') && !out.nombre_lugar) out.tipo = 'ninguna';
  if (out.tipo === 'barrio' && !out.barrio_o_comuna) out.tipo = 'ninguna';
  if (out.tipo === 'lineal' && !out.calle) out.tipo = 'ninguna';
  if (out.tipo !== 'calle_altura') out.altura = 0;
  if (!['calle_altura', 'cruce', 'lineal'].includes(out.tipo)) out.calle = '';
  if (out.tipo !== 'cruce') out.calle2 = '';
  if (out.tipo !== 'lugar' && out.tipo !== 'villa') out.nombre_lugar = '';
  return out;
}

// Lo que se muestra y se compara al re-analizar (direccion_detectada): el
// tramo del comentario o, si no vino, lo que nombró.
function textoDeUbicacion(u) {
  return u.texto_original || u.nombre_lugar || [u.calle, u.altura || '', u.calle2 ? `y ${u.calle2}` : ''].join(' ').replace(/\s+/g, ' ').trim() || u.barrio_o_comuna || '';
}

/**
 * Los reclamos de un comentario: cada uno con su ubicación, temática y
 * categoría. Uno que no nombra ningún lugar (ni afuera de la Ciudad) no es
 * un reclamo (decisión del dueño, fase H): se descarta.
 */
function sanitizeReclamosGeo(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    // La forma de antes de la fase H (direccionDetectada y tipoUbicacion, la
    // de la respuesta real grabada en los fixtures de la F): va como texto
    // libre, que el resolver también ubica.
    if (!r.ubicacion && typeof r.direccionDetectada === 'string' && r.direccionDetectada.trim()) {
      const texto = textoCorto(r.direccionDetectada);
      out.push({
        ubicacion: { tipo: 'texto', texto, tipoUbicacion: TIPOS_UBICACION.includes(r.tipoUbicacion) ? r.tipoUbicacion : null },
        direccionDetectada: texto,
        tematica: normalizeTematica(r.tematica),
        categoria: normalizeCategoria(r.categoria),
      });
      continue;
    }
    const ubicacion = sanitizeUbicacion(r.ubicacion);
    const direccionDetectada = textoDeUbicacion(ubicacion);
    if (!direccionDetectada && !ubicacion.fuera_de_caba) continue;
    out.push({
      ubicacion,
      direccionDetectada,
      tematica: normalizeTematica(r.tematica),
      categoria: normalizeCategoria(r.categoria),
    });
  }
  return out;
}

/**
 * Las clasificaciones de UNA tanda, en un array paralelo a la tanda: el
 * ítem i es el comentario i+1 de la lista que se le mandó. Lo que el modelo
 * no devolvió (o devolvió con un índice que no existe) queda null. `tema` es
 * el número que usó la tanda (0 = ninguno); analyzeComments lo pasa al id
 * del análisis.
 * @param {unknown} rawList parsed.classifications
 * @param {number} batchLength
 * @returns {Array<{ sentiment: string, postura: string, tema: number, sobrePosteo: boolean, pedido: boolean, reclamosGeo: Array } | null>}
 */
function normalizeBatchClassifications(rawList, batchLength) {
  const out = new Array(batchLength).fill(null);
  if (!Array.isArray(rawList)) return out;
  for (const row of rawList) {
    if (!row || !Number.isInteger(row.index) || row.index < 1 || row.index > batchLength) continue;
    if (out[row.index - 1]) continue; // el primero gana
    out[row.index - 1] = {
      sentiment: pickEnum(row.sentiment, SENTIMENT_SET, 'neutral'),
      postura: pickEnum(row.postura, POSTURA_SET, 'neutra'),
      tema: Number.isInteger(row.tema) && row.tema > 0 ? row.tema : 0,
      sobrePosteo: typeof row.sobre_posteo === 'boolean' ? row.sobre_posteo : true,
      pedido: row.pedido === true,
      reclamosGeo: sanitizeReclamosGeo(row.reclamosGeo),
    };
  }
  return out;
}

/** Los temas que definió o sumó una tanda: número y nombre válidos, sin repetir número. */
function normalizeTemasDeTanda(raw) {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || !Number.isInteger(t.numero) || t.numero < 1 || vistos.has(t.numero)) continue;
    const nombre = typeof t.nombre === 'string' ? t.nombre.replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE_TEMA) : '';
    if (!nombre) continue;
    vistos.add(t.numero);
    out.push({ numero: t.numero, nombre });
  }
  return out;
}

/**
 * Las heurísticas de classificationHeuristics.js, solo sobre lo
 * clasificado: lo sin clasificar sigue null.
 */
function applyHeuristicsToClassified(sample, classifications) {
  return classifications.map((row, i) => (row ? applyClassificationHeuristics([sample[i]], [row])[0] : null));
}

/**
 * La síntesis: la lectura, el hecho dominante (o null), los pedidos con
 * números de comentarios válidos, qué mirar y las sugerencias de figuras
 * solo para los verificados sin ficha.
 * @param {unknown} parsed
 * @param {{ temasValidos: Set<number>, comentariosValidos: Set<number>, verificadosSinFicha: Set<string> }} validos
 *   comentariosValidos: los que un pedido puede agrupar (analyzeComments
 *   pasa los clasificados marcados PEDIDO, sin el ruido).
 */
function normalizeSynthesis(parsed, { temasValidos, comentariosValidos, verificadosSinFicha }) {
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('Structured output de la síntesis vacío o inválido.');
    e.userMessage = 'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
    throw e;
  }
  const p = /** @type {Record<string, any>} */ (parsed);
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const h = p.hecho_dominante && typeof p.hecho_dominante === 'object' ? p.hecho_dominante : null;
  const hecho =
    h && h.hay === true && Number.isInteger(h.tema) && temasValidos.has(h.tema) && text(h.titulo)
      ? { temaId: h.tema, titulo: text(h.titulo), descripcion: text(h.descripcion) || '' }
      : null;
  const usados = new Set();
  const pedidos = (Array.isArray(p.pedidos) ? p.pedidos : [])
    .map((x) => {
      // Cada comentario en un solo grupo (y una sola vez en el suyo).
      const ids = [];
      for (const n of Array.isArray(x && x.ids) ? x.ids : []) {
        if (!Number.isInteger(n) || !comentariosValidos.has(n) || usados.has(n)) continue;
        usados.add(n);
        ids.push(n);
      }
      return { texto: text(x && x.texto), ids };
    })
    .filter((x) => x.texto && x.ids.length)
    .slice(0, MAX_PEDIDOS);
  const figurasSugeridas = [];
  for (const raw of Array.isArray(p.figuras_sugeridas) ? p.figuras_sugeridas : []) {
    const s = sanitizarSugerencia({ ...raw, alineacion: raw && raw.alineacion === 'ninguna' ? null : raw && raw.alineacion });
    if (s && verificadosSinFicha.has(s.username) && !figurasSugeridas.some((f) => f.username === s.username)) figurasSugeridas.push(s);
  }
  return {
    lectura: text(p.lectura) || 'N/D',
    hecho,
    pedidos,
    queMirar: text(p.que_mirar),
    figurasSugeridas,
  };
}

module.exports = {
  sanitizeUbicacion,
  normalizeBatchClassifications,
  normalizeTemasDeTanda,
  applyHeuristicsToClassified,
  normalizeSynthesis,
};
