// ==========================================================================
// openrouterProvider.js — Chat completions + json_schema (OpenAI-compatible).
// ==========================================================================

const { ANALYSIS_JSON_SCHEMA } = require('../analysisSchema');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 2;

async function requestStructuredAnalysis({ system, userPrompt }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const e = new Error('OPENROUTER_API_KEY no configurada');
    e.userMessage =
      'Falta OPENROUTER_API_KEY en .env. Obtené una en https://openrouter.ai/settings/keys o usá LLM_PROVIDER=anthropic.';
    throw e;
  }

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1';

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (process.env.OPENROUTER_HTTP_REFERER) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
  }
  if (process.env.OPENROUTER_APP_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME;
  }

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
  for (let attempt = 1; attempt <= STRUCTURED_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw mapOpenRouterHttpError(res.status, data);
      }

      const parsed = parseMessageContent(data);
      if (parsed != null) {
        return parsed;
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

function parseMessageContent(data) {
  const raw = data?.choices?.[0]?.message?.content;
  if (raw == null) return null;

  let text;
  if (typeof raw === 'string') {
    text = raw.trim();
  } else if (Array.isArray(raw)) {
    text = raw
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  } else {
    return null;
  }

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

  if (status === 401) {
    e.userMessage = 'La clave de OpenRouter (OPENROUTER_API_KEY) es inválida. Revisá el archivo .env.';
  } else if (status === 402 || /insufficient|credits|balance/i.test(msg)) {
    e.userMessage =
      'Tu cuenta de OpenRouter no tiene crédito suficiente. Cargá saldo en https://openrouter.ai/settings/credits e intentá de nuevo.';
  } else if (status === 429) {
    e.userMessage = 'Se alcanzó el límite de uso del modelo por el momento. Esperá unos minutos e intentá de nuevo.';
  } else if (/structured|json_schema|response_format/i.test(msg)) {
    e.userMessage =
      'El modelo configurado en OPENROUTER_MODEL no soporta salida JSON con schema. Probá openai/gpt-4.1 o google/gemini-2.5-pro.';
  } else {
    e.userMessage = 'El servicio de análisis (OpenRouter) falló. Intentá de nuevo en unos minutos.';
  }
  return e;
}

function mapOpenRouterError(err) {
  if (err.userMessage) return err;
  console.error('Error llamando a OpenRouter:', err);
  const e = new Error(`OpenRouter falló: ${err.message}`);
  e.userMessage = 'El servicio de análisis (OpenRouter) falló. Intentá de nuevo en unos minutos.';
  return e;
}

module.exports = { requestStructuredAnalysis };
