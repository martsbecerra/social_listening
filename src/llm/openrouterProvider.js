// ==========================================================================
// openrouterProvider.js — Chat completions (API compatible con OpenAI).
// --------------------------------------------------------------------------
// OpenRouter no necesita un SDK propio: expone la API de OpenAI. Se usa fetch
// contra {OPENROUTER_BASE_URL}/chat/completions, así que el mismo código sirve
// para cualquier gateway compatible cambiando sólo esa variable.
//
// Dos modos de uso:
//   - requestStructuredAnalysis: response_format json_schema (análisis de post)
//   - requestText:               texto plano (clasificador del monitoreo)
// ==========================================================================

const { ANALYSIS_JSON_SCHEMA } = require('../analysisSchema');
const { addTokenUsage, fromOpenRouterUsage } = require('./usage');
const { getAnalysisModel, getClassifierModel } = require('./providerConfig');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

// Header opcional pero recomendado por OpenRouter para identificar la app
// (aparece en los rankings de openrouter.ai). Se puede pisar desde .env.
const DEFAULT_APP_TITLE = 'Social Listening App';

function getBaseUrl() {
  const raw = (process.env.OPENROUTER_BASE_URL || '').trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function getChatCompletionsUrl() {
  return getBaseUrl() + '/chat/completions';
}

function requireApiKey() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const e = new Error('OPENROUTER_API_KEY no configurada');
    e.isApiFailure = true;
    e.userMessage =
      'Falta OPENROUTER_API_KEY en .env. Obtené una en https://openrouter.ai/settings/keys o usá LLM_PROVIDER=anthropic.';
    throw e;
  }
  return apiKey;
}

function buildHeaders(apiKey) {
  const port = process.env.PORT || 3000;
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // La app corre local: el referer honesto es el propio servidor.
    'HTTP-Referer': (process.env.OPENROUTER_HTTP_REFERER || '').trim() || `http://localhost:${port}`,
    'X-Title': (process.env.OPENROUTER_APP_NAME || '').trim() || DEFAULT_APP_TITLE,
  };
}

/**
 * Una llamada a /chat/completions. Devuelve el JSON crudo de la respuesta.
 * Cualquier fallo sale como Error con isApiFailure = true, para que el
 * clasificador pueda distinguir "no pude hablar con el modelo" de "el modelo
 * respondió algo que no entiendo".
 */
async function postChatCompletion(body) {
  const apiKey = requireApiKey();

  let res;
  let data;
  try {
    res = await fetch(getChatCompletionsUrl(), {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    // Falla de red / DNS / timeout: nunca llegamos a hablar con el modelo.
    throw mapOpenRouterError(err);
  }

  if (!res.ok) throw mapOpenRouterHttpError(res.status, data);
  return data;
}

async function requestStructuredAnalysis({ system, userPrompt }) {
  const model = getAnalysisModel('openrouter');

  const body = {
    model,
    max_tokens: 8000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'analisis_instagram',
        strict: true,
        schema: ANALYSIS_JSON_SCHEMA,
      },
    },
  };

  let lastError;
  let usage = null;
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await postChatCompletion(body);

      const callUsage = fromOpenRouterUsage(data.usage);
      if (callUsage) usage = usage ? addTokenUsage(usage, callUsage) : callUsage;

      const parsed = parseMessageContent(data);
      if (parsed != null) {
        return { parsed, usage, attempts: attempt };
      }
      lastError = new Error('contenido vacío o JSON inválido');
    } catch (err) {
      lastError = err;
      if (err.userMessage) throw err;
      console.warn(
        `OpenRouter structured output intento ${attempt}/${STRUCTURED_OUTPUT_MAX_ATTEMPTS} falló:`,
        err.message
      );
      if (attempt === STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
        throw mapOpenRouterError(lastError);
      }
    }
  }

  const e = new Error(`Structured output falló: ${lastError?.message || 'desconocido'}`);
  e.userMessage =
    'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
  throw e;
}

/**
 * Texto plano, sin schema — lo que necesita el clasificador del monitoreo.
 * No reintenta ni traga errores: quien llama decide qué hacer (ver
 * src/classifier.js).
 * @returns {Promise<{ text: string, usage: import('./usage').TokenUsage | null }>}
 */
async function requestText({ system, userPrompt, maxTokens = 200 }) {
  const model = getClassifierModel('openrouter');

  const data = await postChatCompletion({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  });

  return { text: extractText(data), usage: fromOpenRouterUsage(data.usage) };
}

/** Aplana el content de la respuesta (string o array de partes) a texto. */
function extractText(data) {
  const raw = data?.choices?.[0]?.message?.content;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

function parseMessageContent(data) {
  const text = extractText(data);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapOpenRouterHttpError(status, data) {
  const msg =
    data?.error?.message ||
    data?.message ||
    (typeof data?.error === 'string' ? data.error : '') ||
    `HTTP ${status}`;

  console.error('Error llamando a OpenRouter:', status, msg);
  const e = new Error(`OpenRouter falló: ${msg}`);
  e.isApiFailure = true;
  e.status = status;

  if (status === 401) {
    e.userMessage = 'La clave de OpenRouter (OPENROUTER_API_KEY) es inválida. Revisá el archivo .env.';
  } else if (status === 402 || /insufficient|credits|balance/i.test(msg)) {
    e.userMessage =
      'Tu cuenta de OpenRouter no tiene crédito suficiente. Cargá saldo en https://openrouter.ai/settings/credits e intentá de nuevo.';
  } else if (status === 429) {
    e.userMessage = 'Se alcanzó el límite de uso del modelo por el momento. Esperá unos minutos e intentá de nuevo.';
  } else if (/structured|json_schema|response_format/i.test(msg)) {
    e.userMessage =
      'El modelo configurado en OPENROUTER_MODEL no soporta salida JSON con schema. Verificá en https://openrouter.ai/models que liste "structured_outputs".';
  } else {
    e.userMessage = 'El servicio de análisis (OpenRouter) falló. Intentá de nuevo en unos minutos.';
  }
  return e;
}

function mapOpenRouterError(err) {
  if (err.userMessage) {
    err.isApiFailure = true;
    return err;
  }
  console.error('Error llamando a OpenRouter:', err);
  const e = new Error(`OpenRouter falló: ${err.message}`);
  e.isApiFailure = true;
  e.userMessage = 'El servicio de análisis (OpenRouter) falló. Intentá de nuevo en unos minutos.';
  return e;
}

module.exports = { requestStructuredAnalysis, requestText, getBaseUrl };
