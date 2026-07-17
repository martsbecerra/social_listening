// ==========================================================================
// anthropic.js
// --------------------------------------------------------------------------
// Se encarga de hablar con la API de Claude (Anthropic).
// Arma el "prompt" (el mensaje) con los datos del posteo y los comentarios,
// se lo manda a Claude junto con la metodología (system prompt) y devuelve
// el reporte final en texto.
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompt');

// El SDK lee automáticamente la variable de entorno ANTHROPIC_API_KEY.
const client = new Anthropic();

// Cuántos comentarios como máximo le mandamos a Claude. Le ponemos un tope
// para no enviar textos gigantes (más barato y más rápido). Si hay más, se
// analiza sobre una "muestra parcial" (y se lo aclaramos a Claude).
const MAX_COMMENTS_TO_SEND = 150;

// Marcadores que le pedimos a Claude que use para separar, dentro de la
// misma respuesta, el reporte de WhatsApp del bloque CSV de reclamos.
// Deben coincidir exactamente con los que se indican en prompt.js.
const CSV_START_MARKER = '===CSV_RECLAMOS===';
const CSV_END_MARKER = '===FIN_CSV===';

// Encabezado que usamos como CSV "vacío" de respaldo, por si Claude no
// devolviera el bloque en el formato esperado (para que la app no se rompa).
const CSV_FALLBACK = '"Nombre de usuario","Direccion detectada","Direccion normalizada","Tematica detectada"\n';

/**
 * Pide a Claude el análisis de sentimiento y devuelve el reporte y el CSV.
 * @param {{url: string, post: object, comments: Array}} params
 * @returns {Promise<{report: string, csv: string}>}
 */
async function analyzeComments({ url, post, comments }) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
  const userPrompt = buildUserPrompt({ url, post, comments });

  let message;
  try {
    message = await client.messages.create({
      model,
      // Subimos el tope de tokens porque ahora Claude genera, además del
      // reporte, el bloque CSV de reclamos con dirección.
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('Error llamando a Claude:', err);
    const e = new Error(`Claude falló: ${err.message}`);
    // El SDK expone err.status con el código HTTP.
    const mensajeApi = err.error?.error?.message || '';
    if (err.status === 401) {
      e.userMessage = 'La clave de Anthropic (ANTHROPIC_API_KEY) es inválida. Revisá el archivo .env.';
    } else if (err.status === 400 && /credit balance is too low/i.test(mensajeApi)) {
      e.userMessage = 'Tu cuenta de Anthropic no tiene crédito suficiente. Cargá saldo en https://console.anthropic.com/settings/billing e intentá de nuevo.';
    } else if (err.status === 429) {
      e.userMessage = 'Se alcanzó el límite de uso de Claude por el momento. Esperá unos minutos e intentá de nuevo.';
    } else {
      e.userMessage = 'El servicio de análisis (Claude) falló. Intentá de nuevo en unos minutos.';
    }
    throw e;
  }

  // La respuesta viene como una lista de "bloques"; juntamos los de tipo texto.
  const fullText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return splitReportAndCsv(fullText);
}

/**
 * Separa el texto completo que devuelve Claude en dos partes:
 * el reporte (todo lo que va antes del marcador) y el CSV de reclamos
 * (lo que va entre los dos marcadores).
 *
 * Si por algún motivo Claude no incluyó los marcadores (puede pasar si el
 * modelo se desvía del formato pedido), devolvemos todo el texto como
 * reporte y un CSV vacío, para que la app siga funcionando igual.
 */
function splitReportAndCsv(fullText) {
  const startIdx = fullText.indexOf(CSV_START_MARKER);
  const endIdx = fullText.indexOf(CSV_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.warn('Claude no devolvió el bloque CSV con el formato esperado; se omite el CSV.');
    return { report: fullText, csv: CSV_FALLBACK };
  }

  const report = fullText.slice(0, startIdx).trim();
  let csv = fullText.slice(startIdx + CSV_START_MARKER.length, endIdx).trim();
  if (!csv) csv = CSV_FALLBACK.trim();

  return { report, csv: csv + '\n' };
}

/**
 * Arma el mensaje del usuario: datos del posteo + lista de comentarios,
 * en un formato ordenado y fácil de leer para Claude.
 */
function buildUserPrompt({ url, post, comments }) {
  const totalComments = comments.length;
  const sample = comments.slice(0, MAX_COMMENTS_TO_SEND);
  const isPartial = totalComments > sample.length;

  // Formateamos los comentarios como una lista numerada y legible.
  const commentsText = sample
    .map((c, i) => {
      const verified = c.isVerified ? ' [VERIFICADA]' : '';
      const likes = `${c.likesCount} likes`;
      const fecha = c.timestamp ? ` | ${c.timestamp}` : '';
      return `${i + 1}. @${c.username}${verified} (${likes}${fecha}): ${c.text}`;
    })
    .join('\n');

  const fmt = (n) => (n === null || n === undefined ? 'N/D' : n);

  const notaMuestra = isPartial
    ? `\nIMPORTANTE: Se analiza una muestra parcial de ${sample.length} comentarios (de ${totalComments} extraídos). Aclaralo en el reporte con la frase indicada en las reglas.\n`
    : '';

  return `Analizá la siguiente publicación de Instagram siguiendo estrictamente la metodología y el formato de salida indicados.

=== DATOS DEL POSTEO ===
Autor (nombre): ${fmt(post.ownerFullName)}
Usuario: @${fmt(post.ownerUsername)}
Link: ${url}
Likes del posteo: ${fmt(post.likesCount)}
Cantidad de comentarios (total del posteo): ${fmt(post.commentsCount)}
Reproducciones de video (si aplica): ${fmt(post.videoPlayCount)}
Texto / caption del posteo: ${post.caption ? post.caption : 'N/D'}
${notaMuestra}
=== COMENTARIOS EXTRAÍDOS (${sample.length}) ===
${commentsText}

=== FIN DE LOS DATOS ===

Generá ahora el reporte ejecutivo respetando EXACTAMENTE el formato de salida obligatorio, listo para copiar y pegar en WhatsApp, y a continuación el bloque CSV de reclamos geolocalizables (entre los marcadores indicados). No agregues ningún otro texto antes del reporte, entre el reporte y el bloque CSV, ni después del bloque CSV.`;
}

module.exports = { analyzeComments };
