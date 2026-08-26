// ==========================================================================
// classifier.js
// --------------------------------------------------------------------------
// Dos tareas, ambas con el modelo clasificador del proveedor activo (barato y
// rápido, no hace falta el modelo de análisis para esto — ver
// getClassifierModel en src/llm/providerConfig.js):
//   1. classifyPost: título + sentimiento de un posteo que YA se sabe que es
//      relevante (coincidió con una palabra clave, o es de una cuenta
//      trackeada sin caption para analizar).
//   2. classifyRelevance: para posteos que NO coincidieron con ninguna
//      palabra clave literal — le pregunta al modelo si el contenido igual
//      habla del Jefe de Gobierno porteño o de su gestión (detección
//      semántica), para no depender solo del matching de texto exacto.
//
// Pasa por src/llm/, nunca por el SDK de un proveedor: cambiar LLM_PROVIDER
// tiene que migrar el monitoreo igual que el análisis de publicación.
//
// SOBRE LOS FALLOS: antes, cualquier error devolvía un resultado inventado
// (neutral / relevant:false). Eso hacía que una API caída se viera igual que
// "no hay nada relevante": el monitoreo descartaba posteos válidos sin que
// nadie se enterara. Ahora un fallo devuelve unclassified:true y el posteo se
// guarda igual, con title/sentiment en null → la UI lo muestra como
// "(sin clasificar)" y backfillClassification lo reintenta después. Preferimos
// ruido visible a pérdida silenciosa.
// ==========================================================================

const { requestText } = require('./llm');

const VALID_SENTIMENTS = ['positivo', 'neutral', 'negativo'];

const SYSTEM_PROMPT = `Sos un clasificador rápido de menciones políticas para un equipo de gobierno.
Te paso el caption de un posteo de Instagram. Respondé SOLO un JSON, sin texto adicional, sin markdown, con exactamente este formato:

{"title": "...", "sentiment": "positivo" | "neutral" | "negativo"}

- "title": una frase corta (máximo 10 palabras), en español, que resuma de qué habla el posteo.
- "sentiment": cómo retrata el posteo al Jefe de Gobierno de la Ciudad de Buenos Aires o a su gestión:
  - "positivo" si lo muestra favorablemente o destaca un logro de su gestión.
  - "negativo" si lo critica, cuestiona o muestra un hecho desfavorable.
  - "neutral" si es puramente informativo, no queda claro, o no podés determinarlo con confianza.
  Ante la duda, usá siempre "neutral".`;

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

/**
 * Resultado cuando no se pudo clasificar (API caída, respuesta ilegible).
 * title y sentiment van en null a propósito: es lo que hace que el posteo
 * aparezca como "(sin clasificar)" en la tabla y que listUnclassified() lo
 * agarre en el próximo backfill (su criterio es title IS NULL).
 */
function unclassifiedResult(extra = {}) {
  return { title: null, sentiment: null, unclassified: true, ...extra };
}

/** Log uniforme, distinguiendo el tipo de fallo para poder diagnosticar. */
function logClassifierFailure(tarea, err) {
  const motivo = err.isApiFailure ? 'falló la API del LLM' : 'respuesta ilegible del modelo';
  console.error(
    `Clasificador (${tarea}): ${motivo} — el posteo se guarda SIN CLASIFICAR ` +
    `y se reintenta en el próximo backfill. Detalle: ${err.message}`
  );
}

/**
 * Clasifica un caption. Si el LLM falla o responde algo inesperado, devuelve
 * unclassified:true en vez de inventar un "neutral".
 */
async function classifyPost(caption) {
  if (!caption || !caption.trim()) {
    return { title: 'Sin descripción', sentiment: 'neutral' };
  }

  try {
    const { text } = await requestText({
      system: SYSTEM_PROMPT,
      userPrompt: caption.slice(0, 2000),
      maxTokens: 200,
    });

    const parsed = JSON.parse(extractJson(text));
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
    if (!title) throw new Error('el modelo no devolvió un título usable');

    const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    return { title, sentiment };
  } catch (err) {
    logClassifierFailure('título + sentimiento', err);
    return unclassifiedResult();
  }
}

const RELEVANCE_SYSTEM_PROMPT = `Sos un clasificador para un equipo de gobierno que monitorea menciones al Jefe de Gobierno de la Ciudad de Buenos Aires (Jorge Macri) y a su gestión.
Te paso el caption de un posteo de Instagram que NO contiene ninguna palabra clave literal conocida. Tu tarea es juzgar, por el CONTENIDO, si igual se relaciona con él o con la gestión de la Ciudad de Buenos Aires (obras públicas, políticas, anuncios, funcionarios porteños, gestión municipal, etc.), aunque no lo nombre explícitamente.

Respondé SOLO un JSON, sin texto adicional, sin markdown, con exactamente este formato:

{"relevant": true | false, "title": "...", "sentiment": "positivo" | "neutral" | "negativo"}

- "relevant": true solo si el contenido realmente habla del Jefe de Gobierno porteño o de su gestión. false para cualquier otro tema (contenido genérico, turístico, cultural, de otro distrito o de otro funcionario sin relación).
- "title": frase corta (máximo 10 palabras) en español de qué habla el posteo. Completala siempre, incluso si relevant es false.
- "sentiment": solo importa si relevant es true — cómo lo retrata ("positivo", "negativo", o "neutral" ante la duda).`;

/**
 * Para posteos SIN coincidencia literal de palabra clave: le pregunta al
 * modelo si el contenido igual se relaciona con el tema (para no perderse
 * menciones indirectas).
 *
 * Un `relevant: false` del modelo SÍ descarta el posteo: esa es su función y
 * es una respuesta legítima. Lo que ya no descarta nada es un FALLO: ante un
 * error se devuelve relevant:true + unclassified:true, para que el posteo
 * quede guardado y visible y alguien pueda mirarlo. Puede traer ruido; el
 * ruido se ve y se borra, un posteo perdido no.
 */
async function classifyRelevance(caption) {
  if (!caption || !caption.trim()) {
    return { relevant: false, title: 'Sin descripción', sentiment: 'neutral' };
  }

  try {
    const { text } = await requestText({
      system: RELEVANCE_SYSTEM_PROMPT,
      userPrompt: caption.slice(0, 2000),
      maxTokens: 200,
    });

    const parsed = JSON.parse(extractJson(text));
    if (typeof parsed.relevant !== 'boolean') {
      throw new Error('el modelo no devolvió un campo "relevant" booleano');
    }
    if (!parsed.relevant) return { relevant: false };

    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
    const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';

    // Dijo que es relevante pero no dio título: sirve como hallazgo, no como
    // clasificación — se guarda para reintentar el título después.
    if (!title) return unclassifiedResult({ relevant: true });

    return { relevant: true, title, sentiment };
  } catch (err) {
    logClassifierFailure('relevancia', err);
    return unclassifiedResult({ relevant: true });
  }
}

module.exports = { classifyPost, classifyRelevance };
