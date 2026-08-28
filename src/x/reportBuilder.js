// ==========================================================================
// reportBuilder.js — WhatsApp (plantilla Prompt Grok) + CSV de reclamos X.
// ==========================================================================

const { formatCountWithDots, formatViewsShort } = require('../sentimentAggregate');
const { canonicalizeStatusUrl, parseXPostUrl } = require('./url');
const {
  computeWeightedSentimentPercentages,
  computePerformanceLevels,
} = require('./kpis');
const { PARTIAL_SAMPLE_DISCLOSURE } = require('./sample');
const { EMPTY_INSIGHT } = require('./validate');
const { isIdentifiedInfluencer } = require('./influencers');

const CSV_HEADER = 'Direccion_o_Ubicacion,Tematica,Link_Comentario,Usuario_Perfil';

function escapeCsvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildReclamosCsv(sample, classifications) {
  const rows = [CSV_HEADER];
  for (let i = 0; i < classifications.length; i++) {
    const reclamos = classifications[i]?.reclamosGeo;
    if (!reclamos || reclamos.length === 0) continue;
    const item = sample[i];
    if (!item) continue;
    const handle = item.username ? `@${item.username}` : '';
    for (const r of reclamos) {
      if (!r?.direccionDetectada) continue;
      rows.push(
        [
          escapeCsvField(r.direccionDetectada),
          escapeCsvField(r.tematica || ''),
          escapeCsvField(item.url || ''),
          escapeCsvField(handle),
        ].join(',')
      );
    }
  }
  return `${rows.join('\n')}\n`;
}

function canonicalizeUrlsInText(text, sample) {
  return String(text || '').replace(
    /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^\s]+/gi,
    (url) => {
      let raw = url;
      let trail = '';
      while (/[),.;:!?]$/.test(raw)) {
        trail = raw.slice(-1) + trail;
        raw = raw.slice(0, -1);
      }
      const parsed = parseXPostUrl(raw);
      if (!parsed) return url;
      const item = (sample || []).find((s) => String(s.id) === parsed.id);
      const canonical = item
        ? canonicalizeStatusUrl(item.url, item.username, item.id)
        : canonicalizeStatusUrl(raw, parsed.handle, parsed.id);
      return (canonical || raw) + trail;
    }
  );
}

function formatInsightBlock(refs, sample) {
  if (!refs || refs.length === 0) return EMPTY_INSIGHT;
  return refs.map((line) => canonicalizeUrlsInText(line, sample)).join('\n');
}

function top6Line(item) {
  const handle = item.username ? `@${item.username}` : '@desconocido';
  const excerpt = String(item.text || '').replace(/\s+/g, ' ').slice(0, 140);
  const rts = Number(item.retweets) || 0;
  const link = canonicalizeStatusUrl(item.url, item.username, item.id) || item.url || '';
  return `${handle} - ${excerpt} - ${rts} RTs - ${link}`;
}

function buildTop6(sample, classifications, sentiment, influencerMap) {
  const rows = [];
  const n = Math.min(sample.length, classifications.length);
  for (let i = 0; i < n; i++) {
    if (classifications[i]?.sentiment !== sentiment) continue;
    rows.push(sample[i]);
  }
  rows.sort((a, b) => {
    const rt = (Number(b.retweets) || 0) - (Number(a.retweets) || 0);
    if (rt !== 0) return rt;
    const aId = isIdentifiedInfluencer(a.username, influencerMap) ? 1 : 0;
    const bId = isIdentifiedInfluencer(b.username, influencerMap) ? 1 : 0;
    return bId - aId;
  });
  return rows.slice(0, 6).map(top6Line);
}

function formatTop6(lines) {
  if (!lines.length) return EMPTY_INSIGHT;
  return lines.join('\n\n');
}

function buildWhatsAppReport({
  url,
  post,
  sample,
  isPartial,
  classifications,
  qualitative,
  influencerMap,
}) {
  const metrics = computeWeightedSentimentPercentages(sample, classifications);
  const performance = computePerformanceLevels(post);

  let posteoSobre = qualitative.posteoSobre || 'N/D';
  if (isPartial) posteoSobre += ` ${PARTIAL_SAMPLE_DISCLOSURE}`;

  const ownerName = post.authorName || post.displayName || 'N/D';
  const ownerUser = post.authorHandle || post.username || 'N/D';
  const postLink = canonicalizeStatusUrl(url, ownerUser, post.id) || url;

  const report = `🔍 ANÁLISIS DE POSTEO EN X: ${ownerName} / @${ownerUser}

👉🏼 Posteo sobre: ${posteoSobre}

❤️ ${formatCountWithDots(post.likes)} Likes

🔁 ${formatCountWithDots(post.retweets)} RTs

🔄 ${formatCountWithDots(post.quotes)} QTs (Desagregado)

💬 ${formatCountWithDots(post.replies)} Respuestas

📥 ${formatCountWithDots(post.bookmarks)} Guardados

👁️ ${formatViewsShort(post.views)} visualizaciones

Link a publicación 👉🏼 ${postLink}

💡 INSIGHTS

1️⃣ Sentiment positivo: ${metrics.positivoPct}% | Sentiment negativo: ${metrics.negativoPct}%

2️⃣ Según los KPI's establecidos, el posteo alcanza un nivel ${performance.viewsLevel} en visualizaciones y un nivel ${performance.interactionsLevel} en interacciones.

3️⃣ Apoyo de funcionarios del GCBA y cuentas aliadas enfocadas en la validación de la gestión pública. ${formatInsightBlock(qualitative.insightApoyo, sample)}

4️⃣ Cuestionamientos de legisladores de la oposición y militantes adversarios. ${formatInsightBlock(qualitative.insightCriticas, sample)}

5️⃣ Reclamos de vecinos por deficiencias específicas de gestión relacionadas al post (Ej: transporte, residuos, infraestructura). ${formatInsightBlock(qualitative.insightReclamos, sample)}

6️⃣ Declaraciones de periodistas de medios nacionales analizando la viabilidad política de la medida. ${formatInsightBlock(qualitative.insightMedios, sample)}

7️⃣ ${formatInsightBlock(qualitative.insightOrganica, sample)}

8️⃣ Críticas aisladas respecto a la estética o formas de la comunicación institucional sin afectar el núcleo. ${formatInsightBlock(qualitative.insightEstetica, sample)}

📈 TOP 6 POSTEOS CON MÁS RETUITS (SENTIMIENTO POSITIVO)

${formatTop6(buildTop6(sample, classifications, 'positivo', influencerMap))}

📉 TOP 6 POSTEOS CON MÁS RETUITS (SENTIMIENTO NEGATIVO)

${formatTop6(buildTop6(sample, classifications, 'negativo', influencerMap))}`;

  const csv = buildReclamosCsv(sample, classifications);

  return {
    report,
    csv,
    meta: {
      ...metrics,
      viewsLevel: performance.viewsLevel,
      interactionsLevel: performance.interactionsLevel,
    },
  };
}

module.exports = { buildWhatsAppReport, buildReclamosCsv, buildTop6, formatInsightBlock };
