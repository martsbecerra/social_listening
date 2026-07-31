// ==========================================================================
// classifier.js
// --------------------------------------------------------------------------
// Dos tareas, ambas con Claude Haiku (barato y rápido, no hace falta Sonnet
// para esto):
//   1. classifyPost: título + sentimiento de un posteo que YA se sabe que es
//      relevante (coincidió con una palabra clave, o es de una cuenta
//      trackeada sin caption para analizar).
//   2. classifyRelevance: para posteos que NO coincidieron con ninguna
//      palabra clave literal — le pregunta a Claude si el contenido igual
//      habla del Jefe de Gobierno porteño o de su gestión (detección
//      semántica), para no depender solo del matching de texto exacto.
// ==========================================================================

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

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
 * Clasifica un caption. Si Claude falla o responde algo inesperado, cae en
 * un resultado neutral por defecto en vez de romper el ciclo de monitoreo.
 */
async function classifyPost(caption) {
  const fallback = {
    title: (caption || '').slice(0, 60) || 'Sin descripción',
    sentiment: 'neutral',
  };

  if (!caption || !caption.trim()) return fallback;

  try {
    const model = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5';
    const message = await client.messages.create({
      model,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: caption.slice(0, 2000) }],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const parsed = JSON.parse(extractJson(text));
    const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallback.title;

    return { title, sentiment };
  } catch (err) {
    console.error('Clasificador: no se pudo clasificar el posteo, uso neutral por defecto:', err.message);
    return fallback;
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
 * Para posteos SIN coincidencia literal de palabra clave: le pregunta a
 * Claude si el contenido igual se relaciona con el tema (para no perderse
 * menciones indirectas). Ante cualquier duda o falla, es conservador y
 * devuelve relevant: false — mejor no traer algo dudoso a que se llene la
 * tabla de ruido.
 */
async function classifyRelevance(caption) {
  const fallback = { relevant: false, title: (caption || '').slice(0, 60) || 'Sin descripción', sentiment: 'neutral' };

  if (!caption || !caption.trim()) return fallback;

  try {
    const model = process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5';
    const message = await client.messages.create({
      model,
      max_tokens: 200,
      system: RELEVANCE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: caption.slice(0, 2000) }],
    });

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const parsed = JSON.parse(extractJson(text));
    const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallback.title;

    return { relevant: Boolean(parsed.relevant), title, sentiment };
  } catch (err) {
    console.error('Clasificador: no se pudo evaluar relevancia, se descarta por las dudas:', err.message);
    return fallback;
  }
}

module.exports = { classifyPost, classifyRelevance };
