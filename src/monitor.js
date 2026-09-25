// ==========================================================================
// monitor.js
// --------------------------------------------------------------------------
// Orquestador del monitoreo, agnóstico de plataforma. Detecta posteos nuevos
// relevantes a partir de las fuentes configuradas por plataforma
// (config/monitoring.json, una sección por red), según lo que cada adapter
// declara en capabilities (detectAccounts, detectHashtags):
//   - Cuentas trackeadas: el perfil de cada una (X: `from:handle` en Grok).
//     En Instagram NO se consultan desde septiembre 2026 (detectAccounts:
//     false): son solo guía para el clasificador.
//   - Hashtags (las keywords que empiezan con "#"): la página del hashtag.
//     En Instagram tampoco se recorren (detectHashtags: false); en X son
//     una búsqueda más.
//   - Keywords planas, SOLO en las plataformas cuyo adapter sabe buscarlas
//     (scrapeKeyword, por ejemplo X). En las demás son una pista para el
//     clasificador sobre lo que trajeron las otras fuentes.
//   - Búsquedas por palabra clave (`searches`), SOLO en las plataformas
//     cuyo adapter sabe buscar (scrapeSearch: Instagram con IG_ACTOR=apidojo).
//     Desde septiembre 2026 es LA fuente de detección de Instagram: cada
//     término es una consulta cobrada por ciclo. Lo que trae lo filtra el
//     clasificador, no entra directo. La búsqueda devuelve los posteos sin
//     caption ni contadores: a los nuevos se les pide el detalle antes de
//     evaluarlos (enrichSearchResults).
//
// Un posteo se considera relevante si:
//   1. Llegó por una búsqueda por término (sourceType 'keyword': una keyword,
//      o un hashtag en las redes donde el hashtag es una búsqueda más, como
//      X) — la búsqueda ya lo validó, o
//   2. El clasificador (src/classifier.js, una sola llamada con el modelo
//      de análisis) decide que habla de Jorge Macri o de la gestión de la
//      Ciudad. La coincidencia literal con una keyword ya no es un veredicto:
//      viaja como pista de contexto junto con la cuenta trackeada, el
//      hashtag o la búsqueda, y el modelo decide con eso (desde septiembre
//      2026; antes la keyword literal daba relevancia por hecho y "Jefe de
//      Gobierno" de la Ciudad de México entraba como si fuera porteño).
//
// Todo lo específico de cada plataforma (fuente de datos, URLs, nombres de
// campos, métricas propias, qué sabe hacer) vive en su adapter de
// src/platforms/. Este módulo solo orquesta: scrapear vía adapter, evaluar
// relevancia con el clasificador compartido, dedupe contra SQLite (src/db.js,
// que decide qué es realmente "nuevo") y guardado.
//
// Errores al scrapear: una fuente que falla sola (cuenta privada, etc.) se
// loguea y el ciclo sigue. Un error de plataforma (credenciales inválidas,
// rate limit, cuota agotada — ver src/platforms/errors.js) es otra cosa: si
// la corrida era solo de esa plataforma ("Actualizar ahora" en su solapa) el
// error le llega al usuario en vez de un "0 nuevos" que parece un éxito; en
// el cron se anota en porPlataforma[id].error y se sigue con las demás.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { clasificarPosteo } = require('./classifier');
const { checkAndLogJump } = require('./viralJumpDetector');
const { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID } = require('./platforms');
const { isPlatformError } = require('./platforms/errors');
const { runWithContext } = require('./usageContext');
const progress = require('./monitoringProgress');
const db = require('./db');

// MONITORING_CONFIG_PATH: solo para tests (tempfile), mismo patrón que
// MONITORING_DB_PATH en db.js. En runtime normal es config/monitoring.json.
const CONFIG_PATH =
  process.env.MONITORING_CONFIG_PATH || path.join(__dirname, '..', 'config', 'monitoring.json');

// Config que tenía el monitoreo de X cuando era un módulo aparte
// (config/monitoring-x.json). Se absorbe UNA vez como sección "x" de
// monitoring.json (ver absorbLegacyXConfig). MONITORING_X_CONFIG_PATH queda
// solo para poder probar esa migración con un tempfile.
const LEGACY_X_CONFIG_PATH =
  process.env.MONITORING_X_CONFIG_PATH || path.join(__dirname, '..', 'config', 'monitoring-x.json');

// Columnas de detected_posts que pueden ser métricas de un adapter. Un
// adapter puede declarar más claves en `metrics`, pero al guardar/refrescar
// solo pasan las que existen en la tabla (node:sqlite rechaza parámetros
// desconocidos).
const METRIC_COLUMNS = ['likes', 'comments', 'retweets', 'views'];

// Si el mismo posteo llega por más de una fuente en la misma corrida, gana
// el origen más específico (ver el dedupe en runMonitoringCycle).
const SOURCE_PRIORITY = { keyword: 3, account: 2, hashtag: 1, search: 1 };
function sourcePriority(post) {
  return SOURCE_PRIORITY[post.sourceType] || 0;
}

// Topes de posteos por tipo de fuente en cada corrida (uno por llamada:
// cada cuenta, hashtag o búsqueda es un run aparte). Los defaults coinciden
// con los posteos incluidos en cada consulta del actor apidojo (perfil 10,
// hashtag 30, búsqueda 20 incluidos de los 50 que se piden): por encima se
// cobra por posteo. Con IG_ACTOR=apify son el resultsLimit de siempre.
// MONITOR_RESULTS_LIMIT (un solo tope para todo) ya no se usa; si sigue en
// el .env y faltan los topes nuevos, vale para cuentas y hashtags con un
// aviso, así un .env viejo se comporta igual que antes.
const DEFAULT_LIMITS = { account: 10, hashtag: 30, search: 50 };
let warnedLegacyLimit = false;

function positiveInt(raw) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** @returns {{ account: number, hashtag: number, search: number }} se lee en cada ciclo, no al cargar. */
function monitorLimits() {
  const legacy = positiveInt(process.env.MONITOR_RESULTS_LIMIT);
  const account = positiveInt(process.env.MONITOR_ACCOUNT_LIMIT);
  const hashtag = positiveInt(process.env.MONITOR_HASHTAG_LIMIT);
  const search = positiveInt(process.env.SEARCH_RESULTS_LIMIT);
  if (legacy && (!account || !hashtag) && !warnedLegacyLimit) {
    warnedLegacyLimit = true;
    console.warn(
      `[monitor] MONITOR_RESULTS_LIMIT=${legacy} quedó reemplazado por MONITOR_ACCOUNT_LIMIT y MONITOR_HASHTAG_LIMIT; ` +
        `mientras falten, se usa ${legacy} para cuentas y hashtags.`
    );
  }
  return {
    account: account || legacy || DEFAULT_LIMITS.account,
    hashtag: hashtag || legacy || DEFAULT_LIMITS.hashtag,
    search: search || DEFAULT_LIMITS.search,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Techo de la ventana de detección dinámica (ver detectionWindowFor): nunca
// se pide más atrás que esto, ni siquiera después de una caída larga del
// server, para no disparar una recuperación gigante (y su costo).
const DEFAULT_LOOKBACK_MAX_DAYS = 7;
// La ventana dinámica sube MONITOR_ACCOUNT_LIMIT/MONITOR_HASHTAG_LIMIT
// proporcionalmente cuando supera 1 día (ver raiseLimitForWindow), pero
// nunca más de esta cantidad de veces el tope configurado: pasado ese
// punto, una cuenta o hashtag que sigue topeando probablemente satura el
// feed igual, y seguir subiendo el tope solo dispara costo sin traer más
// señal real.
const RAISE_LIMIT_CEILING_FACTOR = 5;

/** "7 days", "2 hours", "10 days", ... a milisegundos; inválido o ausente cae a `fallbackMs`. */
function parseWindowMs(raw, fallbackMs) {
  const m = String(raw ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|days?|weeks?)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const unitMs = unit.startsWith('min') ? 60 * 1000 : unit.startsWith('hour') ? 60 * 60 * 1000 : unit.startsWith('week') ? 7 * DAY_MS : DAY_MS;
  return n > 0 ? n * unitMs : fallbackMs;
}

/** MONITOR_LOOKBACK_MAX a milisegundos (default 7 días): el techo de la ventana. */
function parseLookbackMaxMs(raw) {
  return parseWindowMs(raw, DEFAULT_LOOKBACK_MAX_DAYS * DAY_MS);
}

/** MONITOR_LOOKBACK a milisegundos (default 1 día): la ventana de la primera corrida. */
function parseFirstRunLookbackMs(raw) {
  return parseWindowMs(raw, DAY_MS);
}

/**
 * Ventana de detección dinámica de una plataforma: en Instagram la usan las
 * búsquedas por palabra clave (la única fuente de detección); en X, cuentas
 * y hashtags. Las keywords de X y el benchmark NO: siguen con su lógica de
 * siempre. Va desde el fin de la última detección exitosa de esa plataforma
 * (`detection_last_success:<platformId>` en refresh_state, ver
 * runMonitoringCycle) hasta `now`, con un techo de MONITOR_LOOKBACK_MAX
 * (default 7 días) para que una caída larga no dispare una recuperación
 * gigante (y su costo). Sin ninguna corrida previa registrada, la ventana
 * es MONITOR_LOOKBACK (default 1 día): la primera corrida mira un día hacia
 * atrás, no una semana. Redondeada hacia arriba a días enteros, mínimo 1:
 * en el caso normal (cron al día) da exactamente "1 day" — el techo solo se
 * nota después de una caída real. Se manda en días enteros, nunca
 * fracciones de hora: `apify/instagram-scraper` recibe este string tal cual
 * en `onlyPostsNewerThan` y no hay garantía de que entienda horas
 * fraccionarias; apidojo igual refiltra por milisegundos exactos
 * (`applyWindow` en instagramApidojo.js), así que ahí no se pierde precisión.
 *
 * @param {string} platformId
 * @param {{ now?: number }} [options] `now` inyectable para tests (reloj fijo).
 * @returns {{ lookback: string, windowDays: number, isDefault: boolean, sinceIso: string }}
 */
function detectionWindowFor(platformId, { now = Date.now() } = {}) {
  const maxMs = parseLookbackMaxMs(process.env.MONITOR_LOOKBACK_MAX);
  const ceilingMs = now - maxMs;
  const lastSuccessRaw = db.getRefreshState(`detection_last_success:${platformId}`);
  const lastSuccessMs = lastSuccessRaw ? Date.parse(lastSuccessRaw) : NaN;
  const firstRunMs = now - parseFirstRunLookbackMs(process.env.MONITOR_LOOKBACK);
  const sinceMs = Math.max(ceilingMs, Number.isFinite(lastSuccessMs) ? lastSuccessMs : firstRunMs);
  const windowDays = Math.max(1, Math.ceil((now - sinceMs) / DAY_MS));
  // Singular en 1 para que el caso normal (cron al día) sea BYTE A BYTE el
  // mismo string que el fijo de antes ("1 day"); parseLookbackMs entiende
  // los dos igual (la "s" del plural es opcional en su regex).
  return {
    lookback: `${windowDays} day${windowDays === 1 ? '' : 's'}`,
    windowDays,
    isDefault: windowDays === 1,
    sinceIso: new Date(sinceMs).toISOString(),
  };
}

/**
 * Sube un tope (MONITOR_ACCOUNT_LIMIT o MONITOR_HASHTAG_LIMIT) para que una
 * ventana de detección más ancha que la default no pierda posteos por el
 * tope de cantidad en vez de por fecha. Ver RAISE_LIMIT_CEILING_FACTOR.
 */
function raiseLimitForWindow(baseLimit, windowDays) {
  const factor = Math.min(Math.max(1, windowDays), RAISE_LIMIT_CEILING_FACTOR);
  return Math.round(baseLimit * factor);
}

// Enriquecimiento de los resultados de búsqueda (ver enrichSearchResults):
// cuántos detalles de posteo se piden como mucho por ciclo y plataforma
// (SEARCH_ENRICH_LIMIT; 0 lo apaga) y cuánto se recuerda un resultado ya
// consultado (tabla search_seen).
const DEFAULT_SEARCH_ENRICH_LIMIT = 20;
const SEARCH_SEEN_TTL_DAYS = 30;

/** @returns {number} se lee en cada ciclo, no al cargar. Un valor inválido vale el default. */
function searchEnrichLimit() {
  const raw = process.env.SEARCH_ENRICH_LIMIT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SEARCH_ENRICH_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SEARCH_ENRICH_LIMIT;
}

/**
 * Las cuentas son simplemente el nombre de usuario. Acepta también el
 * formato { username, onlyIfKeywordMatch } que se usó brevemente, por si
 * quedó algo sin migrar en el archivo.
 */
function normalizeAccount(entry) {
  return typeof entry === 'string' ? entry : entry.username;
}

function cleanList(list) {
  return (Array.isArray(list) ? list : []).map((v) => String(v).trim()).filter(Boolean);
}

/**
 * config/monitoring.json tiene tres formatos posibles:
 *   - Actual (secciones por plataforma): { instagram: { accounts: [...],
 *     keywords: [...] }, x: { ... } }. Es el único que escribe saveConfig().
 *   - Plano (anterior): { accounts: [...], keywords: [...] } en la raíz —
 *     era todo Instagram implícitamente.
 *   - Legacy (anidado): { instagram: { accounts, hashtags, keywords:
 *     {categoría: [...]} } }. Las keywords venían agrupadas por categoría y
 *     los hashtags aparte, sin el "#" — solo para que el archivo se pudiera
 *     leer y mantener a mano. Se distingue del actual porque sus keywords
 *     son un OBJETO, no un array.
 * Los dos formatos viejos se migran al actual UNA sola vez (se reescribe el
 * archivo); si ya está en formato actual no se toca nada — la migración es
 * idempotente. Devuelve siempre { plataforma: { accounts, keywords } }.
 */
function readConfigAll() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  // Formato plano: accounts/keywords como arrays en la raíz.
  if (Array.isArray(parsed.accounts) || Array.isArray(parsed.keywords)) {
    const section = {
      accounts: (Array.isArray(parsed.accounts) ? parsed.accounts : []).map(normalizeAccount),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    };
    const all = { [DEFAULT_PLATFORM_ID]: section };
    saveConfig(all);
    console.log(
      `[monitor] config migrado al formato por plataforma (plano -> secciones): ` +
        `accounts ${parsed.accounts?.length ?? 0} -> ${section.accounts.length}, ` +
        `keywords ${parsed.keywords?.length ?? 0} -> ${section.keywords.length}`
    );
    return all;
  }

  // Legacy anidado: instagram.keywords es un objeto por categoría (no array).
  if (parsed.instagram && !Array.isArray(parsed.instagram.keywords)) {
    const ig = parsed.instagram;
    const keywordGroups = ig.keywords || {};
    const groupCount = Object.values(keywordGroups).flat().length;
    const hashtagCount = Array.isArray(ig.hashtags) ? ig.hashtags.length : 0;
    const section = {
      accounts: (Array.isArray(ig.accounts) ? ig.accounts : []).map(normalizeAccount),
      keywords: [
        ...Object.values(keywordGroups).flat(),
        // A un hashtag "JorgeMacri" se le vuelve a poner el "#" adelante para
        // que el filter(k => k.startsWith('#')) lo siga reconociendo.
        ...(Array.isArray(ig.hashtags) ? ig.hashtags.map((h) => `#${h}`) : []),
      ],
    };
    const all = { [DEFAULT_PLATFORM_ID]: section };
    saveConfig(all);
    console.log(
      `[monitor] config migrado al formato por plataforma (legacy anidado -> secciones): ` +
        `accounts ${ig.accounts?.length ?? 0} -> ${section.accounts.length}, ` +
        `keywords ${groupCount}+${hashtagCount} hashtags -> ${section.keywords.length}`
    );
    return all;
  }

  // Formato actual: cada clave de la raíz es una sección de plataforma.
  // `searches` (búsquedas por palabra clave) es opcional: solo existe en
  // las secciones donde alguien agregó un término (ver addSearch); las
  // demás no se tocan.
  const all = {};
  for (const [platformId, section] of Object.entries(parsed)) {
    all[platformId] = {
      accounts: (Array.isArray(section.accounts) ? section.accounts : []).map(normalizeAccount),
      keywords: Array.isArray(section.keywords) ? section.keywords : [],
      ...(Array.isArray(section.searches) ? { searches: cleanList(section.searches) } : {}),
    };
  }
  return all;
}

/**
 * Migración única del config que X tenía cuando era un módulo aparte:
 * si todavía no hay sección "x" y existe el archivo viejo, se copia como
 * sección "x", se guarda monitoring.json y el archivo viejo se renombra a
 * ".migrado" (queda como respaldo, ya no se lee). Idempotente: la segunda
 * vez no hay archivo viejo y no pasa nada. Nunca tira: un archivo viejo
 * roto se avisa y se ignora.
 */
function absorbLegacyXConfig(all) {
  if (all.x || !fs.existsSync(LEGACY_X_CONFIG_PATH)) return all;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LEGACY_X_CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[monitor] no se pudo leer ${LEGACY_X_CONFIG_PATH} para migrarlo:`, err.message);
    return all;
  }
  all.x = { accounts: cleanList(parsed.accounts), keywords: cleanList(parsed.keywords) };
  saveConfig(all);
  const migrated = `${LEGACY_X_CONFIG_PATH}.migrado`;
  try {
    fs.renameSync(LEGACY_X_CONFIG_PATH, migrated);
  } catch (err) {
    console.warn(`[monitor] config de X absorbida, pero no se pudo renombrar el archivo viejo:`, err.message);
  }
  console.log(
    `[monitor] config de X absorbida como sección "x" de monitoring.json ` +
      `(${all.x.accounts.length} cuentas, ${all.x.keywords.length} keywords); el archivo viejo quedó como ${migrated}`
  );
  return all;
}

function loadConfigAll() {
  return absorbLegacyXConfig(readConfigAll());
}

// Las funciones por plataforma la reciben SIEMPRE: sin default a Instagram.
// Un llamador que la olvide no tiene que terminar leyendo (o peor,
// escribiendo una sección "undefined" en) el config de otra red.
function requirePlatformId(platformId, fn) {
  if (typeof platformId !== 'string' || !platformId.trim()) {
    throw new Error(`${fn}: falta plataforma (instagram | x); no hay default.`);
  }
  return platformId;
}

/**
 * Config de UNA plataforma para la API y el resto de la app:
 * { accounts, keywords, searches }. `searches` se devuelve siempre como
 * lista, exista o no en el archivo (ver addSearch).
 */
function loadConfig(platformId) {
  requirePlatformId(platformId, 'loadConfig');
  const section = loadConfigAll()[platformId] || { accounts: [], keywords: [] };
  return { accounts: section.accounts, keywords: section.keywords, searches: cleanList(section.searches) };
}

function saveConfig(configAll) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configAll, null, 2) + '\n', 'utf8');
}

/**
 * Agrega una cuenta a trackear (sacando "@" si lo escribieron de más).
 * Antes de guardarla, el adapter valida lo que pueda validar (Instagram
 * consulta que exista; X solo chequea el formato del handle). No hace nada
 * si ya estaba (evita duplicados).
 */
async function addAccount(account, platformId) {
  requirePlatformId(platformId, 'addAccount');
  const clean = String(account || '').trim().replace(/^@/, '');
  if (!clean) {
    const e = new Error('Cuenta vacía');
    e.userMessage = 'Escribí un nombre de cuenta.';
    throw e;
  }
  const platform = getPlatform(platformId);
  // Fase 'validacion' para el registro de gasto en Apify (src/apifyCost.js).
  await runWithContext({ phase: 'validacion' }, () => platform.validateAccount(clean));
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  const isNew = !config.accounts.some((a) => a.toLowerCase() === clean.toLowerCase());
  if (isNew) {
    config.accounts.push(clean);
    saveConfig(all);
    // A propósito NO se calcula el benchmark acá: al agregar una cuenta
    // trackeada queda sin referencia hasta que traiga una publicación
    // relevante al monitoreo; recién ahí, en ese mismo ciclo, se calcula
    // (ver accountStats.refreshStaleAccountStats). Una trackeada que nunca
    // aparece no cuesta ni una consulta.
  }
  return config;
}

function removeAccount(account, platformId) {
  requirePlatformId(platformId, 'removeAccount');
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  config.accounts = config.accounts.filter((a) => a.toLowerCase() !== String(account).toLowerCase());
  saveConfig(all);
  return config;
}

/**
 * Agrega una palabra clave o hashtag. Si empieza con "#" el adapter valida
 * lo que pueda (Instagram consulta que la página del hashtag exista); si no,
 * es texto libre: en Instagram se busca dentro de lo que ya se scrapea, en
 * X se busca literalmente (ver scrapeKeyword en el adapter).
 */
async function addKeyword(keyword, platformId) {
  requirePlatformId(platformId, 'addKeyword');
  const clean = String(keyword || '').trim();
  if (!clean) {
    const e = new Error('Keyword vacía');
    e.userMessage = 'Escribí una palabra clave o hashtag.';
    throw e;
  }
  const platform = getPlatform(platformId);
  if (clean.startsWith('#')) {
    await runWithContext({ phase: 'validacion' }, () => platform.validateHashtag(clean.slice(1)));
  }
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  if (!config.keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) {
    config.keywords.push(clean);
    saveConfig(all);
  }
  return config;
}

function removeKeyword(keyword, platformId) {
  requirePlatformId(platformId, 'removeKeyword');
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  config.keywords = config.keywords.filter((k) => k.toLowerCase() !== String(keyword).toLowerCase());
  saveConfig(all);
  return config;
}

/**
 * Agrega un término a la lista `searches` (búsqueda por palabra clave).
 * Es una lista DISTINTA de `keywords`: las keywords son filtros de texto
 * gratis sobre lo que ya se scrapeó; cada término de `searches` es una
 * consulta cobrada por ciclo (Instagram con apidojo: 0,015 usd con 20
 * posteos incluidos), así que va corta y elegida a mano. No se valida
 * contra Apify (una búsqueda sin resultados no es un error); solo se
 * chequea que la plataforma sepa buscar: con IG_ACTOR=apify no hay
 * búsqueda y se rechaza con un mensaje claro en vez de guardar algo que
 * nunca se va a usar. `searches` recién aparece en el archivo cuando se
 * agrega el primero; las secciones de las demás redes no se tocan.
 */
function addSearch(term, platformId) {
  requirePlatformId(platformId, 'addSearch');
  const clean = String(term || '').trim();
  if (!clean) {
    const e = new Error('Búsqueda vacía');
    e.userMessage = 'Escribí un término de búsqueda.';
    throw e;
  }
  const platform = getPlatform(platformId);
  if (typeof platform.scrapeSearch !== 'function') {
    const e = new Error(`La plataforma ${platformId} no busca por palabra clave`);
    e.userMessage =
      platformId === DEFAULT_PLATFORM_ID
        ? 'El actor activo de Instagram no busca por palabra clave. Poné IG_ACTOR=apidojo en el .env y reiniciá el servidor.'
        : `${platform.label || platformId} no tiene búsqueda por palabra clave aparte: usá las palabras clave.`;
    throw e;
  }
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  config.searches = cleanList(config.searches);
  if (!config.searches.some((s) => s.toLowerCase() === clean.toLowerCase())) {
    config.searches.push(clean);
    saveConfig(all);
  }
  return loadConfig(platformId);
}

function removeSearch(term, platformId) {
  requirePlatformId(platformId, 'removeSearch');
  const all = loadConfigAll();
  const config = all[platformId];
  if (config && Array.isArray(config.searches)) {
    config.searches = config.searches.filter((s) => s.toLowerCase() !== String(term).toLowerCase());
    saveConfig(all);
  }
  return loadConfig(platformId);
}

function textIncludesAny(text, needles) {
  const lower = (text || '').toLowerCase();
  return needles.find((needle) => lower.includes(needle.toLowerCase()));
}

/** Motivo base de un posteo que llegó por búsqueda por palabra clave (Instagram): "Búsqueda: jorge macri". */
function searchBase(post) {
  return `Búsqueda: ${post.sourceQuery || 'palabra clave'}`;
}

/**
 * Actualiza la caché de seguidores (account_followers) con lo que trajo una
 * respuesta del adapter, en cualquier fase (detección, benchmark,
 * refresco): cada posteo normalizado puede venir con `followers` del autor
 * (Instagram con apidojo los trae en cada posteo; el actor oficial no). Una
 * cuenta por respuesta, con el primer valor que aparece. Solo en plataformas
 * con capabilities.followers. Nunca tira: un fallo al cachear se loguea y no
 * afecta a quien llamó.
 * @returns {number} cuentas actualizadas
 */
function rememberFollowers(posts, platformId) {
  try {
    const platform = getPlatform(platformId);
    if (!(platform.capabilities && platform.capabilities.followers)) return 0;
    const byAccount = new Map();
    for (const post of posts || []) {
      if (!post || !post.account || post.account === 'N/D' || post.followers == null) continue;
      const key = String(post.account).toLowerCase();
      if (!byAccount.has(key)) byAccount.set(key, post);
    }
    const updatedAt = new Date().toISOString();
    for (const post of byAccount.values()) {
      db.upsertAccountFollowers({ account: post.account, plataforma: platformId, followers: post.followers, updatedAt });
    }
    return byAccount.size;
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudo actualizar la caché de seguidores:`, err.message);
    return 0;
  }
}

/**
 * Métricas de un posteo según lo que declara el adapter, limitadas a las
 * columnas que existen en detected_posts. Es lo que se pasa a
 * db.applyMetricsRefresh: las claves ausentes se conservan como estaban
 * (Instagram no toca retweets/views; X las refresca).
 */
function pickMetrics(platform, post) {
  const out = {};
  for (const metric of platform.metrics || []) {
    if (METRIC_COLUMNS.includes(metric.key)) out[metric.key] = post[metric.key];
  }
  return out;
}

/**
 * Decide si un posteo candidato es relevante y, si lo es, le pone
 * título + sentimiento. Dos caminos:
 *   1. Llegó por una búsqueda por término (sourceType 'keyword': una keyword
 *      o, en X, también un hashtag — ahí el hashtag es una búsqueda más, no
 *      una página de descubrimiento) → relevante sin preguntar: la búsqueda
 *      de la plataforma ya lo encontró para ese término, descartarlo después
 *      sería perder lo que la búsqueda validó. El clasificador solo aporta
 *      título y sentimiento; su "relevant" no se mira (X quedó fuera del
 *      cambio de criterio de septiembre 2026). sourceType 'hashtag'
 *      (Instagram) NO entra acá: la página del hashtag trae todo lo que lo
 *      usa y hay que filtrarlo.
 *   2. Todo lo demás (cuenta trackeada, hashtag, búsqueda de Instagram) lo
 *      decide el clasificador en una sola llamada, con una PISTA de cómo
 *      llegó el posteo: la coincidencia literal con una keyword (una guía,
 *      no una garantía), la cuenta trackeada (señal débil), el hashtag
 *      o la búsqueda. Antes la coincidencia literal daba relevancia por
 *      hecho y solo sin ella se le preguntaba al modelo; así entraba "Jefe
 *      de Gobierno" de la Ciudad de México como si fuera porteño.
 * Un posteo sin caption solo se acepta si viene de una cuenta trackeada
 * (no hay texto que evaluar, pero viene de la fuente que explícitamente
 * querés ver); si viene de un hashtag o una búsqueda, se descarta. Los de
 * búsqueda llegan acá con el caption ya completado por enrichSearchResults
 * cuando el detalle lo trajo.
 * La búsqueda por palabra clave de Instagram (sourceType 'search') NO es el
 * camino 1: Instagram asocia al término mucho contenido que no habla del
 * tema, así que pasa por el 2 como un hashtag, con el motivo
 * "Búsqueda: <término>" (searchBase).
 * Si el clasificador falla, el posteo se guarda igual marcado "sin
 * clasificar" (relevancia sin verificar): un falso positivo se ve y se
 * borra; uno descartado en silencio no vuelve nunca.
 * Trazabilidad: el motivo que da el modelo queda al final de matchedReason
 * (`<motivo base> · <motivo>`) y un descarte se loguea con cuenta, url y
 * motivo, para poder auditar por qué entró o salió cada posteo. En el
 * camino 1 (X) no hay motivo: el modelo no decidió nada ahí.
 *
 * @param {object} post posteo normalizado por el adapter
 * @param {string[]} keywords keywords planas (sin "#") de la plataforma
 * @param {{ platform?: object }} [options] adapter, para etiquetar el prompt
 */
async function evaluateRelevance(post, keywords, { platform } = {}) {
  const platformLabel = platform && platform.label ? platform.label : undefined;
  const text = `${post.caption || ''} ${post.hashtagsText || ''}`.trim();

  if (!post.caption || !post.caption.trim()) {
    if (post.sourceType === 'account') {
      return { relevant: true, title: 'Sin descripción', sentiment: 'neutral', matchedReason: `Cuenta trackeada: @${post.account}` };
    }
    return { relevant: false };
  }

  const literalMatch = textIncludesAny(text, keywords);

  if (post.sourceType === 'keyword') {
    const term = post.sourceQuery || literalMatch;
    const { title, sentiment, unclassified } = await clasificarPosteo(post.caption, { platformLabel, pista: { busqueda: term } });
    let base = 'Búsqueda por palabra clave';
    if (term) {
      base = String(term).startsWith('#')
        ? `Búsqueda por hashtag: "${term}"`
        : `Búsqueda por palabra clave: "${term}"`;
    }
    return {
      relevant: true,
      title,
      sentiment,
      unclassified,
      matchedReason: unclassified ? `${base} — sin clasificar` : base,
    };
  }

  const pista = {
    termino: literalMatch || null,
    cuenta: post.sourceType === 'account' ? post.account : null,
    hashtag: post.sourceType === 'hashtag',
    busqueda: post.sourceType === 'search' ? post.sourceQuery || null : null,
  };
  const result = await clasificarPosteo(post.caption, { platformLabel, pista });

  // Motivo base, con los textos de siempre según origen y coincidencia.
  const origen =
    post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account}`
      : post.sourceType === 'search'
        ? searchBase(post)
        : null;
  const base = literalMatch
    ? origen
      ? `${origen} (coincidencia: "${literalMatch}")`
      : `Coincidencia con palabra clave: "${literalMatch}"`
    : origen
      ? `${origen} (relacionado por contenido)`
      : 'Relacionado por contenido (sin palabra clave literal)';

  if (result.unclassified) {
    // Con el clasificador caído no sabemos si es relevante. Se guarda igual,
    // marcado, para que alguien lo revise.
    const sinVerificar = literalMatch ? base : origen || 'Hashtag monitoreado';
    return {
      relevant: true,
      title: null,
      sentiment: null,
      unclassified: true,
      matchedReason: `${sinVerificar} — sin clasificar (falló el clasificador, relevancia sin verificar)`,
    };
  }

  // Un relevant:false del modelo es una respuesta legítima: descarta. Queda
  // en el log el porqué, que es lo único que sobrevive de un descartado.
  if (!result.relevant) {
    console.log(
      `[clasificador] descartado (${platformLabel || 'sin red'}) @${post.account || '?'} ${post.url || ''}: ${result.motivo || 'sin motivo'}`
    );
    return { relevant: false, motivo: result.motivo || null };
  }

  return {
    relevant: true,
    title: result.title,
    sentiment: result.sentiment,
    motivo: result.motivo || null,
    matchedReason: result.motivo ? `${base} · ${result.motivo}` : base,
  };
}

/**
 * Refresco "gratis" de un posteo ya guardado con las métricas que trajo
 * esta misma respuesta. Una respuesta SIN ninguna métrica no refresca nada:
 * los resultados de la búsqueda por palabra clave de Instagram llegan con
 * los contadores en null, y escribirlos pisaría con NULL lo ya guardado.
 * @returns lo mismo que db.applyMetricsRefresh, o null si no había métricas.
 */
function refreshKnownPost(platform, id, post) {
  const metrics = pickMetrics(platform, post);
  const hasMetrics = Object.values(metrics).some((v) => v !== null && v !== undefined);
  return hasMetrics ? db.applyMetricsRefresh(id, metrics) : null;
}

function hasCaption(post) {
  return Boolean(post && typeof post.caption === 'string' && post.caption.trim());
}

/** Código del posteo en una URL de Instagram (/p/{code}/, /reel/{code}/), para cruzar el detalle cuando el id no coincide. */
function postCodeOf(url) {
  const match = /\/(?:p|reel|reels|tv)\/([^/?#]+)/.exec(String(url || ''));
  return match ? match[1] : null;
}

/** Nunca tira: no poder anotar un visto no puede frenar el ciclo (a lo sumo se vuelve a pedir ese detalle). */
function markSearchSeen(post, platformId, outcome) {
  try {
    db.markSearchSeen({ postId: post.id, plataforma: platformId, url: post.url, term: post.sourceQuery, outcome });
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudo anotar el resultado de búsqueda ${post.id}:`, err.message);
  }
}

/**
 * La búsqueda por palabra clave de Instagram (apidojo) devuelve objetos
 * recortados: sin caption ni contadores, aunque el posteo los tenga. Sin
 * texto no hay relevancia que evaluar, así que a los resultados NUEVOS se les
 * pide el detalle con platform.fetchPostDetails: UNA consulta por ciclo con
 * todas las URLs (fase 'busqueda' del registro de gasto), y el caption, los
 * hashtags y los contadores que vuelven se vuelcan sobre el mismo posteo,
 * que sigue siendo de la búsqueda (sourceType y sourceQuery no cambian).
 * Después corre el pipeline de siempre.
 *
 * Para no pagar dos veces por lo mismo:
 *   - No se consulta lo que ya está en detected_posts ni lo anotado en
 *     search_seen (un posteo descartado no se vuelve a evaluar).
 *   - Tope por ciclo SEARCH_ENRICH_LIMIT (default 20, 0 apaga el paso): van
 *     primero los más nuevos; el resto queda SIN anotar y entra en el próximo
 *     ciclo si la búsqueda lo sigue trayendo.
 *   - Queda anotado todo aquello por lo que se pagó: 'sin_caption' (el
 *     detalle tampoco trae texto: se descarta), 'sin_detalle' (la consulta
 *     no devolvió ese posteo: borrado o privado) y, después de evaluar
 *     relevancia (runMonitoringCycle), 'guardado' o 'descartado'.
 *   - Si la consulta falla entera no se anota nada: se reintenta en el
 *     próximo ciclo. Un error de plataforma (cuota, credenciales, rate limit)
 *     se devuelve para que el ciclo lo trate como el de cualquier fuente.
 *
 * Modifica `postsById` (el Map del dedupe intra-ciclo): reemplaza cada
 * posteo enriquecido por su versión con texto.
 * @returns {Promise<{ enriched: Set<string>, platformError: Error|null, stats: object|null }>}
 *   `enriched`: ids a los que hay que anotarles el resultado de la
 *   evaluación; `stats` null si no había resultados de búsqueda sin texto.
 */
async function enrichSearchResults(platform, platformId, postsById) {
  const out = { enriched: new Set(), platformError: null, stats: null };
  if (typeof platform.fetchPostDetails !== 'function') return out;

  const candidates = [];
  let alreadySeen = 0;
  for (const post of postsById.values()) {
    if (post.sourceType !== 'search' || hasCaption(post)) continue;
    if (db.findExistingPostId(post.id, post.url)) continue;
    if (db.isSearchSeen(post.id, platformId)) {
      alreadySeen += 1;
      continue;
    }
    candidates.push(post);
  }
  if (candidates.length === 0 && alreadySeen === 0) return out;

  const limit = searchEnrichLimit();
  const stats = { candidates: candidates.length, alreadySeen, requested: 0, enriched: 0, noCaption: 0, noDetail: 0, deferred: 0, failed: false };
  out.stats = stats;
  if (candidates.length === 0) return out;
  if (limit === 0) {
    stats.deferred = candidates.length;
    console.log(
      `[monitor] ${platformId}: ${candidates.length} resultado(s) de búsqueda sin caption; el detalle está apagado (SEARCH_ENRICH_LIMIT=0), se descartan.`
    );
    return out;
  }

  // Los más nuevos primero; lo que no entra en el tope queda para el próximo ciclo.
  const timeOf = (post) => Date.parse(post.postedAt || '') || 0;
  candidates.sort((a, b) => timeOf(b) - timeOf(a));
  const batch = candidates.slice(0, limit);
  stats.requested = batch.length;
  stats.deferred = candidates.length - batch.length;
  progress.startPhase('Detalle de búsquedas', batch.length);

  let details;
  try {
    details = await runWithContext({ phase: 'busqueda' }, () => platform.fetchPostDetails(batch.map((post) => post.url)));
  } catch (err) {
    stats.failed = true;
    if (isPlatformError(err)) {
      out.platformError = err;
      console.error(`Monitoreo (${platformId}): la plataforma no se pudo consultar (${err.code}):`, err.message);
    } else {
      console.error(`Monitoreo (${platformId}): falló el detalle de los resultados de búsqueda (se reintenta en el próximo ciclo):`, err && err.message);
    }
    return out;
  }

  const byId = new Map();
  const byCode = new Map();
  for (const detail of Array.isArray(details) ? details : []) {
    if (!detail) continue;
    if (detail.id) byId.set(String(detail.id), detail);
    const code = postCodeOf(detail.url);
    if (code) byCode.set(code, detail);
  }

  for (const post of batch) {
    progress.tick();
    const detail = byId.get(String(post.id)) || byCode.get(postCodeOf(post.url));
    if (!detail) {
      stats.noDetail += 1;
      markSearchSeen(post, platformId, 'sin_detalle');
      continue;
    }
    if (!hasCaption(detail)) {
      stats.noCaption += 1;
      markSearchSeen(post, platformId, 'sin_caption');
      continue;
    }
    postsById.set(post.id, {
      ...post,
      caption: detail.caption,
      hashtagsText: detail.hashtagsText || post.hashtagsText || '',
      likes: detail.likes ?? post.likes ?? null,
      comments: detail.comments ?? post.comments ?? null,
      account: post.account && post.account !== 'N/D' ? post.account : detail.account,
      postType: post.postType || detail.postType || null,
      postedAt: post.postedAt || detail.postedAt || null,
    });
    out.enriched.add(post.id);
    stats.enriched += 1;
  }

  console.log(
    `[monitor] ${platformId}: detalle de ${stats.requested} resultado(s) de búsqueda sin caption → ${stats.enriched} con texto, ` +
      `${stats.noCaption} sin caption, ${stats.noDetail} sin detalle` +
      (stats.deferred > 0 ? `; ${stats.deferred} quedan para el próximo ciclo (SEARCH_ENRICH_LIMIT=${limit})` : '') +
      (alreadySeen > 0 ? `; ${alreadySeen} ya consultado(s) antes` : '') +
      '.'
  );
  return out;
}

function notConfiguredError(platform) {
  const e = new Error(`La plataforma ${platform.id} no tiene credenciales configuradas`);
  e.code = 'NOT_CONFIGURED';
  e.userMessage = `Falta configurar ${platform.label || platform.id}: revisá las claves en el .env.`;
  return e;
}

/**
 * Corre un ciclo completo de monitoreo: por cada plataforma del registro
 * (o solo las pedidas en `plataformas`), scrapea todas las fuentes vía su
 * adapter, evalúa relevancia, descarta lo ya conocido y guarda + devuelve
 * solo los posteos nuevos. La evaluación, el dedupe y el guardado son los
 * mismos para todas las plataformas; solo el scraping es del adapter.
 *
 * Una plataforma sin credenciales se saltea con un aviso — salvo que sea la
 * única pedida (botón "Actualizar ahora" de esa solapa), en cuyo caso el
 * error llega al usuario. Lo mismo si alguna fuente falla con un error de
 * plataforma (credenciales inválidas, rate limit, cuota agotada — ver
 * platforms/errors.js): primero se guarda lo que las demás fuentes sí
 * trajeron y después, si la corrida era solo de esa plataforma, se tira ese
 * error (con `userMessage`, y aclarando cuántos posteos entraron igual). En
 * una corrida de todo el registro queda en porPlataforma[id].error y se
 * sigue con las demás.
 *
 * @param {{ plataformas?: string[] }} [options] subconjunto del registro;
 *   sin él, todas (cron).
 * @returns {Promise<{ checked: number, newPosts: object[],
 *   scrapedAccounts: Object<string, string[]>,
 *   porPlataforma: Object<string, { checked: number, newCount: number, skipped: boolean,
 *     error?: { code: string, message: string } }> }>}
 */
async function runMonitoringCycle({ plataformas } = {}) {
  const all = loadConfigAll();
  const limits = monitorLimits();
  // Búsquedas y keywords (X) siguen con la ventana fija de siempre; solo
  // cuentas y hashtags usan la ventana dinámica (ver detectionWindowFor).
  const legacyLookback = process.env.MONITOR_LOOKBACK || '1 day';
  const cycleNowMs = Date.now();
  const ids = listPlatformIds().filter((id) => !plataformas || plataformas.includes(id));
  const singlePlatformRun = Boolean(plataformas && plataformas.length === 1);

  let checked = 0;
  const newPosts = [];
  const scrapedAccounts = {};
  const porPlataforma = {};
  let metricsRefreshedFree = 0;

  // Resultados de búsqueda ya consultados hace más de SEARCH_SEEN_TTL_DAYS.
  try {
    db.purgeSearchSeen(new Date(Date.now() - SEARCH_SEEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString());
  } catch (err) {
    console.error('[monitor] no se pudieron purgar los resultados de búsqueda vistos:', err.message);
  }

  for (const platformId of ids) {
    const platform = getPlatform(platformId);
    const config = all[platformId] || { accounts: [], keywords: [] };
    porPlataforma[platformId] = { checked: 0, newCount: 0, skipped: false };

    if (typeof platform.isConfigured === 'function' && !platform.isConfigured()) {
      if (singlePlatformRun) throw notConfiguredError(platform);
      console.warn(`[monitor] ${platformId}: sin credenciales configuradas, se saltea esta plataforma.`);
      porPlataforma[platformId].skipped = true;
      continue;
    }

    const { accounts, keywords } = config;
    const searches = cleanList(config.searches);
    const hashtagTags = keywords.filter((k) => k.startsWith('#')).map((k) => k.slice(1));
    const textKeywords = keywords.filter((k) => !k.startsWith('#'));
    // Para filtrar por substring usamos la lista completa de keywords, sin el "#".
    const plainKeywords = keywords.map((k) => (k.startsWith('#') ? k.slice(1) : k));
    const canSearchKeywords = typeof platform.scrapeKeyword === 'function';
    // Qué fuentes consulta la detección de esta plataforma, según lo que
    // declara su adapter (ver platforms/index.js). Instagram (desde
    // septiembre 2026) no consulta perfiles de cuentas trackeadas ni recorre
    // páginas de hashtag: esas listas quedan como guía para el clasificador
    // y lo único que busca publicaciones es `searches`. X sigue con todo.
    const caps = platform.capabilities || {};
    const accountsToScrape = caps.detectAccounts === false ? [] : accounts;
    const hashtagsToScrape = caps.detectHashtags === false ? [] : hashtagTags;
    if (accountsToScrape.length < accounts.length || hashtagsToScrape.length < hashtagTags.length) {
      console.log(
        `[monitor] ${platformId}: ${accounts.length} cuenta(s) trackeada(s) y ${hashtagTags.length} hashtag(s) configurados ` +
          `son solo guía para el clasificador, no se consultan; la detección va por ${searches.length} búsqueda(s) por palabra clave.`
      );
    }
    // Búsqueda por palabra clave (lista `searches`): solo si el adapter
    // sabe buscar. Con IG_ACTOR=apify no hay búsqueda: los términos quedan
    // configurados, pero se avisa y se ignoran en esta corrida.
    const canSearch = typeof platform.scrapeSearch === 'function';
    if (searches.length > 0 && !canSearch) {
      console.warn(
        `[monitor] ${platformId}: hay ${searches.length} búsqueda(s) por palabra clave configuradas pero el proveedor activo ` +
          `no busca (en Instagram hace falta IG_ACTOR=apidojo): se ignoran en esta corrida y no se detecta nada.`
      );
    }

    // Ventana de detección de ESTA corrida (cuentas, hashtags y búsquedas):
    // dinámica, desde el fin de la última detección exitosa (sin corrida
    // previa, MONITOR_LOOKBACK: 1 día), con techo MONITOR_LOOKBACK_MAX. Si
    // superó 1 día, los topes suben proporcionalmente para no perder posteos
    // por el tope de cantidad en vez de por fecha (ver raiseLimitForWindow):
    // el excedente sobre lo incluido por consulta se paga, no se corta.
    const window = detectionWindowFor(platformId, { now: cycleNowMs });
    const accountLimit = window.isDefault ? limits.account : raiseLimitForWindow(limits.account, window.windowDays);
    const hashtagLimit = window.isDefault ? limits.hashtag : raiseLimitForWindow(limits.hashtag, window.windowDays);
    const searchLimit = window.isDefault ? limits.search : raiseLimitForWindow(limits.search, window.windowDays);
    if (!window.isDefault) {
      console.log(
        `[monitor] ${platformId}: ventana de detección ampliada a ${window.windowDays} día(s) (desde ${window.sinceIso}); ` +
          `topes de esta corrida: cuentas ${accountLimit} (base ${limits.account}), hashtags ${hashtagLimit} (base ${limits.hashtag}), ` +
          `búsquedas ${searchLimit} (base ${limits.search}).`
      );
    }

    // Cada búsqueda va en la fase 'busqueda' del registro de gasto
    // (src/apifyCost.js), heredando el ciclo del contexto del scheduler.
    // Las cuatro fuentes se lanzan juntas (no son fases secuenciales de
    // verdad): el progreso las junta en una sola fase visible, con un tick
    // por cada llamada que termina (bien o mal) — ver src/monitoringProgress.js.
    const detectionTotal =
      accountsToScrape.length + hashtagsToScrape.length + (canSearchKeywords ? textKeywords.length : 0) + (canSearch ? searches.length : 0);
    progress.startPhase('Detectando posteos nuevos', detectionTotal);
    // .then(ok, error) en vez de .finally(): así cada tick sabe si esa
    // llamada terminó bien o mal (para "[fase] termina ... N ok, N error"),
    // y sigue devolviendo el mismo valor/error para Promise.allSettled.
    const tickDetection = (promise) =>
      promise.then(
        (value) => {
          progress.tick(1, { ok: true });
          return value;
        },
        (err) => {
          progress.tick(1, { ok: false });
          throw err;
        }
      );

    const sourceResults = await Promise.allSettled([
      ...accountsToScrape.map((account) => tickDetection(platform.scrapeAccount(account, { resultsLimit: accountLimit, lookback: window.lookback }))),
      ...hashtagsToScrape.map((tag) => tickDetection(platform.scrapeHashtag(tag, { resultsLimit: hashtagLimit, lookback: window.lookback }))),
      ...(canSearchKeywords
        ? textKeywords.map((keyword) =>
            tickDetection(platform.scrapeKeyword(keyword, { resultsLimit: limits.search, lookback: legacyLookback }))
          )
        : []),
      ...(canSearch
        ? searches.map((term) =>
            tickDetection(
              runWithContext({ phase: 'busqueda' }, () => platform.scrapeSearch(term, { resultsLimit: searchLimit, lookback: window.lookback }))
            )
          )
        : []),
    ]);

    const allCandidates = [];
    // Primer error de plataforma de esta corrida (clave inválida, rate limit,
    // cuota): se resuelve DESPUÉS de guardar lo que sí llegó (ver abajo).
    let platformError = null;
    for (const result of sourceResults) {
      if (result.status === 'fulfilled') {
        allCandidates.push(...result.value);
      } else if (isPlatformError(result.reason)) {
        if (!platformError) platformError = result.reason;
        console.error(
          `Monitoreo (${platformId}): la plataforma no se pudo consultar (${result.reason.code}):`,
          result.reason.message
        );
      } else {
        // Una fuente que falla sola (cuenta privada/eliminada, error puntual
        // de la fuente, etc.) no debe tirar abajo el resto del ciclo.
        console.error(`Monitoreo (${platformId}): falló una fuente:`, result.reason && result.reason.message);
      }
    }

    // Seguidores que vinieron con los posteos (apidojo): a la caché antes de
    // guardar, así el snapshot del posteo nuevo ya sale con el dato fresco.
    rememberFollowers(allCandidates, platformId);

    // Dedupe por id dentro de esta misma corrida (una cuenta trackeada podría
    // aparecer también en un hashtag o en una búsqueda). Si el mismo posteo
    // llega por más de una fuente gana el origen más específico
    // (SOURCE_PRIORITY): la búsqueda por término de X ('keyword') ya lo
    // validó y entra sin que el clasificador decida; la cuenta trackeada ('account')
    // le gana al hashtag y a la búsqueda de Instagram ('search'), que son
    // descubrimiento y se filtran igual. A igual prioridad, el primero. La
    // cuenta no se pierde: post.account es el mismo handle en todas. Por
    // plataforma: dos plataformas distintas nunca comparten id.
    const seenInThisRun = new Map();
    for (const post of allCandidates) {
      if (!post.url) continue;
      const prev = seenInThisRun.get(post.id);
      if (!prev || sourcePriority(post) > sourcePriority(prev)) {
        seenInThisRun.set(post.id, post);
      }
    }
    checked += seenInThisRun.size;
    porPlataforma[platformId].checked = seenInThisRun.size;

    // Los resultados de búsqueda llegan sin caption: a los nuevos se les pide
    // el detalle (una consulta para todos) antes de evaluar relevancia.
    const enrichment = await enrichSearchResults(platform, platformId, seenInThisRun);
    if (enrichment.stats) porPlataforma[platformId].searchEnrichment = enrichment.stats;
    if (enrichment.platformError && !platformError) platformError = enrichment.platformError;

    // Total real de la fase de clasificación: solo los posteos NUEVOS pasan
    // por evaluateRelevance (los ya conocidos abajo solo se refrescan gratis).
    const pendingClassification = [...seenInThisRun.values()].filter((post) => !db.findExistingPostId(post.id, post.url)).length;
    progress.startPhase('Clasificando relevancia', pendingClassification);

    for (const post of seenInThisRun.values()) {
      // Por id o por url: si el scraper cambia el campo con el que armamos el
      // id, la URL sigue siendo la misma pieza y no hay que re-clasificarla.
      const existingId = db.findExistingPostId(post.id, post.url);
      if (existingId) {
        // Ya lo conocíamos (incluye ignorados: la fila sigue en SQLite para
        // no re-detectar). No reclasificar. Si no está ignorado, esta misma
        // respuesta del scraper trae las métricas actuales — refrescar la
        // fila sale gratis. Si está ignorado, applyMetricsRefresh es no-op.
        const refresh = refreshKnownPost(platform, existingId, post);
        if (refresh) {
          metricsRefreshedFree += 1;
          checkAndLogJump({ account: refresh.account, id: existingId, postedAt: refresh.postedAt, metric: 'comentarios', previous: refresh.previousComments, current: refresh.comments });
          checkAndLogJump({ account: refresh.account, id: existingId, postedAt: refresh.postedAt, metric: 'likes', previous: refresh.previousLikes, current: refresh.likes });
        }
        continue;
      }

      const evaluation = await evaluateRelevance(post, plainKeywords, { platform });
      progress.tick();
      // Un resultado de búsqueda con el detalle ya pagado queda anotado con
      // lo que se decidió: descartado no se vuelve a consultar ni a evaluar.
      const paidDetail = enrichment.enriched.has(post.id);
      if (!evaluation.relevant) {
        if (paidDetail) markSearchSeen(post, platformId, 'descartado');
        continue;
      }
      if (paidDetail) markSearchSeen(post, platformId, 'guardado');

      const postWithClassification = {
        ...post,
        plataforma: platformId,
        title: evaluation.title,
        sentiment: evaluation.sentiment,
        matchedReason: evaluation.matchedReason,
        // Snapshot de seguidores: el dato que vino con el posteo (apidojo)
        // o, si no, la caché account_followers (nunca un llamado al scraper
        // acá: eso encarecería cada corrida de 4hs; la caché se refresca con
        // cada respuesta que trae el dato y en accountStats.computeAccountStats).
        // Posts sin cuenta (hashtag), de cuentas todavía sin caché o de
        // plataformas sin seguidores quedan null -> "-" en la tabla.
        followers:
          post.followers != null
            ? post.followers
            : post.account && platform.capabilities && platform.capabilities.followers
              ? db.getAccountFollowers(post.account, platformId)
              : null,
      };

      let inserted;
      try {
        inserted = db.saveDetectedPost(postWithClassification);
      } catch (err) {
        // Url de otra red que la plataforma que lo trajo: la base lo rechaza
        // (ver db.saveDetectedPost). Se descarta ese posteo y el ciclo sigue.
        if (err.code !== 'PLATAFORMA_INCONSISTENTE') throw err;
        console.error(`[monitor] (${platformId}) descartado: ${err.message}`);
        continue;
      }
      if (!inserted) {
        // Carrera con otro ciclo: entre el findExisting y el INSERT el otro
        // proceso ya lo guardó. No es un posteo nuevo para notificar.
        const racedId = db.findExistingPostId(post.id, post.url);
        if (racedId) {
          refreshKnownPost(platform, racedId, post);
        }
        continue;
      }
      newPosts.push(postWithClassification);
      porPlataforma[platformId].newCount += 1;
    }

    // Cuentas trackeadas cuyo perfil se scrapeó de verdad en este ciclo (no
    // las de hashtag/keyword: ahí solo se pesca el posteo puntual que
    // matcheó, nunca "los últimos N" de esa cuenta). src/metricsRefresh.js las
    // usa para no volver a pedirle al scraper una cuenta que ya se acaba de
    // consultar. Por plataforma: el mismo handle puede existir en dos redes.
    // En Instagram queda vacío (detectAccounts: false): ninguna cuenta se
    // consultó en la detección, así que el refresco las pide si les toca.
    scrapedAccounts[platformId] = [...accountsToScrape];

    if (platformError) {
      const saved = porPlataforma[platformId].newCount;
      const userMessage = platformError.userMessage || platformError.message;
      // Sin code solo puede ser la cuota de Apify detectada por texto
      // (ver isQuotaExceeded en platforms/errors.js).
      const code = platformError.code || 'QUOTA_EXCEEDED';
      porPlataforma[platformId].error = { code, message: userMessage };
      if (singlePlatformRun) {
        // Lo que sí llegó ya está guardado; el error igual tiene que verse.
        platformError.code = code;
        platformError.userMessage = saved > 0
          ? `${userMessage} Igual se guardaron ${saved} posteo(s) nuevo(s) de las fuentes que sí respondieron.`
          : userMessage;
        throw platformError;
      }
      console.warn(`[monitor] ${platformId}: la corrida quedó incompleta (${code}); se sigue con las demás plataformas.`);
    } else {
      // Detección exitosa (las fuentes que esta plataforma consulta:
      // búsquedas en Instagram; cuentas, hashtags y keywords en X — con o
      // sin posteos nuevos): marca el fin de esta corrida como punto de
      // partida de la próxima ventana (ver detectionWindowFor). Solo la
      // detección cuenta acá, aunque el ciclo completo falle después en
      // benchmark o refresco.
      try {
        db.setRefreshState(`detection_last_success:${platformId}`, new Date(cycleNowMs).toISOString());
      } catch (err) {
        console.error(`[monitor] (${platformId}) no se pudo guardar el fin de la última detección exitosa:`, err.message);
      }
    }
  }

  if (metricsRefreshedFree > 0) {
    console.log(`[monitor] ${metricsRefreshedFree} posteo(s) ya conocidos refrescados gratis con este mismo ciclo.`);
  }

  return { checked, newPosts, scrapedAccounts, porPlataforma };
}

/**
 * Genera título + sentimiento para los posteos guardados de una plataforma
 * que todavía no lo tienen (posteos de antes de esta funcionalidad, o
 * alguno que falló). Se puede llamar las veces que haga falta: no vuelve a
 * tocar los que ya están clasificados.
 */
async function backfillClassification(platformId) {
  requirePlatformId(platformId, 'backfillClassification');
  const platform = getPlatform(platformId);
  const pending = db.listUnclassified({ plataforma: platformId });
  let classified = 0;
  let stillPending = 0;

  for (const row of pending) {
    // Sin pista: el origen ya quedó en matched_reason. El modelo también
    // devuelve relevant, pero desde acá no se borra nada ya guardado: se
    // completan título, sentimiento y motivo, y si el modelo dice que no es
    // relevante queda avisado en matched_reason para que alguien lo revise.
    const r = await clasificarPosteo(row.caption, { platformLabel: platform.label });
    if (r.unclassified || !r.title) {
      // Sigue fallando: no pisamos la fila con los mismos nulls, queda
      // pendiente para el próximo intento.
      stillPending++;
      continue;
    }
    // Sale la marca "— sin clasificar" del ciclo que falló; entra el motivo.
    // En X, lo que llegó por búsqueda por término no lleva motivo (stand by:
    // ahí el modelo no decide relevancia).
    let matchedReason = String(row.matched_reason || '').replace(/ — sin clasificar.*$/, '');
    const sinMotivo = platformId === 'x' && /^Búsqueda por /.test(matchedReason);
    if (r.motivo && !sinMotivo) {
      const nota = r.relevant ? r.motivo : `no relevante según el modelo: ${r.motivo}`;
      matchedReason = matchedReason ? `${matchedReason} · ${nota}` : nota;
    }
    if (!r.relevant && !sinMotivo) {
      console.warn(
        `[monitor] backfill: el modelo considera NO relevante el posteo ${row.id} de @${row.account || '?'} (${r.motivo || 'sin motivo'}); queda guardado para revisión.`
      );
    }
    db.updateClassification(row.id, { title: r.title, sentiment: r.sentiment, matchedReason });
    classified++;
  }

  if (stillPending > 0) {
    console.warn(
      `[monitor] backfill: ${stillPending} posteo(s) siguen sin clasificar (el clasificador falló). Se reintentan en la próxima corrida.`
    );
  }
  return { classified, stillPending };
}

module.exports = {
  runMonitoringCycle,
  backfillClassification,
  loadConfig,
  loadConfigAll,
  addAccount,
  removeAccount,
  addKeyword,
  removeKeyword,
  addSearch,
  removeSearch,
  rememberFollowers,
  monitorLimits,
  searchEnrichLimit,
  detectionWindowFor,
  // Expuestos para tests.
  evaluateRelevance,
  pickMetrics,
  raiseLimitForWindow,
};
