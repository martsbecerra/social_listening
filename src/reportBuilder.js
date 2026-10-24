// ==========================================================================
// reportBuilder.js
// --------------------------------------------------------------------------
// El informe del análisis de publicación de Instagram (8 puntos, fase F) y
// sus CSV: el de comentarios y el de reclamos. Los números salen de
// analysisMetrics.js, nunca del modelo. X tiene el suyo (src/x/reportBuilder.js).
// ==========================================================================

const { formatCountWithDots } = require('./sentimentAggregate');
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

// ---------------------------------------------------------------- informe
// El informe de 8 puntos (reemplazó al institucional en la fase F, solo en
// Instagram) y el CSV de comentarios. Los dos salen de la vista de
// analysisMetrics.buildAnalysisView: los mismos números que la pantalla.

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

  // 1) lo que pasó. Sin hecho, "responde al posteo" solo si la mayoría habla
  // del posteo (corrida real del 24/10: lo decía con el 57 % desviado).
  let hechoTexto;
  const sp = vista.sobrePosteo;
  const fuera = sp && Number.isFinite(sp.proporcion) && sp.base > 0 ? 1 - sp.proporcion : null;
  if (!vista.disponible.hecho) hechoTexto = NO_DISPONIBLE;
  else if (vista.hecho) hechoTexto = `el ${pct(vista.hecho.proporcion)} de los comentarios habla de un mismo hecho ajeno al posteo: ${vista.hecho.titulo}.`;
  else if (fuera !== null && fuera >= 0.5) {
    const adonde = sp.desvios.length ? `, sobre todo a ${sp.desvios[0].tema}` : '';
    // Lo que falta para 100 del punto 4, así los dos suman lo mismo.
    hechoTexto = `sin un hecho dominante, pero el ${100 - Math.round(sp.proporcion * 100)} % se desvía del posteo${adonde}.`;
  } else hechoTexto = 'sin un hecho dominante; la conversación responde al posteo.';
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

module.exports = { buildReclamosCsv, buildInforme, buildComentariosCsv };
