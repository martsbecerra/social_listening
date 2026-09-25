// ==========================================================================
// openrouterProvider.js — Chat completions (API compatible con OpenAI).
// --------------------------------------------------------------------------
// OpenRouter no necesita un SDK propio: expone la API de OpenAI. Se usa fetch
// contra {OPENROUTER_BASE_URL}/chat/completions, así que el mismo código sirve
// para cualquier gateway compatible cambiando sólo esa variable.
//
// Dos modos de uso, con el mismo modelo:
//   - requestStructuredAnalysis: response_format json_schema (análisis de
//                                post y clasificador del monitoreo)
//   - requestText:               texto plano (reclamos, importador)
// Toda request tiene timeout (`timeoutMs`, ver DEFAULT_TIMEOUT_MS) y un
// fallo transitorio (429, 5xx, corte de red, timeout) se reintenta UNA vez
// (ver postChatCompletion).
// ==========================================================================

const { ANALYSIS_JSON_SCHEMA } = require('../analysisSchema');
const { addTokenUsage, fromOpenRouterUsage } = require('./usage');
const { getAnalysisModel } = require('./providerConfig');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

// Timeout por request y reintento único ante fallos transitorios. El timeout
// default es holgado a propósito: el análisis de comentarios pide hasta 8000
// tokens de salida y puede tardar minutos; el clasificador del monitoreo
// pasa el suyo (60 s, ver src/classifier.js). Transitorio = 429, 408, 5xx,
// corte de red o timeout: se espera TRANSIENT_RETRY_DELAY_MS y se prueba una
// vez más. Sin esto, un hipo de OpenRouter en medio de un ciclo dejaba a
// TODOS los candidatos de ese ciclo "sin clasificar" (guardados como
// relevantes, y sus cuentas disparaban benchmark y refresco en Apify). Un
// 400/401/402 no se reintenta: no va a cambiar en tres segundos.
const DEFAULT_TIMEOUT_MS = 300000;
const TRANSIENT_MAX_ATTEMPTS = 2;
// LLM_RETRY_DELAY_MS existe solo para que los tests no esperen 3 s.
const TRANSIENT_RETRY_DELAY_MS = Number(process.env.LLM_RETRY_DELAY_MS) >= 0 ? Number(process.env.LLM_RETRY_DELAY_MS) : 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientError(err) {
  if (!err) return false;
  if (err.transient === true) return true;
  const status = Number(err.status);
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

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
 * Una llamada a /chat/completions, con timeout y un reintento si el fallo
 * es transitorio (ver isTransientError). Devuelve el JSON crudo de la
 * respuesta. Cualquier fallo sale como Error con isApiFailure = true, para
 * que el clasificador pueda distinguir "no pude hablar con el modelo" de
 * "el modelo respondió algo que no entiendo".
 * @param {object} body
 * @param {{ timeoutMs?: number }} [options]
 */
async function postChatCompletion(body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiKey = requireApiKey();

  for (let attempt = 1; ; attempt++) {
    try {
      return await postChatCompletionOnce(body, apiKey, timeoutMs);
    } catch (err) {
      if (!isTransientError(err) || attempt >= TRANSIENT_MAX_ATTEMPTS) throw err;
      console.warn(
        `OpenRouter: fallo transitorio (${err.status || err.message}); se reintenta una vez en ${TRANSIENT_RETRY_DELAY_MS} ms.`
      );
      await sleep(TRANSIENT_RETRY_DELAY_MS);
    }
  }
}

/** Un solo intento: la request con su timeout (AbortController). Marca `transient` en red y timeout. */
async function postChatCompletionOnce(body, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  let data;
  try {
    res = await fetch(getChatCompletionsUrl(), {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // Un cuerpo ilegible es {} (el status decide abajo); un abort en medio
    // de la lectura del cuerpo es un timeout como cualquier otro.
    data = await res.json().catch((err) => {
      if (controller.signal.aborted) throw err;
      return {};
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error(`OpenRouter no respondió en ${timeoutMs} ms`);
      e.userMessage = 'El servicio de análisis (OpenRouter) tardó demasiado en responder. Intentá de nuevo en unos minutos.';
      e.transient = true;
      throw mapOpenRouterError(e);
    }
    // Falla de red / DNS: nunca llegamos a hablar con el modelo.
    const e = mapOpenRouterError(err);
    e.transient = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw mapOpenRouterHttpError(res.status, data);
  return data;
}

async function requestStructuredAnalysis({
  system,
  userPrompt,
  schema,
  schemaName,
  model: modelOverride,
  jsonFallback = false,
  maxTokens = 8000,
  timeoutMs,
}) {
  const model = (modelOverride || '').trim() || getAnalysisModel('openrouter');

  const schemaBody = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName || 'analisis_instagram',
        strict: true,
        schema: schema || ANALYSIS_JSON_SCHEMA,
      },
    },
  };

  const jsonObjectBody = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  };

  try {
    return await runStructuredAttempts(schemaBody, timeoutMs);
  } catch (err) {
    const msg = `${err.message || ''} ${err.userMessage || ''}`;
    if (jsonFallback && /structured|json_schema|response_format/i.test(msg)) {
      console.warn('OpenRouter json_schema no soportado en este modelo; reintento con json_object.');
      return runStructuredAttempts(jsonObjectBody, timeoutMs);
    }
    throw err;
  }
}

async function runStructuredAttempts(body, timeoutMs) {
  let lastError;
  let usage = null;
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const data = await postChatCompletion(body, { timeoutMs });

      const callUsage = fromOpenRouterUsage(data.usage);
      if (callUsage) usage = usage ? addTokenUsage(usage, callUsage) : callUsage;

      const parsed = parseMessageContent(data);
      if (parsed != null) {
        return { parsed, usage, attempts: attempt };
      }
      lastError = new Error('contenido vacío o JSON inválido');
    } catch (err) {
      lastError = err;
      if (err.userMessage && !/structured|json_schema|response_format/i.test(err.userMessage)) {
        throw err;
      }
      console.warn(
        `OpenRouter structured output intento ${attempt}/${STRUCTURED_OUTPUT_MAX_ATTEMPTS} falló:`,
        err.message
      );
      if (attempt === STRUCTURED_OUTPUT_MAX_ATTEMPTS) {
        throw err.userMessage ? err : mapOpenRouterError(lastError);
      }
    }
  }

  const e = new Error(`Structured output falló: ${lastError?.message || 'desconocido'}`);
  e.userMessage =
    'El servicio de análisis no devolvió un resultado válido. Intentá de nuevo en unos minutos.';
  throw e;
}

/**
 * Texto plano, sin schema — subcategoría de reclamos e importador. No
 * reintenta ni traga errores: quien llama decide qué hacer.
 * @returns {Promise<{ text: string, usage: import('./usage').TokenUsage | null }>}
 */
async function requestText({ system, userPrompt, maxTokens = 200, timeoutMs }) {
  const model = getAnalysisModel('openrouter');

  const data = await postChatCompletion(
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    },
    { timeoutMs }
  );

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
    const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      return JSON.parse(unfenced);
    } catch {
      const start = unfenced.indexOf('{');
      const end = unfenced.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(unfenced.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
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
