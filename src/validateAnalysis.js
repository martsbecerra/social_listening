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

const { SENTIMENTS, POSTURAS, TIPOS_UBICACION } = require('./analysisSchema');
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

/** Descarta entradas sin dirección detectada; temática libre normalizada. */
function sanitizeReclamosGeo(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const direccionDetectada =
      typeof r.direccionDetectada === 'string' ? r.direccionDetectada.trim() : '';
    if (!direccionDetectada) continue;
    out.push({
      direccionDetectada,
      direccionNormalizada:
        typeof r.direccionNormalizada === 'string' && r.direccionNormalizada.trim()
          ? r.direccionNormalizada.trim()
          : 'N/D',
      tematica: normalizeTematica(r.tematica),
      categoria: normalizeCategoria(r.categoria),
      // De acá sale la `precision` con la que se guarda el reclamo
      // (reclamosFromAnalysis.js). Si el modelo manda un valor fuera del enum
      // se descarta y el reclamo queda como dirección puntual, que es el caso
      // mayoritario y el comportamiento anterior.
      tipoUbicacion: TIPOS_UBICACION.includes(r.tipoUbicacion) ? r.tipoUbicacion : null,
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
  normalizeBatchClassifications,
  normalizeTemasDeTanda,
  applyHeuristicsToClassified,
  normalizeSynthesis,
};
