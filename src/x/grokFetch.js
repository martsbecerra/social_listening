// ==========================================================================
// grokFetch.js — Trae el hilo de un posteo de X con Grok (X Search).
// Preferencia: OpenRouter (misma OPENROUTER_API_KEY; X Search nativo de
// Grok). Respaldo: API directa de xAI (XAI_API_KEY).
// No redacta el reporte WhatsApp: solo JSON del post + replies + QTs.
// ==========================================================================

const { parseXPostUrl } = require('./url');
const { normalizeThread, hasPostMetrics } = require('./threadNormalize');
const { fromOpenRouterUsage } = require('../llm/usage');
const { getOpenRouterXModel, getDirectXaiModel, DEFAULT_OPENROUTER_X_MODEL } = require('./grokModel');

const DEFAULT_XAI_BASE = 'https://api.x.ai/v1';
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function getOpenRouterBaseUrl() {
  const raw = (process.env.OPENROUTER_BASE_URL || '').trim() || DEFAULT_OPENROUTER_BASE;
  return raw.replace(/\/+$/, '');
}

function getXaiBaseUrl() {
  const raw = (process.env.XAI_BASE_URL || '').trim() || DEFAULT_XAI_BASE;
  return raw.replace(/\/+$/, '');
}

function openRouterGrokModel() {
  return getOpenRouterXModel();
}

function xaiGrokModel() {
  return getDirectXaiModel();
}

/**
 * OpenRouter primero (créditos que ya usa la app). xAI directo solo si no
 * hay OPENROUTER_API_KEY.
 * @returns {{ backend: 'openrouter'|'xai', apiKey: string, baseUrl: string, model: string }}
 */
function getFetchConfig() {
  const orKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (orKey) {
    return {
      backend: 'openrouter',
      apiKey: orKey,
      baseUrl: getOpenRouterBaseUrl(),
      model: openRouterGrokModel(),
    };
  }

  const xaiKey = (process.env.XAI_API_KEY || '').trim();
  if (xaiKey) {
    return {
      backend: 'xai',
      apiKey: xaiKey,
      baseUrl: getXaiBaseUrl(),
      model: xaiGrokModel(),
    };
  }

  const e = new Error('Falta clave para Grok (OPENROUTER_API_KEY o XAI_API_KEY)');
  e.userMessage =
    'Para analizar X hace falta OPENROUTER_API_KEY (Grok vía OpenRouter) o XAI_API_KEY. Completá el .env e intentá de nuevo.';
  throw e;
}

function getModel() {
  try {
    return getFetchConfig().model;
  } catch {
    return openRouterGrokModel();
  }
}

function getFetchBackend() {
  try {
    return getFetchConfig().backend;
  } catch {
    return null;
  }
}

function buildFetchPrompt(url, postId) {
  return `Usá X Search / thread fetch para leer este posteo de X y su hilo (respuestas directas y tweets citados / QTs del post original). No uses la web genérica: solo X.

URL: ${url}
ID: ${postId}

Devolvé ÚNICAMENTE un JSON válido (sin markdown, sin reporte WhatsApp) con esta forma:
{
  "post": {
    "id": "string",
    "url": "string",
    "authorName": "string",
    "authorHandle": "string sin @",
    "text": "string",
    "likes": 0,
    "retweets": 0,
    "quotes": 0,
    "replies": 0,
    "bookmarks": 0,
    "views": 0,
    "createdAt": "ISO-8601 o vacío"
  },
  "items": [
    {
      "id": "string",
      "url": "string",
      "kind": "reply o quote",
      "authorName": "string",
      "authorHandle": "string",
      "text": "string",
      "likes": 0,
      "retweets": 0,
      "quotes": 0,
      "replies": 0,
      "views": 0,
      "inReplyToId": "string o vacío",
      "quotedId": "id del post citado, si kind=quote",
      "createdAt": "string"
    }
  ],
  "threadComplete": true
}

Reglas:
- Números enteros, sin sufijos K/M.
- items: solo respuestas DIRECTAS al post o QTs que citan el post original. Prohibido QT de QT.
- url de cada ítem: https://x.com/{handle}/status/{id} (no t.co ni i/web/status).
- Si no pudiste leer el post, devolvé post en null.
- threadComplete=false si el hilo está incompleto.`;
}

function extractOutputText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const chunks = [];
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string') chunks.push(part.text);
        else if (typeof part?.output_text === 'string') chunks.push(part.output_text);
      }
    }
    if (typeof item?.content === 'string') chunks.push(item.content);
  }
  if (chunks.length) return chunks.join('\n');
  const choice = data.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) {
    return choice.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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

function usageFromXai(data) {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.input_tokens ?? u.prompt_tokens) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total, costSource: 'xai' };
}

function mapFetchError(backend, err, status, body) {
  const msg = body?.error?.message || err?.message || 'error desconocido';
  const label = backend === 'openrouter' ? 'OpenRouter/Grok' : 'xAI';
  console.error(`Error llamando a ${label}:`, status || '', msg);
  const e = new Error(`${label} falló: ${msg}`);
  if (status === 401 || status === 403) {
    e.userMessage =
      backend === 'openrouter'
        ? 'La clave de OpenRouter (OPENROUTER_API_KEY) es inválida. Revisá el archivo .env.'
        : 'La clave de xAI (XAI_API_KEY) es inválida. Revisá el archivo .env.';
  } else if (status === 429) {
    e.userMessage = `${label} rechazó el pedido por rate limit. Esperá un momento e intentá de nuevo.`;
  } else {
    e.userMessage = 'No se pudo leer el hilo de X con Grok. Intentá de nuevo en unos minutos.';
  }
  return e;
}

function openRouterHeaders(apiKey) {
  const port = process.env.PORT || 3000;
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': (process.env.OPENROUTER_HTTP_REFERER || '').trim() || `http://localhost:${port}`,
    'X-Title': (process.env.OPENROUTER_APP_NAME || '').trim() || 'Social Listening App',
  };
}

async function postJson(url, { apiKey, backend, body }) {
  const headers =
    backend === 'openrouter'
      ? openRouterHeaders(apiKey)
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  let res;
  let data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    throw mapFetchError(backend, err);
  }
  if (!res.ok) throw mapFetchError(backend, null, res.status, data);
  return data;
}

async function callGrokJson(prompt, { maxTokens = 16000 } = {}) {
  const cfg = getFetchConfig();

  let data;
  let usage;
  if (cfg.backend === 'openrouter') {
    data = await postJson(`${cfg.baseUrl}/chat/completions`, {
      apiKey: cfg.apiKey,
      backend: 'openrouter',
      body: {
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'openrouter:web_search' }],
      },
    });
    usage = fromOpenRouterUsage(data.usage);
  } else {
    data = await postJson(`${cfg.baseUrl}/responses`, {
      apiKey: cfg.apiKey,
      backend: 'xai',
      body: {
        model: cfg.model,
        input: [{ role: 'user', content: prompt }],
        tools: [{ type: 'x_search' }],
      },
    });
    usage = usageFromXai(data);
  }

  const text = extractOutputText(data);
  const parsed = extractJsonObject(text);
  return { parsed, usage, rawText: text, backend: cfg.backend, model: cfg.model };
}

async function callGrokFetch(url, postId) {
  const { parsed, usage, rawText, backend, model } = await callGrokJson(
    buildFetchPrompt(url, postId),
    { maxTokens: 16000 }
  );
  if (!parsed) {
    const e = new Error('Grok no devolvió JSON del hilo');
    e.userMessage =
      'Grok no pudo devolver el hilo en un formato usable. Probá de nuevo o con otro posteo.';
    throw e;
  }
  return { parsed, usage, rawText, backend, model };
}

/**
 * @param {string} url
 * @returns {Promise<{ post: object, items: Array, usage: object|null, threadComplete: boolean }>}
 */
async function fetchXThread(url) {
  const parsedUrl = parseXPostUrl(url);
  if (!parsedUrl) {
    const e = new Error('URL de X inválida');
    e.userMessage =
      'Ingresá un link válido de una publicación de X (por ejemplo: https://x.com/usuario/status/123).';
    throw e;
  }

  const { parsed, usage } = await callGrokFetch(url.trim(), parsedUrl.id);
  const thread = normalizeThread(parsed, url.trim());

  if (!thread.post || !hasPostMetrics(thread.post)) {
    const e = new Error('Hilo de X sin métricas');
    e.userMessage =
      'No se pudieron leer las métricas de esa publicación en X. Probá con otro posteo o más tarde.';
    e.statusCode = 422;
    throw e;
  }

  if (!thread.post.url) thread.post.url = url.trim();
  return {
    post: thread.post,
    items: thread.items,
    threadComplete: thread.threadComplete,
    usage,
  };
}

module.exports = {
  fetchXThread,
  callGrokJson,
  extractJsonObject,
  extractOutputText,
  getModel,
  getFetchConfig,
  getFetchBackend,
  openRouterGrokModel,
  DEFAULT_MODEL: DEFAULT_OPENROUTER_X_MODEL,
};
