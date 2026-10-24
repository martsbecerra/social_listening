// ==========================================================================
// userPrompt.js — Los mensajes de usuario del análisis de publicación de
// Instagram (src/analyzeComments.js): uno por tanda de comentarios a
// clasificar (con la lista de temas, o la orden de definirlos) y el de la
// síntesis, con los números ya contados por el sistema.
// ==========================================================================

const fmt = (n) => (n === null || n === undefined ? 'N/D' : n);
const pct = (p) => `${Math.round((p || 0) * 100)} %`;

function postBlock({ url, post }) {
  return `=== DATOS DEL POSTEO ===
Autor (nombre): ${fmt(post.ownerFullName)}
Usuario: @${fmt(post.ownerUsername)}
Link: ${url}
Likes del posteo: ${fmt(post.likesCount)}
Cantidad de comentarios (total del posteo): ${fmt(post.commentsCount)}
Reproducciones de video (si aplica): ${fmt(post.videoPlayCount)}
Texto / caption del posteo: ${post.caption ? post.caption : 'N/D'}`;
}

function commentHead(c) {
  const verified = c.isVerified ? ' [VERIFICADA]' : '';
  const likes = c.likesCount == null ? 'likes sin dato' : `${c.likesCount} likes`;
  const fecha = c.timestamp ? ` | ${c.timestamp}` : '';
  return { verified, datos: `${likes}${fecha}` };
}

/**
 * Una tanda: los comentarios numerados desde 1 (el index de la respuesta es
 * el de esta lista, no el de la muestra entera).
 * @param {{ url: string, post: object, batch: Array, numero: number, tandas: number, temas: Array<{ numero: number, nombre: string }> }} params
 *   temas: la lista vigente; vacía = esta tanda define los temas.
 */
function buildBatchPrompt({ url, post, batch, numero, tandas, temas }) {
  const commentsText = batch
    .map((c, i) => {
      const { verified, datos } = commentHead(c);
      return `${i + 1}. @${c.username}${verified} (${datos}): ${c.text}`;
    })
    .join('\n');
  const bloqueTemas =
    temas && temas.length
      ? `=== LISTA DE TEMAS (usala; si hace falta uno nuevo, numeralo desde ${temas.length + 1}) ===
${temas.map((t) => `${t.numero}. ${t.nombre}`).join('\n')}`
      : `=== DEFINÍ LOS TEMAS ===
Armá de 4 a 10 temas que cubran esta conversación, numerados desde 1, y devolvelos en "temas".`;
  return `Clasificá cada comentario siguiendo la metodología y las REGLAS DE DESEMPATE del system prompt: un ítem en classifications por cada comentario numerado (index 1-based, el número de esta lista). Respondé únicamente con JSON según el schema.

${postBlock({ url, post })}

${bloqueTemas}

=== COMENTARIOS (tanda ${numero} de ${tandas}: ${batch.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===`;
}

const POSTURA = { favor: 'a favor', neutra: 'postura neutra', critica: 'crítica' };

/**
 * La síntesis: los números del sistema (de analysisMetrics), los temas con
 * sus cantidades, el tema principal fuera del posteo, los verificados que no
 * están en la lista de figuras y una muestra de los comentarios
 * clasificados, cada uno con su número en el análisis.
 * @param {{ url: string, post: object, vista: object, muestra: Array, verificadosSinFicha: string[] }} params
 *   vista: analysisMetrics.buildAnalysisView sobre lo clasificado.
 */
function buildSynthesisPrompt({ url, post, vista, muestra, verificadosSinFicha }) {
  const t = vista.tono;
  const p = vista.postura;
  const s = vista.sobrePosteo;
  const total = Number.isFinite(post.commentsCount) ? ` de ${post.commentsCount} (el total que informa Instagram)` : '';
  const numeros = [
    `Analizados: ${vista.analizados}${total}`,
    `Tono: ${t.positivos} positivos (${pct(t.proporcion.positivo)}), ${t.neutrales} neutrales (${pct(t.proporcion.neutral)}), ${t.negativos} negativos (${pct(t.proporcion.negativo)}); ruido aparte: ${t.ruido}`,
    p ? `Postura hacia la gestión: ${p.favor} a favor (${pct(p.proporcion.favor)}), ${p.neutra} neutra (${pct(p.proporcion.neutra)}), ${p.critica} crítica (${pct(p.proporcion.critica)})` : null,
    s ? `Hablan del posteo: ${s.si} (${pct(s.proporcion)}); lo usan para otra cosa: ${s.no}` : null,
  ].filter(Boolean);
  const fueraDe = new Map(((s && s.desvios) || []).map((d) => [d.temaId, d.n]));
  const temas = vista.temas
    .filter((x) => !x.manual)
    .map((x) => `${x.id}. ${x.nombre}: ${x.n} comentarios · ${x.tonos.positivo} pos / ${x.tonos.neutral} neu / ${x.tonos.negativo} neg · ${fueraDe.get(x.id) || 0} fuera del posteo`);
  const principal = s && s.desvios.length ? s.desvios[0] : null;
  const lineaPrincipal = principal
    ? `${principal.temaId}. ${principal.tema} (${principal.n} comentarios que no hablan del posteo; ${pct(vista.analizados ? principal.n / vista.analizados : 0)} de los analizados)`
    : 'ninguno';
  const comentarios = muestra
    .map((c) => {
      const marcas = [c.tono || 'sin clasificar', POSTURA[c.postura], c.temaId ? `tema ${c.temaId}` : 'sin tema', c.sobrePosteo === false ? 'fuera del posteo' : null, c.pedido ? 'PEDIDO' : null]
        .filter(Boolean)
        .join(' · ');
      const likes = c.likes == null ? 'likes sin dato' : `${c.likes} likes`;
      return `${c.n}. @${c.usuario}${c.verificada ? ' [VERIFICADA]' : ''} [${marcas}] (${likes}): ${c.texto}`;
    })
    .join('\n');
  return `Con los números y los comentarios ya clasificados de abajo, completá lectura, hecho_dominante, pedidos, que_mirar y figuras_sugeridas. Respondé únicamente con JSON según el schema.

${postBlock({ url, post })}

=== NÚMEROS (los calculó el sistema; citá solo estos) ===
${numeros.join('\n')}

=== TEMAS (número. nombre: cantidad · tono · fuera del posteo) ===
${temas.length ? temas.join('\n') : 'ninguno'}

=== TEMA PRINCIPAL FUERA DEL POSTEO ===
${lineaPrincipal}

=== VERIFICADOS SIN FICHA ===
${verificadosSinFicha.length ? verificadosSinFicha.map((u) => `@${u}`).join(', ') : 'ninguno'}

=== COMENTARIOS (muestra de ${muestra.length}, con su número en el análisis) ===
${comentarios}

=== FIN DE LOS DATOS ===`;
}

module.exports = { buildBatchPrompt, buildSynthesisPrompt };
