// ==========================================================================
// sentimentAggregate.js
// --------------------------------------------------------------------------
// Cálculo determinístico de métricas cuantitativas del reporte.
// Claude solo clasifica comentarios; acá aplicamos pesos, porcentajes y KPI
// según la metodología (antes estaba “a ojo” en el LLM).
// ==========================================================================

// Pesos por tipo de cuenta (metodología §3). "ruido" no tiene peso: se excluye.
const ACCOUNT_WEIGHT = {
  oficial: 2.5,
  periodista: 2.0,
  opositor: 1.8,
  vecino: 1.0,
};

// Índices 0–3 usados en levelFromViews / levelFromInteractions.
const PERFORMANCE_LEVELS = ['Bajo', 'Medio', 'Alto', 'Muy Alto'];

/**
 * Suma pesos de comentarios positivos vs negativos y devuelve % enteros que suman 100.
 * Neutral y ruido no entran al cálculo.
 *
 * @param {Array<{ sentiment: string, accountType: string }>} rows
 * @returns {{ positivoPct: number, negativoPct: number, weightedPos: number, weightedNeg: number }}
 */
function computeWeightedSentimentPercentages(rows) {
  let weightedPos = 0;
  let weightedNeg = 0;

  for (const row of rows) {
    const { sentiment, accountType } = row;
    if (sentiment === 'neutral' || sentiment === 'ruido' || accountType === 'ruido') {
      continue;
    }
    if (sentiment !== 'positivo' && sentiment !== 'negativo') continue;

    const weight = ACCOUNT_WEIGHT[accountType] ?? ACCOUNT_WEIGHT.vecino;
    if (sentiment === 'positivo') weightedPos += weight;
    else weightedNeg += weight;
  }

  const total = weightedPos + weightedNeg;
  // Sin comentarios clasificables: evitamos división por cero; 50/50 es convención.
  if (total === 0) {
    return { positivoPct: 50, negativoPct: 50, weightedPos: 0, weightedNeg: 0 };
  }

  // Redondeamos positivo y negativo = 100 - positivo para cumplir la regla del reporte.
  let positivoPct = Math.round((weightedPos / total) * 100);
  if (positivoPct < 0) positivoPct = 0;
  if (positivoPct > 100) positivoPct = 100;
  const negativoPct = 100 - positivoPct;

  return { positivoPct, negativoPct, weightedPos, weightedNeg };
}

/** Umbrales de visualizaciones/reproducciones (metodología §5). Devuelve índice 0–3 o null si N/D. */
function levelFromViews(views) {
  if (views === null || views === undefined || Number.isNaN(Number(views))) return null;
  const v = Number(views);
  if (v < 25000) return 0;
  if (v < 60000) return 1;
  if (v < 100000) return 2;
  return 3;
}

/** Umbrales de interacciones totales del post (metodología §5). */
function levelFromInteractions(interactions) {
  if (interactions === null || interactions === undefined || Number.isNaN(Number(interactions))) {
    return null;
  }
  const i = Number(interactions);
  if (i < 600) return 0;
  if (i < 1500) return 1;
  if (i < 3000) return 2;
  return 3;
}

/**
 * Interacciones del posteo = likes + cantidad de comentarios (no sumamos likes por comentario).
 */
function computePostInteractions(post) {
  const likes = post.likesCount;
  const comments = post.commentsCount;
  if (likes == null && comments == null) return null;
  return Number(likes || 0) + Number(comments || 0);
}

/**
 * Nivel final = el más alto entre visualizaciones e interacciones (conservador).
 * Si falta una métrica, usamos solo la otra.
 */
function computePerformanceLevel(post) {
  const views = post.videoPlayCount;
  const interactions = computePostInteractions(post);
  const viewLevel = levelFromViews(views);
  const interactionLevel = levelFromInteractions(interactions);

  if (viewLevel === null && interactionLevel === null) return 'N/D';

  const level = Math.max(viewLevel ?? 0, interactionLevel ?? 0);
  return PERFORMANCE_LEVELS[level] ?? 'N/D';
}

/** Formato del reporte WhatsApp: miles con punto (locale es-AR). */
function formatCountWithDots(n) {
  if (n === null || n === undefined) return 'N/D';
  return Number(n).toLocaleString('es-AR');
}

/** Alcance resumido tipo 450K / 1,2M para la línea 👁️ del reporte. */
function formatViewsShort(n) {
  if (n === null || n === undefined) return 'N/D';
  const v = Number(n);
  if (!Number.isFinite(v)) return 'N/D';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    const s = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
    return `${String(s).replace('.', ',')}M`;
  }
  if (v >= 1000) {
    return `${Math.round(v / 1000)}K`;
  }
  return formatCountWithDots(v);
}

module.exports = {
  ACCOUNT_WEIGHT,
  computeWeightedSentimentPercentages,
  computePostInteractions,
  computePerformanceLevel,
  formatCountWithDots,
  formatViewsShort,
};
