// ==========================================================================
// accountRegistry.js
// --------------------------------------------------------------------------
// Persistencia de @usuario → accountType entre análisis.
// Opción B: todos los comentarios van a Claude (sentiment + reclamosGeo);
// el accountType de cuentas registradas se fija acá después del LLM.
// ==========================================================================

const fs = require('fs/promises');
const path = require('path');

const REGISTRY_VERSION = 1;

/** Tipos válidos (mismo enum que analysisSchema / prompt). */
const VALID_ACCOUNT_TYPES = new Set(['oficial', 'periodista', 'opositor', 'vecino', 'ruido']);

function defaultRegistryPath() {
  if (process.env.ACCOUNT_REGISTRY_PATH) {
    return path.resolve(process.env.ACCOUNT_REGISTRY_PATH);
  }
  return path.join(__dirname, '..', 'data', 'account-types.json');
}

/** Clave estable: sin @, minúsculas. */
function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return '';
  return username.replace(/^@+/, '').trim().toLowerCase();
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, accounts: {} };
}

/** Carga el JSON; si no existe, devuelve registro vacío. */
async function loadAccountRegistry(filePath = defaultRegistryPath()) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.accounts !== 'object') {
      return emptyRegistry();
    }
    return { version: REGISTRY_VERSION, accounts: data.accounts };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyRegistry();
    console.warn('No se pudo leer account-types.json:', err.message);
    return emptyRegistry();
  }
}

/** Guarda el registro entero: a un temporal y después renombra, así nunca queda un JSON a medias. */
async function saveAccountRegistry(registry, filePath = defaultRegistryPath()) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const payload = {
    version: REGISTRY_VERSION,
    accounts: registry.accounts || {},
  };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

// Las actualizaciones van de a una: cada una relee el archivo, le aplica lo
// suyo y lo guarda. Dos análisis en curso a la vez no se pisan las cuentas.
let colaDelRegistro = Promise.resolve();

/**
 * Relee el registro, le aplica `apply` y lo guarda, de a una actualización
 * por vez. Si el archivo existe pero no se puede leer como JSON, no guarda
 * nada (guardar ahí reemplazaría todo el registro por lo de una corrida).
 * @param {(registry: { version: number, accounts: object }) => void} apply
 */
function updateAccountRegistry(apply, filePath = defaultRegistryPath()) {
  const paso = colaDelRegistro.then(async () => {
    let registry = emptyRegistry();
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (data && typeof data === 'object' && data.accounts && typeof data.accounts === 'object') {
        registry = { version: REGISTRY_VERSION, accounts: data.accounts };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`No se pudo leer account-types.json; no se guarda nada para no pisarlo: ${err.message}`);
        return;
      }
    }
    apply(registry);
    await saveAccountRegistry(registry, filePath);
  });
  colaDelRegistro = paso.catch(() => {});
  return paso;
}

function getRegisteredAccountType(registry, username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  const entry = registry.accounts[key];
  if (!entry || !VALID_ACCOUNT_TYPES.has(entry.accountType)) return null;
  return entry.accountType;
}

/**
 * Cuántos comentarios de la muestra tienen @usuario en el registro (solo métrica/meta).
 */
function countRegisteredInSample(sample, registry) {
  let n = 0;
  for (const c of sample) {
    if (getRegisteredAccountType(registry, c?.username)) n += 1;
  }
  return n;
}

/**
 * Bloque del user prompt: Claude clasifica sentiment/reclamos pero no cambia accountType.
 */
function formatKnownAccountTypesPromptBlock(sample, registry) {
  const lines = [];
  for (let i = 0; i < sample.length; i++) {
    const username = sample[i]?.username;
    const accountType = getRegisteredAccountType(registry, username);
    if (!accountType) continue;
    lines.push(
      `- Ítem ${i + 1} (@${username}): accountType fijo "${accountType}" (registro). Clasificá igual sentiment y reclamosGeo del texto.`
    );
  }
  if (lines.length === 0) return '';
  return `
=== CUENTAS CON TIPO REGISTRADO (accountType fijo; sentiment vía análisis del comentario) ===
${lines.join('\n')}
`;
}

/**
 * Post-LLM: el registro gana sobre accountType; sentiment/reclamosGeo vienen del modelo.
 */
function applyRegistryAccountTypes(sample, classifications, registry) {
  return classifications.map((row, i) => {
    if (row.sentiment === 'ruido' || row.accountType === 'ruido') {
      return { ...row, sentiment: 'ruido', accountType: 'ruido', reclamosGeo: [] };
    }
    const registered = getRegisteredAccountType(registry, sample[i]?.username);
    if (registered) {
      return { ...row, accountType: registered };
    }
    return row;
  });
}

/**
 * Persiste tipos tras cada análisis (solo cuentas nuevas; las conocidas no se pisan).
 */
function recordAccountTypesFromRun(sample, classifications, registry) {
  const now = new Date().toISOString();
  let newlyRecorded = 0;
  let knownHits = 0;

  for (let i = 0; i < sample.length; i++) {
    const key = normalizeUsername(sample[i]?.username);
    if (!key) continue;

    const row = classifications[i];
    if (!row) continue;

    const existing = registry.accounts[key];
    const wasKnown = Boolean(existing?.accountType);

    if (wasKnown) {
      if (row.sentiment !== 'ruido') {
        existing.lastSeenAt = now;
        existing.seenCount = (existing.seenCount || 0) + 1;
        knownHits += 1;
      }
      continue;
    }

    if (row.sentiment === 'ruido' || row.accountType === 'ruido') {
      continue;
    }

    if (!VALID_ACCOUNT_TYPES.has(row.accountType)) {
      continue;
    }

    registry.accounts[key] = {
      accountType: row.accountType,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
    };
    newlyRecorded += 1;
  }

  return { newlyRecorded, knownHits };
}

module.exports = {
  loadAccountRegistry,
  saveAccountRegistry,
  updateAccountRegistry,
  normalizeUsername,
  getRegisteredAccountType,
  countRegisteredInSample,
  formatKnownAccountTypesPromptBlock,
  applyRegistryAccountTypes,
  recordAccountTypesFromRun,
  defaultRegistryPath,
};
