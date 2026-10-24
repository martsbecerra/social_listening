// ==========================================================================
// reportBuilder.js
// --------------------------------------------------------------------------
// Arma el texto final para WhatsApp y el CSV de reclamos.
// Combina métricas calculadas en sentimentAggregate.js con los textos
// cualitativos que devolvió Claude (structured output).
// ==========================================================================

const {
  computeWeightedSentimentPercentages,
  computePerformanceLevel,
  formatCountWithDots,
  formatViewsShort,
} = require('./sentimentAggregate');
const { PARTIAL_SAMPLE_DISCLOSURE } = require('./commentSample');
const { assembleReport } = require('./temasConversacion');

// Encabezado fijo exigido por la metodología (descarga en el front).
const CSV_HEADER =
  '"Nombre de usuario","Direccion detectada","Direccion normalizada","Tematica detectada"';

/** Escapado CSV estándar: comillas dobles duplicadas dentro del campo. */
function escapeCsvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * CSV a partir de reclamosGeo por comentario (no lo genera Claude como texto suelto).
 *
 * @param {Array} sample Comentarios en el mismo orden que classifications[i]
 * @param {Array<{ reclamosGeo?: Array }>} classifications
 */
function buildReclamosCsv(sample, classifications) {
  const rows = [CSV_HEADER];

  for (let i = 0; i < classifications.length; i++) {
    const item = classifications[i];
    // Sin clasificar (null): no tiene reclamos.
    const reclamos = item && item.reclamosGeo;
    if (!reclamos || reclamos.length === 0) continue;

    const comment = sample[i];
    if (!comment) continue;
    const username = comment.username || 'desconocido';

    // Un comentario puede aportar varias filas si menciona varias ubicaciones.
    for (const r of reclamos) {
      if (!r || !r.direccionDetectada) continue;
      rows.push(
        [
          escapeCsvField(username),
          escapeCsvField(r.direccionDetectada),
          escapeCsvField(r.direccionNormalizada || 'N/D'),
          escapeCsvField(r.tematica || 'N/D'),
        ].join(',')
      );
    }
  }

  return `${rows.join('\n')}\n`;
}

/** El template pide 2 referencias; rellenamos con N/D si Claude mandó menos. */
function formatReferenceLines(refs) {
  const lines = Array.isArray(refs) ? refs.filter(Boolean).slice(0, 2) : [];
  while (lines.length < 2) lines.push('N/D');
  return lines;
}

/**
 * La aclaración de muestra parcial con los números reales: "Análisis
 * realizado sobre 287 de 1.480 comentarios." Si además la muestra la
 * recortó la app (no Instagram), dice cómo se priorizó. Sin los números,
 * el texto de siempre.
 */
function partialDisclosure({ analizados, totalPost, priorizada }) {
  if (!Number.isFinite(analizados) || !Number.isFinite(totalPost)) return PARTIAL_SAMPLE_DISCLOSURE;
  const como = priorizada ? ' (priorizadas cuentas verificadas y comentarios con más likes)' : '';
  return `Análisis realizado sobre ${formatCountWithDots(analizados)} de ${formatCountWithDots(totalPost)} comentarios${como}.`;
}

/**
 * @param {object} params
 *   analizados / totalPost / priorizada (opcionales): los números reales de
 *   la aclaración de muestra parcial (ver partialDisclosure).
 * @returns {{ report: string, csv: string, meta: object }}
 */
function buildWhatsAppReport({
  url,
  post,
  sample,
  isPartial,
  sampleSize,
  totalComments,
  classifications,
  qualitative,
  analizados = null,
  totalPost = null,
  priorizada = false,
}) {
  const metrics = computeWeightedSentimentPercentages(classifications);
  const performanceLevel = computePerformanceLevel(post);

  let posteoSobre = qualitative.posteoSobre || 'N/D';
  if (isPartial) {
    posteoSobre += ` ${partialDisclosure({ analizados, totalPost, priorizada })}`;
  }

  const apoyo = formatReferenceLines(qualitative.insightApoyo);
  const criticas = formatReferenceLines(qualitative.insightCriticas);
  const reclamos = formatReferenceLines(qualitative.insightReclamos);
  const medios = formatReferenceLines(qualitative.insightMedios);
  const temas = Array.isArray(qualitative.temasConversacion) ? qualitative.temasConversacion : [];

  const ownerName = post.ownerFullName ?? 'N/D';
  const ownerUser = post.ownerUsername ?? 'N/D';

  const beforeTemas = `🔍 ANÁLISIS DE POSTEO EN INSTAGRAM: ${ownerName} / @${ownerUser}

👉🏼 Posteo sobre: ${posteoSobre}

❤️ ${formatCountWithDots(post.likesCount)} Likes
💬 ${formatCountWithDots(post.commentsCount)} Comentarios
👁️ ${formatViewsShort(post.videoPlayCount)} visualizaciones / alcance
Link a publicación 👉🏼 ${url}

💡 INSIGHTS

1️⃣ Sentiment positivo: ${metrics.positivoPct}% | Sentiment negativo: ${metrics.negativoPct}%

2️⃣ Según los KPI's establecidos, el posteo alcanza un nivel ${performanceLevel} en cuanto a visualizaciones/interacciones.`;

  const afterTemas = `3️⃣ Apoyo de funcionarios, cuentas aliadas o usuarios afines enfocados en validar la gestión o el mensaje principal.
${apoyo[0]}
${apoyo[1]}

4️⃣ Críticas de opositores, militantes adversarios o usuarios detractores enfocadas en cuestionar la medida, la gestión o el encuadre comunicacional.
${criticas[0]}
${criticas[1]}

5️⃣ Reclamos de vecinos o audiencia orgánica sobre problemas concretos vinculados al tema del posteo.
${reclamos[0]}
${reclamos[1]}

6️⃣ Comentarios de periodistas, medios, influencers o cuentas con alcance relevante que amplifican o reinterpretan la conversación.
${medios[0]}
${medios[1]}

7️⃣ Postura de la audiencia orgánica: ${qualitative.posturaAudiencia || 'N/D'}

8️⃣ Lectura estratégica: ${qualitative.lecturaEstrategica || 'N/D'}`;

  const report = assembleReport(beforeTemas, temas, afterTemas);

  const csv = buildReclamosCsv(sample, classifications);

  return {
    report,
    csv,
    meta: { sampleSize, totalComments, ...metrics, performanceLevel },
    temas,
    reportParts: { beforeTemas, afterTemas },
  };
}

module.exports = { buildWhatsAppReport, buildReclamosCsv };
