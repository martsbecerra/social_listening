// ==========================================================================
// providerConfig.js — Selección de proveedor/modelo vía .env
// --------------------------------------------------------------------------
// Un solo lugar decide QUÉ proveedor y QUÉ modelo se usa. Desde septiembre
// 2026 hay UN solo modelo para todo el LLM: el análisis de comentarios de
// una publicación (src/llm/index.js), la clasificación del monitoreo
// (src/classifier.js), la subcategoría de reclamos (src/clasificarReclamo.js)
// y el importador (src/importers/extraerDireccion.js). Antes el monitoreo
// usaba un "modelo clasificador" aparte, más barato (Haiku), configurado con
// CLASSIFIER_MODEL / OPENROUTER_CLASSIFIER_MODEL: se eliminó porque la
// clasificación con contexto geográfico necesita el mismo criterio que el
// análisis y el costo de LLM no es el cuello de botella (Apify sí). Si esas
// variables siguen en el .env, warnObsoleteModelVars avisa al arrancar.
//
// La regla es que cambiar LLM_PROVIDER NO cambia qué modelo se usa: es el
// mismo modelo, sólo cambia el formato del identificador según el proveedor
// (OpenRouter prefija con "anthropic/"). Los defaults mantienen ese mapeo 1:1.
// ==========================================================================

const VALID_PROVIDERS = ['anthropic', 'openrouter'];

/**
 * Modelo por defecto en cada proveedor. Las dos entradas son el MISMO modelo
 * escrito en el formato de cada API — verificado contra
 * https://openrouter.ai/api/v1/models (ambos soportan structured_outputs).
 */
const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5',
  openrouter: 'anthropic/claude-sonnet-5',
};

/** Variable de .env que pisa el default, por proveedor. */
const MODEL_ENV_KEYS = {
  anthropic: 'CLAUDE_MODEL',
  openrouter: 'OPENROUTER_MODEL',
};

/** Variables del modelo clasificador que ya no existe: se ignoran con aviso. */
const OBSOLETE_MODEL_ENV_KEYS = ['CLASSIFIER_MODEL', 'OPENROUTER_CLASSIFIER_MODEL'];

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
 * El modelo del proveedor activo (el único: análisis, clasificador del
 * monitoreo, reclamos e importador).
 */
function getAnalysisModel(provider = getLlmProvider()) {
  const fromEnv = (process.env[MODEL_ENV_KEYS[provider]] || '').trim();
  return fromEnv || DEFAULT_MODELS[provider];
}

/**
 * Avisa (una vez, al arrancar) si el .env todavía tiene las variables del
 * modelo clasificador que se eliminó. No abortan el arranque: no hay
 * ambigüedad sobre qué modelo se usa, solo una variable que ya no hace nada.
 * @param {(mensaje: string) => void} [log]
 * @returns {string[]} las variables obsoletas que están seteadas
 */
function warnObsoleteModelVars(log = console.warn) {
  const seteadas = OBSOLETE_MODEL_ENV_KEYS.filter((key) => (process.env[key] || '').trim() !== '');
  if (seteadas.length > 0) {
    log(
      `[llm] ${seteadas.join(' y ')} ya no se usa${seteadas.length > 1 ? 'n' : ''}: desde septiembre 2026 ` +
      'todo el LLM (análisis, clasificador del monitoreo, reclamos e importador) usa el modelo de análisis ' +
      '(CLAUDE_MODEL con anthropic, OPENROUTER_MODEL con openrouter). Borrala del .env.'
    );
  }
  return seteadas;
}

/** Claves requeridas según LLM_PROVIDER activo. */
function requiredLlmEnvKeys(provider = getLlmProvider()) {
  if (provider === 'openrouter') return ['OPENROUTER_API_KEY'];
  return ['ANTHROPIC_API_KEY'];
}

module.exports = {
  getLlmProvider,
  getProviderLabel,
  getAnalysisModel,
  warnObsoleteModelVars,
  requiredLlmEnvKeys,
  VALID_PROVIDERS,
  DEFAULT_MODELS,
  OBSOLETE_MODEL_ENV_KEYS,
};
