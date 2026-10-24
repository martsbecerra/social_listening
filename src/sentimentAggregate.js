// ==========================================================================
// sentimentAggregate.js
// --------------------------------------------------------------------------
// Cálculo determinístico de métricas cuantitativas del análisis de
// Instagram: cantidades por tono, nivel de rendimiento y formatos. El
// porcentaje ponderado por tipo de cuenta del informe institucional se fue
// con la fase F (no hay tipo de cuenta en Instagram; el tono ponderado por
// likes vive en src/analysisMetrics.js). X tiene sus KPI en src/x/kpis.js.
// ==========================================================================

// Índices 0–3 usados en levelFromViews / levelFromInteractions.
const PERFORMANCE_LEVELS = ['Bajo', 'Medio', 'Alto', 'Muy Alto'];

/**
 * Cuántos comentarios clasificados hay de cada tono, sin pesos (las
 * columnas positivos / neutrales / negativos / ruido de la fila).
 * Los sin clasificar (null) no cuentan.
 * @param {Array<{ sentiment: string } | null>} rows
 * @returns {{ positivos: number, neutrales: number, negativos: number, ruido: number }}
 */
function countTones(rows) {
  const out = { positivos: 0, neutrales: 0, negativos: 0, ruido: 0 };
  for (const row of rows || []) {
    if (!row) continue;
    if (row.sentiment === 'positivo') out.positivos += 1;
    else if (row.sentiment === 'negativo') out.negativos += 1;
    else if (row.sentiment === 'ruido') out.ruido += 1;
    else out.neutrales += 1;
  }
  return out;
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
  countTones,
  computePostInteractions,
  computePerformanceLevel,
  formatCountWithDots,
  formatViewsShort,
};
