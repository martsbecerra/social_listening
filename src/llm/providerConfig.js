// ==========================================================================
// providerConfig.js — Selección de proveedor/modelo vía .env
// --------------------------------------------------------------------------
// Un solo lugar decide QUÉ proveedor y QUÉ modelo se usa en cada tarea. Las
// dos tareas del sistema son:
//   - analysis:   análisis de comentarios de una publicación (src/llm/index.js)
//   - classifier: relevancia + sentimiento del monitoreo (src/classifier.js)
//
// La regla es que cambiar LLM_PROVIDER NO cambia qué modelo se usa en cada
// tarea: son los mismos dos modelos, sólo cambia el formato del identificador
// según el proveedor (OpenRouter prefija con "anthropic/" y usa punto en la
// versión). Los defaults de abajo mantienen ese mapeo 1:1.
// ==========================================================================

const VALID_PROVIDERS = ['anthropic', 'openrouter'];

/**
 * Modelo por defecto de cada tarea en cada proveedor. Las dos columnas son el
 * MISMO modelo escrito en el formato de cada API — verificado contra
 * https://openrouter.ai/api/v1/models (ambos soportan structured_outputs).
 */
const DEFAULT_MODELS = {
  anthropic: {
    analysis: 'claude-sonnet-5',
    classifier: 'claude-haiku-4-5',
  },
  openrouter: {
    analysis: 'anthropic/claude-sonnet-5',
    classifier: 'anthropic/claude-haiku-4.5',
  },
};

/** Variable de .env que pisa el default, por proveedor y tarea. */
const MODEL_ENV_KEYS = {
  anthropic: {
    analysis: 'CLAUDE_MODEL',
    classifier: 'CLASSIFIER_MODEL',
  },
  openrouter: {
    analysis: 'OPENROUTER_MODEL',
    classifier: 'OPENROUTER_CLASSIFIER_MODEL',
  },
};

/**
 * Un LLM_PROVIDER con un valor que no entendemos NO puede caer en un default
 * en silencio: significaría facturarle a un proveedor distinto del que se
 * quiso configurar. Tira error con la lista de valores válidos.
 */
function normalizeProvider(raw) {
  if (raw == null || String(raw).trim() === '') return 'anthropic';

  const p = String(raw).trim().toLowerCase();
  const canonical = p === 'open-router' ? 'openrouter' : p;

  if (!VALID_PROVIDERS.includes(canonical)) {
    const e = new Error(
      `LLM_PROVIDER="${raw}" no es un proveedor válido. ` +
      `Valores aceptados: ${VALID_PROVIDERS.join(', ')} (dejalo vacío para usar "anthropic").`
    );
    e.userMessage = e.message;
    throw e;
  }
  return canonical;
}

function getLlmProvider() {
  return normalizeProvider(process.env.LLM_PROVIDER);
}

function getProviderLabel(provider) {
  return provider === 'openrouter' ? 'OpenRouter' : 'Claude';
}

/**
 * Modelo a usar para una tarea, con el proveedor activo.
 * @param {'analysis' | 'classifier'} task
 */
function getModelFor(task, provider = getLlmProvider()) {
  const envKey = MODEL_ENV_KEYS[provider][task];
  const fromEnv = (process.env[envKey] || '').trim();
  return fromEnv || DEFAULT_MODELS[provider][task];
}

function getAnalysisModel(provider = getLlmProvider()) {
  return getModelFor('analysis', provider);
}

function getClassifierModel(provider = getLlmProvider()) {
  return getModelFor('classifier', provider);
}

/** Claves requeridas según LLM_PROVIDER activo. */
function requiredLlmEnvKeys(provider = getLlmProvider()) {
  if (provider === 'openrouter') return ['OPENROUTER_API_KEY'];
  return ['ANTHROPIC_API_KEY'];
}

module.exports = {
  getLlmProvider,
  getProviderLabel,
  getModelFor,
  getAnalysisModel,
  getClassifierModel,
  requiredLlmEnvKeys,
  VALID_PROVIDERS,
  DEFAULT_MODELS,
};
