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
const { rolTexto } = require('./figuras');

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

// ---------------------------------------------------------------- fase F
// El informe de 8 puntos (reemplaza al institucional de arriba, solo en
// Instagram; X tiene el suyo) y el CSV de comentarios. Los dos salen de la
// vista de analysisMetrics.buildAnalysisView: los mismos números que la
// pantalla.

const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MES = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const FECHA = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const FECHA_HORA = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const NO_DISPONIBLE = 'no disponible en este análisis (es anterior a la fase F).';

const pct = (p) => `${Math.round((p || 0) * 100)} %`;
const fechaDe = (fmt, iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? fmt.format(d) : null;
};

/** "Ana Leg (Legislador/a · oposición)" con una figura del equipo; "@usuario" si no. */
function quienTexto(q) {
  const f = q.figura;
  if (f && f.origen === 'equipo') return `${f.nombre || `@${q.usuario}`} (${rolTexto(f)})`;
  return `@${q.usuario}`;
}

/**
 * El informe de 8 puntos, listo para pegar en WhatsApp o en un mail: lo
 * mismo que muestra la pantalla. Un análisis anterior a la fase F dice
 * "no disponible" en lo que no tiene.
 * @param {object} vista analysisMetrics.buildAnalysisView(...)
 */
function buildInforme(vista) {
  const caption = String(vista.caption || '').replace(/\s+/g, ' ').trim();
  const cap = caption.length > 110 ? `${caption.slice(0, 110)}…` : caption;
  const dia = fechaDe(DIA_MES, vista.postedAt || vista.finishedAt);
  const t = vista.tono;
  const lineas = [];
  lineas.push(`*Análisis de publicación · ${vista.cuenta ? `@${vista.cuenta}` : 'Instagram'}${dia ? ` · ${dia}` : ''}*`);
  if (cap) lineas.push(`“${cap}”`);
  const analizados = `${formatCountWithDots(vista.analizados)} analizados`;
  lineas.push(`♥ ${formatCountWithDots(vista.likes)} · 💬 ${formatCountWithDots(vista.comentariosTotal)} comentarios (${analizados})`);
  lineas.push('');

  // 1) lo que pasó
  let hechoTexto;
  if (!vista.disponible.hecho) hechoTexto = NO_DISPONIBLE;
  else if (vista.hecho) hechoTexto = `el ${pct(vista.hecho.proporcion)} de los comentarios habla de un mismo hecho ajeno al posteo: ${vista.hecho.titulo}.`;
  else hechoTexto = 'sin un hecho dominante; la conversación responde al posteo.';
  lineas.push(`1) *Lo que pasó:* ${hechoTexto}`);

  // 2) tono
  const neto = `${t.neto > 0 ? '+' : ''}${t.neto}`;
  lineas.push(`2) *Tono:* ${pct(t.proporcion.positivo)} positivo · ${pct(t.proporcion.neutral)} neutro · ${pct(t.proporcion.negativo)} negativo (tono neto ${neto})`);

  // 3) postura
  const p = vista.postura;
  lineas.push(`3) *Postura hacia la gestión:* ${p ? `${pct(p.proporcion.favor)} a favor · ${pct(p.proporcion.neutra)} neutra · ${pct(p.proporcion.critica)} crítica` : NO_DISPONIBLE}`);

  // 4) hablan del posteo
  const s = vista.sobrePosteo;
  lineas.push(
    `4) *Hablan del posteo:* ${s ? `${pct(s.proporcion)}${s.desvios.length ? ` · se desvían a: ${s.desvios.map((d) => d.tema).join(', ')}` : ''}` : NO_DISPONIBLE}`
  );

  // 5) temas
  const temas = vista.temas.map((x) => (x.manual ? `${x.nombre}${x.texto ? `: ${x.texto}` : ''}` : `${x.nombre} (${formatCountWithDots(x.n)})`));
  lineas.push(`5) *Temas:* ${temas.length ? temas.join(', ') : 'sin temas que se repitan'}`);

  // 6) quién habló
  const ver = vista.quienHablo.filter((q) => q.verificada);
  const otros = vista.quienHablo.filter((q) => !q.verificada);
  let quien = ver.length ? `${ver.length} verificado${ver.length === 1 ? '' : 's'} — ${ver.map((q) => quienTexto(q)).join(', ')}` : 'ningún verificado';
  if (otros.length) quien += ` · figuras públicas sin tilde: ${otros.map((q) => quienTexto(q)).join(', ')}`;
  lineas.push(`6) *Quién habló:* ${quien}`);

  // 7) pedidos
  const pedidos = vista.pedidos;
  lineas.push(
    `7) *Pedidos:* ${!pedidos ? NO_DISPONIBLE : pedidos.length ? pedidos.slice(0, 3).map((x) => `${x.texto} (${formatCountWithDots(x.n)})`).join(' · ') : 'sin pedidos concretos'}`
  );

  // 8) lectura
  lineas.push(`8) *Lectura:* ${vista.lectura || 'N/D'}`);

  const destacados = vista.top.slice(0, 3);
  if (destacados.length) {
    lineas.push('', '*Comentarios destacados:*');
    for (const c of destacados) lineas.push(`• @${c.usuario}: “${c.texto}” (♥ ${formatCountWithDots(c.likes || 0)})`);
  }
  const fecha = fechaDe(FECHA, vista.finishedAt);
  lineas.push('', `_Social Listening · DGAYD${fecha ? ` · ${fecha}` : ''}_`);
  return lineas.join('\n');
}

const SI_NO = (v) => (v === true ? 'sí' : v === false ? 'no' : '');
const POSTURA_TEXTO = { favor: 'a favor', neutra: 'neutra', critica: 'crítica' };

/**
 * El CSV de comentarios: uno por renglón, con su clasificación y la fecha
 * en hora de Argentina. La pantalla le agrega el BOM para Excel.
 */
function buildComentariosCsv(vista) {
  const header = [
    'Número',
    'Usuario',
    'Verificada',
    'Likes',
    'Fecha (hora de Argentina)',
    'Horas desde la publicación',
    'Tono',
    'Postura',
    'Tema',
    'Habla del posteo',
    'Pedido o pregunta',
    'Texto',
  ];
  const rows = [header.map(escapeCsvField).join(',')];
  for (const c of vista.comentarios) {
    rows.push(
      [
        c.n,
        c.usuario,
        SI_NO(c.verificada),
        c.likes ?? '',
        fechaDe(FECHA_HORA, c.fecha) || '',
        c.horas !== null ? Math.round(c.horas * 10) / 10 : '',
        c.tono || 'sin clasificar',
        POSTURA_TEXTO[c.postura] || '',
        c.tema || '',
        SI_NO(c.sobrePosteo),
        SI_NO(c.pedido),
        c.texto,
      ]
        .map(escapeCsvField)
        .join(',')
    );
  }
  return `${rows.join('\n')}\n`;
}

module.exports = { buildWhatsAppReport, buildReclamosCsv, buildInforme, buildComentariosCsv };
