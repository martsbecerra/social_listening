// ==========================================================================
// monitor.js
// --------------------------------------------------------------------------
// Orquestador del monitoreo, agnóstico de plataforma. Detecta posteos nuevos
// relevantes a partir de las fuentes configuradas por plataforma
// (config/monitoring.json, una sección por red):
//   - Cuentas trackeadas.
//   - Hashtags (las keywords que empiezan con "#").
//   - Keywords planas, SOLO en las plataformas cuyo adapter sabe buscarlas
//     (scrapeKeyword, por ejemplo X). En las demás son un filtro de texto
//     sobre lo que ya se scrapeó por cuenta, hashtag o búsqueda.
//   - Búsquedas por palabra clave (`searches`), SOLO en las plataformas
//     cuyo adapter sabe buscar (scrapeSearch: Instagram con IG_ACTOR=apidojo).
//     Es una lista aparte de las keywords, corta y elegida a mano: cada
//     término es una consulta cobrada por ciclo. Lo que trae se filtra igual
//     que un hashtag (relevancia literal o semántica), no entra directo.
//
// Un posteo se considera relevante si:
//   1. Llegó por una búsqueda por término (sourceType 'keyword': una keyword,
//      o un hashtag en las redes donde el hashtag es una búsqueda más, como
//      X) — la búsqueda ya lo validó, o
//   2. Su caption/hashtags contienen alguna palabra clave literal
//      (case-insensitive), o
//   3. No hay coincidencia literal, pero el clasificador determina que el
//      contenido igual habla del Jefe de Gobierno porteño o su gestión
//      (detección semántica — ver classifyRelevance en src/classifier.js).
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
const { classifyPost, classifyRelevance } = require('./classifier');
const { checkAndLogJump } = require('./viralJumpDetector');
const { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID } = require('./platforms');
const { isPlatformError } = require('./platforms/errors');
const { runWithContext } = require('./usageContext');
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

/**
 * Config de UNA plataforma para la API y el resto de la app:
 * { accounts, keywords, searches }. `searches` se devuelve siempre como
 * lista, exista o no en el archivo (ver addSearch).
 */
function loadConfig(platformId = DEFAULT_PLATFORM_ID) {
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
async function addAccount(account, platformId = DEFAULT_PLATFORM_ID) {
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

function removeAccount(account, platformId = DEFAULT_PLATFORM_ID) {
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
async function addKeyword(keyword, platformId = DEFAULT_PLATFORM_ID) {
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

function removeKeyword(keyword, platformId = DEFAULT_PLATFORM_ID) {
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
function addSearch(term, platformId = DEFAULT_PLATFORM_ID) {
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

function removeSearch(term, platformId = DEFAULT_PLATFORM_ID) {
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
 * título + sentimiento. Tres caminos:
 *   1. Llegó por una búsqueda por término (sourceType 'keyword': una keyword
 *      o, en X, también un hashtag — ahí el hashtag es una búsqueda más, no
 *      una página de descubrimiento) → relevante sin preguntar: la búsqueda
 *      de la plataforma ya lo encontró para ese término, descartarlo después
 *      sería perder lo que la búsqueda validó. Solo se clasifican título y
 *      sentimiento. sourceType 'hashtag' (Instagram) NO entra acá: la página
 *      del hashtag trae todo lo que lo usa y hay que filtrarlo.
 *   2. Coincidencia literal de palabra clave → clasificación directa
 *      (siempre relevante, no hace falta preguntar si aplica).
 *   3. Sin coincidencia literal → se le pregunta al clasificador si el
 *      contenido igual habla del Jefe de Gobierno porteño / su gestión
 *      (detección semántica), para no depender solo del texto exacto.
 * Un posteo sin caption solo se acepta si viene de una cuenta trackeada
 * (no hay texto que evaluar, pero viene de la fuente que explícitamente
 * querés ver); si viene de un hashtag o una búsqueda, se descarta.
 * La búsqueda por palabra clave de Instagram (sourceType 'search') NO es el
 * camino 1: Instagram asocia al término mucho contenido que no habla del
 * tema, así que pasa por el 2 y el 3 como un hashtag, con el motivo
 * "Búsqueda: <término>" (searchBase).
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
    const { title, sentiment, unclassified } = await classifyPost(post.caption, { platformLabel });
    const term = post.sourceQuery || literalMatch;
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

  if (literalMatch) {
    // La relevancia acá NO depende del LLM: ya matcheó una palabra clave. Si
    // el clasificador falla, el posteo entra igual, sin título ni sentimiento.
    const { title, sentiment, unclassified } = await classifyPost(post.caption, { platformLabel });
    const base =
      post.sourceType === 'account'
        ? `Cuenta trackeada: @${post.account} (coincidencia: "${literalMatch}")`
        : post.sourceType === 'search'
          ? `${searchBase(post)} (coincidencia: "${literalMatch}")`
          : `Coincidencia con palabra clave: "${literalMatch}"`;
    return {
      relevant: true,
      title,
      sentiment,
      unclassified,
      matchedReason: unclassified ? `${base} — sin clasificar` : base,
    };
  }

  const result = await classifyRelevance(post.caption, { platformLabel });
  if (!result.relevant) return { relevant: false };

  // Sin palabra clave literal y con el clasificador caído no sabemos si es
  // relevante. Se guarda igual, marcado, para que alguien lo revise: un falso
  // positivo se ve y se borra; uno descartado en silencio no vuelve nunca.
  if (result.unclassified) {
    const origen =
      post.sourceType === 'account'
        ? `Cuenta trackeada: @${post.account}`
        : post.sourceType === 'search'
          ? searchBase(post)
          : 'Hashtag monitoreado';
    return {
      relevant: true,
      title: null,
      sentiment: null,
      unclassified: true,
      matchedReason: `${origen} — sin clasificar (falló el clasificador, relevancia sin verificar)`,
    };
  }

  const matchedReason =
    post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account} (relacionado por contenido)`
      : post.sourceType === 'search'
        ? `${searchBase(post)} (relacionado por contenido)`
        : 'Relacionado por contenido (sin palabra clave literal)';
  return { relevant: true, title: result.title, sentiment: result.sentiment, matchedReason };
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
  const lookback = process.env.MONITOR_LOOKBACK || '1 day';
  const ids = listPlatformIds().filter((id) => !plataformas || plataformas.includes(id));
  const singlePlatformRun = Boolean(plataformas && plataformas.length === 1);

  let checked = 0;
  const newPosts = [];
  const scrapedAccounts = {};
  const porPlataforma = {};
  let metricsRefreshedFree = 0;

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
    // Búsqueda por palabra clave (lista `searches`): solo si el adapter
    // sabe buscar. Con IG_ACTOR=apify no hay búsqueda: los términos quedan
    // configurados, pero se avisa y se ignoran en esta corrida.
    const canSearch = typeof platform.scrapeSearch === 'function';
    if (searches.length > 0 && !canSearch) {
      console.warn(
        `[monitor] ${platformId}: hay ${searches.length} búsqueda(s) por palabra clave configuradas pero el proveedor activo ` +
          `no busca (en Instagram hace falta IG_ACTOR=apidojo): se ignoran en esta corrida.`
      );
    }

    // Cada búsqueda va en la fase 'busqueda' del registro de gasto
    // (src/apifyCost.js), heredando el ciclo del contexto del scheduler.
    const sourceResults = await Promise.allSettled([
      ...accounts.map((account) => platform.scrapeAccount(account, { resultsLimit: limits.account, lookback })),
      ...hashtagTags.map((tag) => platform.scrapeHashtag(tag, { resultsLimit: limits.hashtag, lookback })),
      ...(canSearchKeywords
        ? textKeywords.map((keyword) => platform.scrapeKeyword(keyword, { resultsLimit: limits.search, lookback }))
        : []),
      ...(canSearch
        ? searches.map((term) =>
            runWithContext({ phase: 'busqueda' }, () => platform.scrapeSearch(term, { resultsLimit: limits.search, lookback }))
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
    // validó y entra sin classifyRelevance; la cuenta trackeada ('account')
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
      if (!evaluation.relevant) continue;

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

      const inserted = db.saveDetectedPost(postWithClassification);
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
    scrapedAccounts[platformId] = [...accounts];

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
async function backfillClassification(platformId = DEFAULT_PLATFORM_ID) {
  const platform = getPlatform(platformId);
  const pending = db.listUnclassified({ plataforma: platformId });
  let classified = 0;
  let stillPending = 0;

  for (const row of pending) {
    const { title, sentiment, unclassified } = await classifyPost(row.caption, { platformLabel: platform.label });
    if (unclassified) {
      // Sigue fallando: no pisamos la fila con los mismos nulls, queda
      // pendiente para el próximo intento.
      stillPending++;
      continue;
    }
    db.updateClassification(row.id, { title, sentiment });
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
  // Expuestos para tests.
  evaluateRelevance,
  pickMetrics,
};
