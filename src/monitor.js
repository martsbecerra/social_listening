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
const { CATEGORIA_FALLBACK } = require('./categoriasConfig');
const { checkAndLogJump } = require('./viralJumpDetector');
const { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID } = require('./platforms');
const { isPlatformError } = require('./platforms/errors');
const { motivoDeFallo, motivoCorto } = require('./runStatus');
const { searchWait } = require('./searchWait');
const { usdForCall, maxUsdForSearch } = require('./apifyCost');
const busquedaTope = require('./busquedaTope');
const { runWithContext, getContext } = require('./usageContext');
const progress = require('./monitoringProgress');
const { resolveBackfillMax } = require('./backfillConfig');
const db = require('./db');
const { syncPostImages } = require('./postImageSync');

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
// cada cuenta, hashtag o búsqueda es un run aparte). Cuentas y hashtags
// coinciden con los posteos incluidos en cada consulta del actor apidojo
// (perfil 10, hashtag 30); la búsqueda incluye 20 y se piden hasta 100
// (era 50): es un tope de seguridad que en la práctica no se llena (ninguna
// búsqueda pasó de 7 en septiembre 2026) y solo cuesta si hay resultados
// (0,0005 usd por posteo de más), así que va holgado para un día viral. Con
// IG_ACTOR=apify son el resultsLimit de siempre. MONITOR_RESULTS_LIMIT (un
// solo tope para todo) ya no se usa; si sigue en el .env y faltan los topes
// nuevos, vale para cuentas y hashtags con un aviso, así un .env viejo se
// comporta igual que antes.
const DEFAULT_LIMITS = { account: 10, hashtag: 30, search: 100 };
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
// server. 30 días (era 7): con 7, una caída de más de una semana perdía lo
// publicado antes; y como cada búsqueda cuesta por consulta más 0,0005 por
// posteo de más, recuperar un mes entero son centavos.
const DEFAULT_LOOKBACK_MAX_DAYS = 30;
// La ventana dinámica sube los topes de resultados proporcionalmente
// cuando supera 1 día (ver raiseLimitForWindow), pero nunca más de esta
// cantidad de veces el tope configurado. 10 (era 5): con el techo de 30
// días, 5x no alcanzaba para que una recuperación larga no cortara por
// cantidad en vez de por fecha; el excedente se paga, no se corta.
const RAISE_LIMIT_CEILING_FACTOR = 10;

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

/** MONITOR_LOOKBACK_MAX a milisegundos (default 30 días): el techo de la ventana. */
function parseLookbackMaxMs(raw) {
  return parseWindowMs(raw, DEFAULT_LOOKBACK_MAX_DAYS * DAY_MS);
}

/** MONITOR_LOOKBACK a milisegundos (default 1 día): la ventana de la primera corrida. */
function parseFirstRunLookbackMs(raw) {
  return parseWindowMs(raw, DAY_MS);
}

/** MONITOR_MIN_WINDOW a milisegundos (default 1 día): lo mínimo que mira hacia atrás cada consulta. */
function parseMinWindowMs(raw) {
  return parseWindowMs(raw, DAY_MS);
}

/**
 * Clave en refresh_state de la marca de detección de UNA fuente:
 * `detection_last_success:<red>:<tipo>:<clave>` (tipo: busqueda | cuenta |
 * hashtag | keyword; la clave, normalizada como sourceKey). La de la red
 * entera sigue siendo `detection_last_success:<red>`.
 */
function sourceMarkKey(platformId, tipo, fuente) {
  return `detection_last_success:${platformId}:${tipo}:${sourceKey(fuente)}`;
}

/**
 * Ventana de detección de UNA fuente (desde noviembre 2026; antes había una
 * sola por red): cada búsqueda de Instagram, y en X cada cuenta, hashtag y
 * keyword. Va desde la última detección exitosa DE ESA FUENTE (su marca en
 * refresh_state, ver sourceMarkKey y las reglas de avance en
 * runMonitoringCycle) hasta `now`:
 *   - nunca menos que MONITOR_MIN_WINDOW (default 1 día): con el cron al día
 *     cada consulta sigue mirando 24 h hacia atrás, como siempre;
 *   - nunca más que MONITOR_LOOKBACK_MAX (default 30 días): una caída larga
 *     no dispara una recuperación sin fin. Si el techo recorta, `huecoDesde`
 *     dice desde cuándo NO se pidió (queda registrado en la fila de la
 *     fuente);
 *   - sin marca (una fuente nueva), MONITOR_LOOKBACK (default 1 día).
 * Con la marca por red, una búsqueda que fallaba dos corridas seguidas
 * perdía esos días: la marca avanzaba igual porque las demás habían
 * respondido (corridas #55 y #56 del piloto).
 *
 * `cubiertoHasta`: una corrida de esa fuente que quedó en Apify y se acaba
 * de levantar ya cubrió hasta su lanzamiento; la ventana arranca desde ahí
 * si es posterior a la marca.
 *
 * Sin `tipo` y `fuente` devuelve la ventana de la RED (la marca
 * `detection_last_success:<platformId>`, que se sigue escribiendo cuando
 * todas las fuentes avanzaron): es lo que usaría el código anterior.
 *
 * Se redondea hacia arriba a días enteros para `lookback` (el string que
 * reciben los adapters que no entienden otra cosa); `sinceIso` es el
 * instante exacto, y el adapter de apidojo arma su `until` con él.
 *
 * @param {string} platformId
 * @param {{ now?: number, tipo?: string|null, fuente?: string|null, cubiertoHasta?: string|null }} [options]
 *   `now` inyectable para tests (reloj fijo).
 * @returns {{ lookback: string, windowDays: number, isDefault: boolean, sinceIso: string,
 *   origen: 'primera'|'marca'|'minimo'|'techo', huecoDesde: string|null }}
 */
function detectionWindowFor(platformId, { now = Date.now(), tipo = null, fuente = null, cubiertoHasta = null } = {}) {
  const ceilingMs = now - parseLookbackMaxMs(process.env.MONITOR_LOOKBACK_MAX);
  const key = tipo && fuente ? sourceMarkKey(platformId, tipo, fuente) : `detection_last_success:${platformId}`;
  const markMs = Date.parse(db.getRefreshState(key) || '');
  const coveredMs = Date.parse(cubiertoHasta || '');
  const known = [markMs, coveredMs].filter(Number.isFinite);

  let origen = known.length > 0 ? 'marca' : 'primera';
  let sinceMs = known.length > 0 ? Math.max(...known) : now - parseFirstRunLookbackMs(process.env.MONITOR_LOOKBACK);
  const minMs = now - parseMinWindowMs(process.env.MONITOR_MIN_WINDOW);
  if (sinceMs > minMs) {
    sinceMs = minMs;
    if (origen === 'marca') origen = 'minimo';
  }
  let huecoDesde = null;
  if (sinceMs < ceilingMs) {
    // Lo anterior al techo no se pide: si había marca, queda un hueco.
    if (origen !== 'primera') huecoDesde = new Date(sinceMs).toISOString();
    sinceMs = ceilingMs;
    origen = 'techo';
  }
  const windowDays = Math.max(1, Math.ceil((now - sinceMs) / DAY_MS));
  // Singular en 1 para que el caso normal (cron al día) sea BYTE A BYTE el
  // mismo string que el fijo de antes ("1 day"); parseLookbackMs entiende
  // los dos igual (la "s" del plural es opcional en su regex).
  return {
    lookback: `${windowDays} day${windowDays === 1 ? '' : 's'}`,
    windowDays,
    isDefault: windowDays === 1,
    sinceIso: new Date(sinceMs).toISOString(),
    origen,
    huecoDesde,
  };
}

/**
 * Migración de las marcas de detección al esquema por fuente. La primera
 * vez (sin `detection_por_fuente:<red>`) cada fuente configurada arranca en
 * la marca de la RED, que es exactamente lo que habría usado el código
 * anterior: la primera corrida después del cambio no pide más atrás que la
 * que habría corrido sin él (decisión del dueño, 16/11/2026: el hueco que
 * dejaron las corridas caídas de noviembre queda sin cubrir a propósito).
 *
 * Después, `detection_por_fuente:<red>` guarda el valor de la marca de la
 * red que este código vio o escribió por última vez. Si no coincide con la
 * marca actual, corrió código anterior en el medio (se volvió atrás y se
 * volvió a subir): cada fuente pasa al máximo entre su marca y la de la
 * red, para no pedir de nuevo lo que ese código ya dio por detectado.
 * Nunca tira.
 */
function migrateDetectionMarks(platformId, sources) {
  try {
    const flagKey = `detection_por_fuente:${platformId}`;
    const network = db.getRefreshState(`detection_last_success:${platformId}`) || '';
    const flag = db.getRefreshState(flagKey);
    if (flag === network) return;
    let movidas = 0;
    if (Number.isFinite(Date.parse(network))) {
      for (const { tipo, fuente } of sources) {
        if (db.advanceRefreshState(sourceMarkKey(platformId, tipo, fuente), network)) movidas += 1;
      }
    }
    db.setRefreshState(flagKey, network);
    console.log(
      `[monitor] ${platformId}: marcas de detección por fuente ${flag === null ? 'creadas' : 'alineadas'} desde la marca de la red ` +
        `(${network || 'sin marca'}): ${movidas} de ${sources.length} fuente(s).`
    );
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudieron migrar las marcas de detección:`, err.message);
  }
}

/** Borra las marcas de las fuentes que ya no están configuradas en esa red. Nunca tira. */
function cleanupStaleMarks(platformId, sources) {
  try {
    const vigentes = new Set(sources.map(({ tipo, fuente }) => sourceMarkKey(platformId, tipo, fuente)));
    for (const { key } of db.listRefreshStateByPrefix(`detection_last_success:${platformId}:`)) {
      if (!vigentes.has(key)) db.deleteRefreshState(key);
    }
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudieron limpiar las marcas de detección huérfanas:`, err.message);
  }
}

/** Sacar una fuente (o darla de alta de nuevo) borra su marca: vuelve a ser una fuente nueva. Nunca tira. */
function forgetSourceMark(platformId, tipo, fuente) {
  try {
    db.deleteRefreshState(sourceMarkKey(platformId, tipo, fuente));
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudo borrar la marca de detección de ${fuente}:`, err.message);
  }
}

/** El tipo de fuente de una keyword de la config: con "#" es un hashtag. */
function keywordSourceType(keyword) {
  return String(keyword || '').trim().startsWith('#') ? 'hashtag' : 'keyword';
}

/**
 * Avanza las marcas de detección de las fuentes de un ciclo, según cómo le
 * fue a cada una:
 *   - ok: la marca pasa al inicio del ciclo;
 *   - parcial (Apify cortó la corrida): la primera vez no avanza (se vuelve
 *     a pedir todo); la segunda seguida sí, para que la ventana no crezca
 *     sin fin: la pérdida queda registrada en su fila;
 *   - fallo o esperando: no avanza. Una fuente que todavía no tenía marca
 *     queda con la del inicio de la ventana que se intentó: el reintento
 *     pide más, no arranca de cero;
 *   - una fuente salteada (su corrida anterior sigue en Apify): no avanza.
 * Nunca tira.
 * @returns {boolean} true si TODAS las fuentes avanzaron al inicio del ciclo
 */
function advanceSourceMarks(platformId, outcomes, cycleNowMs) {
  const cycleIso = new Date(cycleNowMs).toISOString();
  let todas = true;
  for (const outcome of outcomes) {
    try {
      const { tipo, fuente, window } = outcome.source;
      const key = sourceMarkKey(platformId, tipo, fuente);
      let avanza = outcome.estado === 'ok';
      if (outcome.estado === 'parcial') {
        const previas = db.lastRunSourcesForKey({ plataforma: platformId, tipo, clave: sourceKey(fuente), limit: 2 });
        avanza = previas.length >= 2 && previas[1].estado === 'parcial';
        if (avanza) console.warn(`[monitor] ${platformId}: ${tipo} «${fuente}» quedó parcial dos veces seguidas: la marca avanza igual y lo que faltó queda registrado.`);
      }
      if (avanza) {
        db.advanceRefreshState(key, cycleIso);
      } else {
        todas = false;
        if (window) db.initRefreshState(key, window.sinceIso);
      }
    } catch (err) {
      todas = false;
      console.error(`[monitor] (${platformId}) no se pudo guardar la marca de detección de una fuente:`, err.message);
    }
  }
  return todas;
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
// consultado (tabla search_seen). 100 (era 20): lo que no entra solo vuelve
// si la búsqueda lo trae de nuevo dentro de la ventana, así que un tope
// chico en un día con muchos resultados perdía posteos. Solo cuesta si hay
// volumen (0,0023 usd por posteo nuevo).
const DEFAULT_SEARCH_ENRICH_LIMIT = 100;
// 100 días (era 30): Estadísticas cuenta los descartados por término en
// períodos de hasta 90 días, y un descartado recordado más tiempo tampoco se
// vuelve a pagar si una búsqueda lo trae otra vez.
const SEARCH_SEEN_TTL_DAYS = 100;

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
  forgetSourceMark(platformId, 'cuenta', account);
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
  forgetSourceMark(platformId, keywordSourceType(keyword), keyword);
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
  // Un término que se da de alta (aunque haya existido antes) es una fuente nueva.
  if (clean) forgetSourceMark(platformId, 'busqueda', clean);
  if (!clean) {
    const e = new Error('Búsqueda vacía');
    e.userMessage = 'Escribí un término de búsqueda.';
    throw e;
  }
  const platform = getPlatform(platformId);
  if (typeof platform.scrapeSearch !== 'function') {
    const e = new Error(`La plataforma ${platformId} no busca por palabra clave`);
    if (platformId === DEFAULT_PLATFORM_ID) {
      // El nombre de la variable, solo en el log: el userMessage va al navegador.
      console.warn('[monitor] búsqueda rechazada: el actor activo de Instagram no busca por palabra clave; IG_ACTOR=apidojo en el .env (y reiniciar) lo habilita.');
      e.userMessage =
        'El actor de Instagram configurado no busca por palabra clave. Falta configuración del servidor.';
    } else {
      e.userMessage = `${platform.label || platformId} no tiene búsqueda por palabra clave aparte: usá las palabras clave.`;
    }
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
  forgetSourceMark(platformId, 'busqueda', term);
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
 * Actualiza la caché de seguidores (account_followers) y los posteos ya
 * guardados de esa cuenta con lo que trajo una respuesta del adapter, en
 * cualquier fase (detección, benchmark,
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
      // Y a los posteos ya guardados de esa cuenta: un resultado de búsqueda
      // se guarda antes de que nadie consulte el perfil (seguidores null) y
      // el refresco suele ser el primero que trae el dato. Antes solo el
      // benchmark lo propagaba, y hasta que le tocaba a esa cuenta el posteo
      // quedaba en "-" (11 posteos el 25/9/2026).
      db.updateFollowersForAccount(post.account, post.followers, platformId);
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
 * @param {{ platform?: object, onUsage?: (usage: object) => void }} [options]
 *   platform: el adapter, para etiquetar el prompt. onUsage: aviso con lo
 *   que gastó la llamada al modelo (ver classifier.clasificarPosteo).
 */
async function evaluateRelevance(post, keywords, { platform, onUsage } = {}) {
  const platformLabel = platform && platform.label ? platform.label : undefined;
  const text = `${post.caption || ''} ${post.hashtagsText || ''}`.trim();

  if (!post.caption || !post.caption.trim()) {
    if (post.sourceType === 'account') {
      // Sin texto no hay de qué sacar un tema: el de fallback, igual que el
      // clasificador con un caption vacío.
      return {
        relevant: true,
        title: 'Sin descripción',
        sentiment: 'neutral',
        tema: CATEGORIA_FALLBACK,
        matchedReason: `Cuenta trackeada: @${post.account}`,
      };
    }
    return { relevant: false };
  }

  const literalMatch = textIncludesAny(text, keywords);

  if (post.sourceType === 'keyword') {
    const term = post.sourceQuery || literalMatch;
    const { title, sentiment, tema, unclassified } = await clasificarPosteo(post.caption, { platformLabel, pista: { busqueda: term }, onUsage });
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
      tema,
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
  const result = await clasificarPosteo(post.caption, { platformLabel, pista, onUsage });

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
      tema: null,
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
    tema: result.tema,
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

/**
 * ¿Es un posteo "nuevo" para el monitoreo? Nuevo = no está guardado en
 * detected_posts ni anotado en search_seen (ya se pagó su detalle y se lo
 * evaluó en un ciclo anterior). Es lo que cuenta la pantalla en todos lados:
 * "50 encontrados, 6 nuevos" por fuente y "N relevantes guardados de M
 * nuevos" al final.
 */
function isNewPost(post, platformId) {
  if (!post || !post.url) return false;
  return !db.findExistingPostId(post.id, post.url) && !db.isSearchSeen(post.id, platformId);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * El final de la línea de una fuente en el progreso: "50 encontrados, 6
 * nuevos", "3 encontrados, ninguno nuevo" o "sin resultados". Cuenta posteos
 * distintos. Nunca tira: es texto para la pantalla, no puede frenar el ciclo.
 */
function describeFound(posts, platformId) {
  const byId = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    if (post && post.id !== undefined && post.id !== null) byId.set(String(post.id), post);
  }
  if (byId.size === 0) return 'sin resultados';
  const found = plural(byId.size, 'encontrado', 'encontrados');
  try {
    let fresh = 0;
    for (const post of byId.values()) if (isNewPost(post, platformId)) fresh += 1;
    return `${found}, ${fresh === 0 ? 'ninguno nuevo' : plural(fresh, 'nuevo', 'nuevos')}`;
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudo contar los posteos nuevos de una fuente:`, err.message);
    return found;
  }
}

/**
 * Nunca tira: no poder anotar un visto no puede frenar el ciclo (a lo sumo
 * ese posteo se vuelve a evaluar). `extra`: el motivo del modelo, lo que
 * costó la clasificación, la corrida y todos los términos que lo trajeron.
 */
function markSearchSeen(post, platformId, outcome, { motivo = null, llmUsd = null, runId = null, terminos = null } = {}) {
  try {
    db.markSearchSeen({
      postId: post.id,
      plataforma: platformId,
      url: post.url,
      term: post.sourceQuery,
      outcome,
      postedAt: post.postedAt || null,
      motivo,
      llmUsd,
      runId,
      terminos,
    });
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
 *   - Tope por ciclo SEARCH_ENRICH_LIMIT (default 100, 0 apaga el paso): van
 *     primero los más nuevos; el resto queda SIN anotar y entra en el próximo
 *     ciclo si la búsqueda lo sigue trayendo (si ya no lo trae, se perdió:
 *     por eso el tope es holgado).
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

  // El detalle también deja su fila: si falla, la corrida no fue completa
  // (los nuevos sin texto no se pudieron evaluar).
  const detalleStartedMs = Date.now();
  const detalleRow = abrirFuente({ plataforma: platformId, tipo: 'detalle', fuente: null, clave: null, tope: batch.length });
  let details;
  try {
    details = await runWithContext({ phase: 'busqueda' }, () => platform.fetchPostDetails(batch.map((post) => post.url)));
    actualizarFuente(detalleRow, { estado: 'ok', items: Array.isArray(details) ? details.length : 0 }, { startedMs: detalleStartedMs });
  } catch (err) {
    actualizarFuente(detalleRow, { estado: 'fallo', motivo: motivoDeFallo(err), detalle: err && err.message }, { startedMs: detalleStartedMs });
    stats.failed = true;
    progress.setPhaseSummary('Detalle de búsquedas', { detail: 'falló', ok: false });
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
      // Link de la imagen (ver src/postImages.js): el del detalle, que es la
      // imagen entera; el resultado de búsqueda trae una versión más chica.
      imageUrl: detail.imageUrl || post.imageUrl || null,
    });
    out.enriched.add(post.id);
    stats.enriched += 1;
  }
  // Resumen de la fase para la pantalla (src/monitoringProgress.js).
  const withoutText = stats.noCaption + stats.noDetail;
  progress.setPhaseSummary('Detalle de búsquedas', {
    detail: plural(stats.requested, 'posteo nuevo', 'posteos nuevos') + (withoutText > 0 ? `, ${withoutText} sin texto` : ''),
  });

  console.log(
    `[monitor] ${platformId}: detalle de ${stats.requested} resultado(s) de búsqueda sin caption → ${stats.enriched} con texto, ` +
      `${stats.noCaption} sin caption, ${stats.noDetail} sin detalle` +
      (stats.deferred > 0 ? `; ${stats.deferred} quedan para el próximo ciclo (SEARCH_ENRICH_LIMIT=${limit})` : '') +
      (alreadySeen > 0 ? `; ${alreadySeen} ya consultado(s) antes` : '') +
      '.'
  );
  return out;
}

/**
 * La clave de una fuente: como está en la config pero sin espacios de más,
 * en minúsculas y sin el "@" o el "#" de adelante. Es la de su fila en
 * monitoring_run_sources y la de su marca de detección.
 */
function sourceKey(fuente) {
  return String(fuente ?? '').trim().toLowerCase().replace(/^[@#]/, '');
}

/** Abre la fila de una consulta de detección. Nunca tira: sin fila el ciclo sigue (devuelve null). */
function abrirFuente(fields) {
  try {
    return db.startRunSource({ runId: (getContext() || {}).runId ?? null, ...fields, clave: fields.clave ?? (fields.fuente ? sourceKey(fields.fuente) : null) });
  } catch (err) {
    console.error(`[monitor] (${fields.plataforma}) no se pudo registrar la fuente ${fields.fuente || fields.tipo}:`, err.message);
    return null;
  }
}

/** Cambia (o cierra) la fila de una consulta de detección. Nunca tira. */
function actualizarFuente(id, fields, { startedMs = null } = {}) {
  if (id == null) return;
  try {
    const cierre = fields.estado && fields.estado !== 'en curso' && !fields.finishedAt ? { finishedAt: new Date().toISOString() } : {};
    const duracion = startedMs != null && fields.estado && fields.estado !== 'en curso' ? { duracionMs: Date.now() - startedMs } : {};
    db.updateRunSource(id, { ...cierre, ...duracion, ...fields });
  } catch (err) {
    console.error('[monitor] no se pudo actualizar el registro de una fuente:', err.message);
  }
}

/** Posteos distintos de una respuesta que son nuevos para el monitoreo (ver isNewPost). Nunca tira. */
function contarNuevos(posts, platformId) {
  try {
    const vistos = new Set();
    let nuevos = 0;
    for (const post of Array.isArray(posts) ? posts : []) {
      if (!post || post.id === undefined || post.id === null || vistos.has(String(post.id))) continue;
      vistos.add(String(post.id));
      if (isNewPost(post, platformId)) nuevos += 1;
    }
    return nuevos;
  } catch {
    return null;
  }
}

/** "04/11 16:00": día y hora de Argentina (UTC-3 fija) de un instante, para decir desde cuándo retoma una fuente. */
function diaHoraArgentina(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '—';
  const t = new Date(ms - 3 * 60 * 60 * 1000).toISOString();
  return `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 16)}`;
}

/** "12:00": la hora de Argentina (UTC-3 fija) de un instante, para decir de qué corrida es algo. */
function horaArgentina(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(11, 16) : '—';
}

// Una corrida que quedó esperando y no se pudo leer en todo este tiempo se
// da por perdida: Apify ya no la guarda.
const PENDING_LOST_AFTER_MS = 7 * DAY_MS;

/**
 * Levanta las búsquedas que un ciclo anterior dejó esperando en Apify (la
 * corrida no terminó dentro de SEARCH_WAIT_MS, o el proceso se cayó con la
 * consulta abierta). Va al empezar la detección de la red, bajo el candado
 * del ciclo. Solo lee de Apify: no cuesta ni pasa por la cola.
 *
 * Por cada fila pendiente de monitoring_run_sources:
 *   - terminó: sus posteos van a `candidates` (pasan por la misma tubería
 *     que cualquier resultado: dedupe, detalle, clasificación) y la fila se
 *     cierra DESPUÉS de procesarlos (cerrarRecuperadas), así un corte en el
 *     medio la vuelve a levantar en el ciclo siguiente;
 *   - sigue corriendo (o no se pudo leer y todavía puede estar corriendo):
 *     ese término no se busca en este ciclo (`saltear`): sería pagar dos
 *     veces lo mismo;
 *   - ya no existe en Apify: `perdida`, con su línea de log;
 *   - el término ya no está configurado: `sin_fuente`, sin leer nada;
 *   - no era una corrida de Apify (quedó abierta por una caída): `fallo`.
 * Nunca tira.
 * @returns {Promise<{ candidates: object[], recuperadas: object[], saltear: Set<string>, cubiertoHasta: Map<string, string> }>}
 *   cubiertoHasta: por clave de término, cuándo se lanzó la corrida que se
 *   levantó: hasta ahí ya está cubierto.
 */
async function recoverPendingSearchRuns(platform, platformId, { searches = [] } = {}) {
  const out = { candidates: [], recuperadas: [], saltear: new Set(), cubiertoHasta: new Map() };
  let pendientes = [];
  try {
    pendientes = db.listPendingRunSources(platformId);
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudieron leer las búsquedas pendientes:`, err.message);
    return out;
  }
  if (pendientes.length === 0) return out;

  const configuradas = new Set(searches.map(sourceKey));
  const espera = searchWait();
  const now = Date.now();
  const cierre = (row) => row.finishedAt || new Date(now).toISOString();
  const aLeer = [];
  for (const row of pendientes) {
    if (row.tipo !== 'busqueda' || !row.apifyRunId || typeof platform.recoverSearchRun !== 'function') {
      actualizarFuente(row.id, { estado: 'fallo', motivo: row.motivo || 'INTERRUMPIDA', finishedAt: cierre(row) });
      continue;
    }
    if (!configuradas.has(row.clave)) {
      actualizarFuente(row.id, { estado: 'sin_fuente', finishedAt: cierre(row) });
      console.log(`[monitor] ${platformId}: la búsqueda «${row.fuente}» quedó esperando en Apify pero ya no está configurada: no se levanta.`);
      continue;
    }
    aLeer.push(row);
  }
  if (aLeer.length === 0) return out;

  progress.startPhase('Recuperando búsquedas pendientes', aLeer.length, { suffix: 'corridas' });
  let levantadas = 0;
  let encontrados = 0;
  await Promise.all(
    aLeer.map(async (row) => {
      const key = `${platformId}:pendiente:${row.id}`;
      progress.startItem(key, `«${row.fuente}» · de la corrida de las ${horaArgentina(row.startedAt)}`, 'leyendo…');
      let r;
      try {
        r = await platform.recoverSearchRun({ actor: row.actor, apifyRunId: row.apifyRunId, termino: row.fuente, desdeIso: row.desdeIso });
      } catch (err) {
        r = { estado: 'desconocido', error: err };
      }
      const edadMs = now - Date.parse(row.startedAt);
      if (r && (r.estado === 'ok' || r.estado === 'parcial')) {
        const posts = Array.isArray(r.posts) ? r.posts : [];
        out.candidates.push(...posts);
        out.recuperadas.push({ row, estado: r.estado, rawItems: r.rawItems != null ? r.rawItems : posts.length, nuevos: contarNuevos(posts, platformId), runStatus: r.runStatus || null });
        // Solo una corrida que terminó bien cubre hasta su lanzamiento: de
        // una que Apify cortó puede faltar algo, y se vuelve a pedir.
        if (r.estado === 'ok') {
          const previo = out.cubiertoHasta.get(row.clave);
          if (!previo || row.startedAt > previo) out.cubiertoHasta.set(row.clave, row.startedAt);
        }
        levantadas += 1;
        encontrados += posts.length;
        progress.finishItem(key, { ok: true, detail: describeFound(posts, platformId) });
        progress.tick(1, { ok: true });
        console.log(`[monitor] ${platformId}: se levantó la búsqueda «${row.fuente}» que había quedado en Apify (run ${row.apifyRunId}, ${r.runStatus || 'terminada'}): ${posts.length} posteo(s).`);
      } else if (r && r.estado === 'corriendo') {
        out.saltear.add(row.clave);
        progress.finishItem(key, { state: 'wait', detail: 'sigue en Apify' });
        progress.tick(1, { ok: null });
        console.log(`[monitor] ${platformId}: la búsqueda «${row.fuente}» sigue corriendo en Apify (run ${row.apifyRunId}): no se vuelve a lanzar en este ciclo.`);
      } else if ((r && r.estado === 'perdida') || edadMs > PENDING_LOST_AFTER_MS) {
        actualizarFuente(row.id, { estado: 'perdida', finishedAt: cierre(row), recuperadaAt: new Date(now).toISOString() });
        try {
          db.markApifyCallLost(row.apifyRunId);
        } catch (err) {
          console.error(`[monitor] (${platformId}) no se pudo marcar la llamada perdida:`, err.message);
        }
        progress.finishItem(key, { ok: false, detail: 'ya no está en Apify' });
        progress.tick(1, { ok: false });
        console.warn(`[monitor] ${platformId}: la corrida ${row.apifyRunId} de «${row.fuente}» ya no está en Apify: sus resultados se perdieron.`);
      } else {
        // No se pudo leer ahora. Si todavía puede estar corriendo, el
        // término se saltea; si no, se busca normal y esta se reintenta.
        if (edadMs <= espera.runTimeoutSecs * 1000) out.saltear.add(row.clave);
        progress.finishItem(key, { state: 'wait', detail: 'no se pudo leer' });
        progress.tick(1, { ok: null });
        console.warn(`[monitor] ${platformId}: no se pudo leer la corrida ${row.apifyRunId} de «${row.fuente}» (se reintenta en el próximo ciclo): ${(r && r.error && r.error.message) || 'sin detalle'}`);
      }
    })
  );
  progress.setPhaseSummary('Recuperando búsquedas pendientes', {
    label: 'Recuperadas',
    detail: `${plural(levantadas, 'corrida', 'corridas')}, ${plural(encontrados, 'encontrado', 'encontrados')}`,
    ok: levantadas > 0 || aLeer.length === 0,
  });
  return out;
}

/**
 * Cierra las filas de las búsquedas que se levantaron en este ciclo, DESPUÉS
 * de procesar sus posteos: la fila pasa a `recuperada` (o `parcial` si Apify
 * había cortado la corrida) y su llamada en apify_calls a una llamada buena
 * con lo que trajo. Nunca tira.
 */
function cerrarRecuperadas(recovery, { platformId, runId }) {
  for (const { row, estado, rawItems, nuevos, runStatus } of recovery.recuperadas) {
    const ahora = new Date().toISOString();
    actualizarFuente(row.id, {
      estado: estado === 'ok' ? 'recuperada' : 'parcial',
      motivo: row.motivo || (estado === 'ok' ? 'TIMEOUT' : `RUN_${String(runStatus || 'FAILED').replace('-', '_')}`),
      items: rawItems,
      nuevos,
      recuperadaEn: runId,
      recuperadaAt: ahora,
      finishedAt: row.finishedAt || ahora,
    });
    // Lo levantado ya está procesado: la marca de esa fuente llega, como
    // mínimo, hasta el lanzamiento de esa corrida.
    if (estado === 'ok') {
      try {
        db.advanceRefreshState(sourceMarkKey(platformId, row.tipo, row.fuente), row.startedAt);
      } catch (err) {
        console.error(`[monitor] (${platformId}) no se pudo avanzar la marca de «${row.fuente}»:`, err.message);
      }
    }
    try {
      db.markApifyCallRecovered(row.apifyRunId, { items: rawItems, usd: usdForCall({ actor: row.actor, queryType: 'search', items: rawItems }) });
    } catch (err) {
      console.error(`[monitor] (${platformId}) no se pudo actualizar la llamada recuperada ${row.apifyRunId}:`, err.message);
    }
  }
}

/** Junta dos respuestas de la misma búsqueda sin repetir posteos (por id; gana el primero que llegó). */
function unirPosteos(primeros, segundos) {
  const vistos = new Set(primeros.map((p) => String(p && p.id)));
  const out = [...primeros];
  for (const post of segundos) {
    if (!post || vistos.has(String(post.id))) continue;
    vistos.add(String(post.id));
    out.push(post);
  }
  return out;
}

/** Suma a un resultado ya anotado los términos que lo trajeron en esta corrida. Nunca tira. */
function addSearchTerms(post, platformId, termsById) {
  const terminos = termsById.get(String(post.id));
  if (!terminos || terminos.length === 0) return;
  try {
    db.addSearchSeenTerms(post.id, platformId, terminos);
  } catch (err) {
    console.error(`[monitor] (${platformId}) no se pudieron sumar los términos del resultado ${post.id}:`, err.message);
  }
}

/**
 * Guarda (o descarta) un posteo NUEVO ya evaluado y deja anotada la decisión
 * del modelo. Es el final del pipeline de un posteo: lo usa el ciclo y lo
 * puede usar cualquier otro camino que traiga candidatos (una búsqueda que
 * se levanta después).
 *
 * search_seen (solo resultados de búsqueda, sourceType 'search'):
 *   - 'descartado' si había texto y el modelo dijo que no es relevante: no
 *     se vuelve a clasificar aunque otra búsqueda lo traiga. Antes solo se
 *     anotaba si se había pagado el detalle; como las búsquedas ya traen el
 *     texto, los descartados no quedaban anotados y cada corrida los volvía
 *     a clasificar (42 de los 67 nuevos de la corrida del 16/11/2026).
 *   - 'guardado' si entró (o si otro ciclo lo guardó en el medio).
 *   - sin texto no hubo decisión del modelo: no se anota, como antes (el
 *     detalle lo anota como sin_caption o sin_detalle cuando lo paga).
 * @returns {object|null} el posteo guardado con su clasificación, o null si
 *   no entró (descartado, de otra red, o ya estaba).
 */
function guardarEvaluado(post, evaluation, { platform, platformId, terminos = null, llmUsd = null, runId = null }) {
  const anotar = (outcome) => {
    if (post.sourceType !== 'search') return;
    markSearchSeen(post, platformId, outcome, { motivo: evaluation.motivo || null, llmUsd, runId, terminos });
  };
  if (!evaluation.relevant) {
    if (hasCaption(post)) anotar('descartado');
    return null;
  }

  const postWithClassification = {
    ...post,
    plataforma: platformId,
    title: evaluation.title,
    sentiment: evaluation.sentiment,
    tema: evaluation.tema,
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
    return null;
  }
  if (!inserted) {
    // Carrera con otro ciclo: entre el findExisting y el INSERT el otro
    // proceso ya lo guardó. No es un posteo nuevo para notificar.
    const racedId = db.findExistingPostId(post.id, post.url);
    if (racedId) {
      refreshKnownPost(platform, racedId, post);
      anotar('guardado');
    }
    return null;
  }
  anotar('guardado');
  return postWithClassification;
}

function notConfiguredError(platform) {
  // El message (con el .env) va al log; el userMessage, al navegador.
  const e = new Error(`La plataforma ${platform.id} no tiene credenciales configuradas (revisá sus claves en el .env)`);
  e.code = 'NOT_CONFIGURED';
  e.userMessage = `Falta configuración del servidor para ${platform.label || platform.id}.`;
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
 * @param {{ plataformas?: string[], trigger?: 'cron'|'manual' }} [options]
 *   plataformas: subconjunto del registro; sin él, todas. trigger: 'cron'
 *   hace que un error de plataforma NUNCA se tire, aunque la lista tenga una
 *   sola plataforma (MONITOR_PLATFORMS=instagram con X en stand by): se
 *   anota en porPlataforma y el ciclo sigue con benchmark y refresco. Sin
 *   trigger (o 'manual') vale lo de siempre: una sola plataforma = el botón
 *   de esa solapa, el error le llega al usuario.
 * @returns {Promise<{ checked: number, newPosts: object[],
 *   scrapedAccounts: Object<string, string[]>,
 *   porPlataforma: Object<string, { checked: number, newCount: number, skipped: boolean,
 *     error?: { code: string, message: string } }> }>}
 */
async function runMonitoringCycle({ plataformas, trigger } = {}) {
  const all = loadConfigAll();
  const limits = monitorLimits();
  const cycleNowMs = Date.now();
  const ids = listPlatformIds().filter((id) => !plataformas || plataformas.includes(id));
  // Un error de plataforma se le tira al usuario solo en una corrida MANUAL
  // de esa sola plataforma ("Actualizar ahora" en su solapa). En el cron,
  // aunque MONITOR_PLATFORMS lo deje en una sola, se anota y el ciclo sigue.
  const singlePlatformRun = trigger !== 'cron' && Boolean(plataformas && plataformas.length === 1);

  let checked = 0;
  const newPosts = [];
  const scrapedAccounts = {};
  const porPlataforma = {};
  let metricsRefreshedFree = 0;
  // Tope máximo de una búsqueda y techo de gasto de ESTA corrida para las
  // segundas consultas (cuando una búsqueda llena su tope): ver
  // src/busquedaTope.js. El techo no recorta las consultas normales.
  const topeConfig = busquedaTope.topeConfig();
  const presupuestoExtra = busquedaTope.crearPresupuesto({ extraMaxUsd: topeConfig.extraMaxUsd });

  // Resultados de búsqueda ya consultados hace más de SEARCH_SEEN_TTL_DAYS.
  try {
    db.purgeSearchSeen(new Date(Date.now() - SEARCH_SEEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString());
  } catch (err) {
    console.error('[monitor] no se pudieron purgar los resultados de búsqueda vistos:', err.message);
  }

  for (const platformId of ids) {
    const platform = getPlatform(platformId);
    const config = all[platformId] || { accounts: [], keywords: [] };
    porPlataforma[platformId] = { checked: 0, newCount: 0, newCandidates: 0, skipped: false };

    if (typeof platform.isConfigured === 'function' && !platform.isConfigured()) {
      // No se buscó nada en esta red: que quede dicho (la corrida no es "ok").
      abrirFuente({ plataforma: platformId, tipo: 'plataforma', estado: 'fallo', motivo: 'NOT_CONFIGURED', finishedAt: new Date().toISOString() });
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

    // Las fuentes que consulta la detección de esta red, y sus marcas: la
    // ventana es POR FUENTE (ver detectionWindowFor). Antes de mirar ninguna
    // marca se migran desde la de la red (la primera vez, o si corrió código
    // anterior en el medio) y se limpian las de fuentes que ya no están.
    const configuredSources = [
      ...accountsToScrape.map((fuente) => ({ tipo: 'cuenta', fuente })),
      ...hashtagsToScrape.map((fuente) => ({ tipo: 'hashtag', fuente })),
      ...(canSearchKeywords ? textKeywords.map((fuente) => ({ tipo: 'keyword', fuente })) : []),
      ...(canSearch ? searches.map((fuente) => ({ tipo: 'busqueda', fuente })) : []),
    ];
    migrateDetectionMarks(platformId, configuredSources);
    cleanupStaleMarks(platformId, configuredSources);

    // Cada búsqueda va en la fase 'busqueda' del registro de gasto
    // (src/apifyCost.js), heredando el ciclo del contexto del scheduler.
    // Las cuatro fuentes se lanzan juntas (no son fases secuenciales de
    // verdad): el progreso las junta en una sola fase visible, con un tick
    // por cada llamada que termina (bien o mal) — ver src/monitoringProgress.js.
    // Antes de buscar: lo que un ciclo anterior dejó esperando en Apify. Sus
    // posteos se suman a los candidatos de este ciclo; un término cuya
    // corrida anterior sigue corriendo no se vuelve a lanzar.
    const recovery = await recoverPendingSearchRuns(platform, platformId, { searches });
    const searchesToRun = searches.filter((term) => !recovery.saltear.has(sourceKey(term)));
    const searchesSkipped = searches.filter((term) => recovery.saltear.has(sourceKey(term)));

    const detectionTotal =
      accountsToScrape.length + hashtagsToScrape.length + (canSearchKeywords ? textKeywords.length : 0) + (canSearch ? searchesToRun.length : 0);
    // En pantalla: "Buscando posteos nuevos · 5 de 8 listas" (las fuentes
    // corren en paralelo, no hay "la búsqueda actual"). La fase no deja
    // resumen propio: sus líneas son las de cada fuente (lanzarFuente).
    progress.startPhase('Buscando posteos nuevos', detectionTotal, { suffix: 'listas', summary: false });
    if (detectionTotal === 0 && searchesSkipped.length === 0) {
      // No hay nada que consultar en esta red (o el actor activo no busca):
      // la corrida no detectó nada y tiene que verse.
      abrirFuente({
        plataforma: platformId,
        tipo: 'plataforma',
        estado: 'fallo',
        motivo: searches.length > 0 && !canSearch ? 'SIN_BUSQUEDA' : 'SIN_FUENTES',
        finishedAt: new Date().toISOString(),
      });
    }

    // La ventana y el tope de cada fuente: desde SU última detección
    // exitosa (o desde el lanzamiento de la corrida suya que se acaba de
    // levantar). Si la ventana supera 1 día el tope sube proporcionalmente,
    // para no perder posteos por cantidad en vez de por fecha (ver
    // raiseLimitForWindow): el excedente se paga, no se corta.
    const withWindow = (tipo, fuente, baseLimit) => {
      const window = detectionWindowFor(platformId, {
        tipo,
        fuente,
        now: cycleNowMs,
        cubiertoHasta: tipo === 'busqueda' ? recovery.cubiertoHasta.get(sourceKey(fuente)) || null : null,
      });
      let limit = window.isDefault ? baseLimit : raiseLimitForWindow(baseLimit, window.windowDays);
      // Una búsqueda: el tope sale además del volumen medido de ESE término
      // (lo que trajo por hora en sus consultas recientes), nunca menos que
      // el de recién. Pedir un tope más alto no cuesta: se paga por resultado.
      if (tipo === 'busqueda') {
        try {
          const tasa = busquedaTope.tasaTermino(db.lastSearchCallsForTerm(platformId, fuente, busquedaTope.HISTORY_CALLS));
          const horas = busquedaTope.horasPedidas(window.sinceIso, cycleNowMs) || 24;
          limit = busquedaTope.topeParaTermino({ topeDeHoy: limit, tasa, horas, resultsMax: topeConfig.resultsMax });
        } catch (err) {
          console.error(`[monitor] (${platformId}) no se pudo medir el volumen de «${fuente}» (se usa el tope de siempre):`, err.message);
        }
      }
      if (!window.isDefault) {
        console.log(
          `[monitor] ${platformId} ${tipo} «${fuente}»: retoma desde ${window.sinceIso} (${window.windowDays} días; tope ${limit}, base ${baseLimit})` +
            (window.huecoDesde ? `; no respondía desde ${window.huecoDesde}: lo anterior al techo de la ventana no se pide` : '')
        );
      }
      return { tipo, fuente, window, baseLimit, limit };
    };

    // Las fuentes de la detección de esta red, todas con la misma forma:
    // qué son, cómo se muestran y cómo se consultan.
    const sources = [
      ...accountsToScrape.map((account) => ({
        ...withWindow('cuenta', account, limits.account),
        label: `@${account}`,
        run: (options) => platform.scrapeAccount(account, options),
      })),
      ...hashtagsToScrape.map((tag) => ({
        ...withWindow('hashtag', tag, limits.hashtag),
        label: `#${tag}`,
        run: (options) => platform.scrapeHashtag(tag, options),
      })),
      ...(canSearchKeywords
        ? textKeywords.map((keyword) => ({
            ...withWindow('keyword', keyword, limits.search),
            label: `«${keyword}»`,
            run: (options) => platform.scrapeKeyword(keyword, options),
          }))
        : []),
      // Cada búsqueda va en la fase 'busqueda' del registro de gasto
      // (src/apifyCost.js), heredando el ciclo del contexto del scheduler.
      ...(canSearch
        ? searchesToRun.map((term) => ({
            ...withWindow('busqueda', term, limits.search),
            label: `«${term}»`,
            run: (options) => runWithContext({ phase: 'busqueda' }, () => platform.scrapeSearch(term, options)),
          }))
        : []),
    ];

    // Cada fuente deja una línea en el progreso (en curso mientras se
    // consulta; al terminar, cuántos posteos trajo y cuántos son nuevos, o
    // que falló: src/monitoringProgress.js) y una fila en
    // monitoring_run_sources con cómo salió (src/runStatus.js). Nunca tira:
    // devuelve cómo le fue, para que una fuente caída no frene a las demás.
    const lanzarFuente = async (source) => {
      const key = `${platformId}:${source.tipo}:${source.label}`;
      const startedMs = Date.now();
      const rowId = abrirFuente({
        plataforma: platformId,
        tipo: source.tipo,
        fuente: source.fuente,
        actor: platform.actorId || null,
        desdeIso: source.window.sinceIso,
        huecoDesde: source.window.huecoDesde,
        tope: source.limit,
      });
      // Una fuente que se pone al día dice desde cuándo retoma ("«macri» ·
      // desde 04/11 16:00"); si el techo de la ventana recortó, "el máximo".
      const linea = source.window.isDefault
        ? source.label
        : `${source.label} · desde ${diaHoraArgentina(source.window.sinceIso)}${source.window.origen === 'techo' ? ', el máximo' : ''}`;
      progress.startItem(key, linea, 'buscando…');
      let apifyRunId = null;
      let meta = null;
      try {
        const posts = await source.run({
          resultsLimit: source.limit,
          lookback: source.window.lookback,
          // El instante exacto desde el que se pide (el adapter de apidojo arma su `until` con él).
          sinceIso: source.window.sinceIso,
          // El vencimiento es UNO para todas las fuentes de la red (ver
          // src/searchWait.js): la detección no dura más que eso.
          deadlineAt,
          onRunStarted: (run) => {
            apifyRunId = run && run.id ? run.id : null;
            actualizarFuente(rowId, { apifyRunId });
          },
          onMeta: (m) => {
            meta = m || null;
          },
        });
        // Apify cortó la corrida y el adapter entregó lo que dejó: sirve,
        // pero no es una respuesta completa.
        const parcial = Boolean(meta && meta.parcial);
        const motivo = parcial ? `RUN_${String(meta.runStatus || 'FAILED').replace('-', '_')}` : null;
        let todos = Array.isArray(posts) ? posts : [];
        // La búsqueda llenó su tope: quedó afuera una parte de cada día de la
        // ventana (los resultados no vienen por fecha). Se pide más con una
        // segunda consulta, si entra en el techo de la corrida; si no, queda
        // marcado. Sin meta (un adapter que no la informa) no se sabe: nada.
        let topeLleno = false;
        if (!parcial && meta && Number(meta.maxItems) > 0 && Number(meta.rawItems) >= Number(meta.maxItems)) {
          const segunda = await segundaConsulta(source, key);
          todos = segunda.posts.length > 0 ? unirPosteos(todos, segunda.posts) : todos;
          topeLleno = !segunda.cubierto;
        }
        // Bien, salvo dos casos que quedan pendientes (ámbar): Apify cortó
        // la corrida y dejó algo, o la búsqueda llenó su tope y no se pudo
        // pedir más.
        const pendienteDe = parcial ? `${source.label} · Apify la cortó` : topeLleno ? `${source.label} · tope lleno: puede faltar algo` : null;
        progress.finishItem(key, pendienteDe ? { state: 'wait', label: pendienteDe, detail: describeFound(todos, platformId) } : { ok: true, detail: describeFound(todos, platformId) });
        progress.tick(1, { ok: true });
        actualizarFuente(
          rowId,
          {
            estado: parcial ? 'parcial' : 'ok',
            ...(parcial ? { motivo } : {}),
            items: meta && meta.rawItems != null ? meta.rawItems : todos.length,
            nuevos: contarNuevos(todos, platformId),
            apifyRunId,
            topeLleno,
            ...(meta && meta.until ? { until: meta.until } : {}),
          },
          { startedMs }
        );
        return { source, ok: true, posts: todos, estado: parcial ? 'parcial' : 'ok', motivo, meta, topeLleno };
      } catch (err) {
        // La corrida no terminó dentro de la espera pero sigue en Apify con
        // su id: queda esperando y el ciclo siguiente la levanta.
        const runId = (err && err.apifyRunId) || apifyRunId;
        const pendiente = Boolean(err && err.runPending && runId);
        const motivo = motivoDeFallo(err);
        progress.finishItem(key, pendiente ? { state: 'wait', detail: 'sigue en Apify' } : { ok: false, detail: motivoCorto(motivo) });
        progress.tick(1, { ok: pendiente ? null : false });
        actualizarFuente(rowId, { estado: pendiente ? 'esperando' : 'fallo', motivo, detalle: err && err.message, apifyRunId: runId }, { startedMs });
        return { source, ok: false, err, posts: [], estado: pendiente ? 'esperando' : 'fallo', motivo };
      }
    };

    /**
     * La segunda consulta de una búsqueda que llenó su tope: la misma
     * ventana, con 4 veces el tope (hasta SEARCH_RESULTS_MAX), si lo máximo
     * que puede costar entra en el techo de la corrida para estas consultas.
     * Deja su propia fila (intento 2). Nunca tira.
     * @returns {Promise<{ posts: object[], cubierto: boolean }>} cubierto:
     *   la segunda respondió y NO llenó su tope (ya no falta nada).
     */
    const segundaConsulta = async (source, key) => {
      const tope = busquedaTope.topeRelanzamiento(source.limit, topeConfig.resultsMax);
      if (!tope) {
        console.warn(`[monitor] ${platformId}: «${source.fuente}» llenó su tope (${source.limit}), que ya es el máximo: puede faltar algo.`);
        return { posts: [], cubierto: false };
      }
      const costoMax = maxUsdForSearch(tope);
      if (!presupuestoExtra.reservar(costoMax)) {
        console.warn(
          `[monitor] ${platformId}: «${source.fuente}» llenó su tope (${source.limit}) y la segunda consulta (hasta US$ ${costoMax.toFixed(2)}) no entra en el techo de esta corrida ` +
            `(US$ ${presupuestoExtra.techo.toFixed(2)}, ${presupuestoExtra.reservado().toFixed(2)} ya apartados): puede faltar algo.`
        );
        return { posts: [], cubierto: false };
      }
      console.log(`[monitor] ${platformId}: «${source.fuente}» llenó su tope (${source.limit}): se pide más, con tope ${tope} (hasta US$ ${costoMax.toFixed(2)}).`);
      const startedMs = Date.now();
      const rowId = abrirFuente({
        plataforma: platformId,
        tipo: source.tipo,
        fuente: source.fuente,
        intento: 2,
        actor: platform.actorId || null,
        desdeIso: source.window.sinceIso,
        tope,
      });
      progress.updateItem(key, 'tope lleno · se pide más…');
      let apifyRunId = null;
      let meta = null;
      try {
        const posts = await source.run({
          resultsLimit: tope,
          lookback: source.window.lookback,
          sinceIso: source.window.sinceIso,
          deadlineAt,
          onRunStarted: (run) => {
            apifyRunId = run && run.id ? run.id : null;
            actualizarFuente(rowId, { apifyRunId });
          },
          onMeta: (m) => {
            meta = m || null;
          },
        });
        const lista = Array.isArray(posts) ? posts : [];
        const parcial = Boolean(meta && meta.parcial);
        const llena = Boolean(meta && Number(meta.maxItems) > 0 && Number(meta.rawItems) >= Number(meta.maxItems));
        actualizarFuente(
          rowId,
          {
            estado: parcial ? 'parcial' : 'ok',
            ...(parcial ? { motivo: `RUN_${String(meta.runStatus || 'FAILED').replace('-', '_')}` } : {}),
            items: meta && meta.rawItems != null ? meta.rawItems : lista.length,
            nuevos: contarNuevos(lista, platformId),
            apifyRunId,
            topeLleno: llena,
            ...(meta && meta.until ? { until: meta.until } : {}),
          },
          { startedMs }
        );
        if (llena) console.warn(`[monitor] ${platformId}: «${source.fuente}» llenó también el tope de la segunda consulta (${tope}): puede faltar algo.`);
        return { posts: lista, cubierto: !parcial && !llena };
      } catch (err) {
        const runId = (err && err.apifyRunId) || apifyRunId;
        const pendiente = Boolean(err && err.runPending && runId);
        actualizarFuente(rowId, { estado: pendiente ? 'esperando' : 'fallo', motivo: motivoDeFallo(err), detalle: err && err.message, apifyRunId: runId }, { startedMs });
        console.warn(
          `[monitor] ${platformId}: la segunda consulta de «${source.fuente}» ${pendiente ? 'no terminó a tiempo y sigue en Apify (se levanta en el próximo ciclo)' : `falló (${(err && err.message) || 'sin detalle'})`}; se usa lo que trajo la primera.`
        );
        return { posts: [], cubierto: false };
      }
    };

    // Los términos cuya corrida anterior sigue en Apify: no se buscan, pero
    // quedan dichos en esta corrida (no fue una detección completa).
    const skippedOutcomes = canSearch
      ? searchesSkipped.map((term) => {
          const key = `${platformId}:busqueda:«${term}»`;
          abrirFuente({ plataforma: platformId, tipo: 'busqueda', fuente: term, estado: 'fallo', motivo: 'SIGUE_EN_APIFY', finishedAt: new Date().toISOString() });
          progress.startItem(key, `«${term}»`, 'sigue en Apify');
          progress.finishItem(key, { state: 'wait', detail: 'sigue en Apify' });
          return { source: { tipo: 'busqueda', fuente: term }, ok: false, err: null, posts: [], estado: 'fallo', motivo: 'SIGUE_EN_APIFY' };
        })
      : [];

    const deadlineAt = Date.now() + searchWait().waitMs;
    const outcomes = [...(await Promise.all(sources.map(lanzarFuente))), ...skippedOutcomes];

    // Lo que se levantó de corridas anteriores entra primero: son los más viejos.
    const allCandidates = [...recovery.candidates];
    // Primer error de plataforma de esta corrida (clave inválida, rate limit,
    // cuota): se resuelve DESPUÉS de guardar lo que sí llegó (ver abajo).
    let platformError = null;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        allCandidates.push(...outcome.posts);
      } else if (outcome.estado === 'esperando') {
        console.warn(
          `Monitoreo (${platformId}): la búsqueda «${outcome.source.fuente}» no terminó a tiempo y sigue en Apify: se levanta en el próximo ciclo.`
        );
      } else if (!outcome.err) {
        // Salteada: su corrida anterior sigue en Apify (ya se avisó arriba).
      } else if (isPlatformError(outcome.err)) {
        if (!platformError) platformError = outcome.err;
        console.error(
          `Monitoreo (${platformId}): la plataforma no se pudo consultar (${outcome.err.code}):`,
          outcome.err.message
        );
      } else {
        // Una fuente que falla sola (cuenta privada/eliminada, error puntual
        // de la fuente, etc.) no debe tirar abajo el resto del ciclo.
        console.error(`Monitoreo (${platformId}): falló una fuente:`, outcome.err && outcome.err.message);
      }
    }
    // Cómo le fue a cada fuente, para quien cierra el ciclo.
    porPlataforma[platformId].fuentes = outcomes.map((o) => ({
      tipo: o.source.tipo,
      fuente: o.source.fuente,
      estado: o.estado,
      motivo: o.motivo,
      ...(o.topeLleno ? { topeLleno: true } : {}),
    }));

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
    // Antes del dedupe (que se queda con una sola versión de cada posteo):
    // todos los términos de búsqueda que lo trajeron en esta corrida, para
    // medir el rendimiento de cada término (search_seen.terminos).
    const termsById = new Map();
    for (const post of allCandidates) {
      if (!post || post.sourceType !== 'search' || !post.sourceQuery || post.id === undefined || post.id === null) continue;
      const key = String(post.id);
      const list = termsById.get(key) || [];
      if (!list.some((t) => t.toLowerCase() === String(post.sourceQuery).toLowerCase())) list.push(String(post.sourceQuery));
      termsById.set(key, list);
    }

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

    // Los "nuevos" de esta corrida: posteos que no estaban guardados ni se
    // habían evaluado antes (ver isNewPost). Es el mismo criterio de cada
    // línea del progreso ("50 encontrados, 6 nuevos"), acá sin repetidos
    // entre fuentes. Se cuenta ANTES del detalle, que ya anota en
    // search_seen lo que paga. La pantalla cierra con "N relevantes
    // guardados de M nuevos": M es este número.
    const newIds = new Set();
    for (const post of seenInThisRun.values()) {
      if (isNewPost(post, platformId)) newIds.add(post.id);
    }
    porPlataforma[platformId].newCandidates = newIds.size;
    let relevantNew = 0;
    let discardedNew = 0;

    // Los resultados de búsqueda llegan sin caption: a los nuevos se les pide
    // el detalle (una consulta para todos) antes de evaluar relevancia.
    const enrichment = await enrichSearchResults(platform, platformId, seenInThisRun);
    if (enrichment.stats) porPlataforma[platformId].searchEnrichment = enrichment.stats;
    if (enrichment.platformError && !platformError) platformError = enrichment.platformError;

    // Total real de la fase de clasificación: solo los posteos NUEVOS pasan
    // por evaluateRelevance. Los ya guardados solo se refrescan gratis, y los
    // que una corrida anterior ya decidió (search_seen) no se vuelven a
    // evaluar: antes sí, y cada corrida pagaba de nuevo sus descartados.
    progress.startPhase('Clasificando relevancia', newIds.size);
    const cycleRunId = (getContext() || {}).runId ?? null;

    // Posteos nuevos de esta plataforma que vinieron con link de imagen: su
    // foto se baja al terminar de guardarlos (más abajo).
    const newPostImages = [];

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
        addSearchTerms(post, platformId, termsById);
        continue;
      }

      // Ya decidido en una corrida anterior (anotado en search_seen): no se
      // vuelve a clasificar. Solo se le suman los términos que lo trajeron
      // esta vez.
      if (!newIds.has(post.id)) {
        addSearchTerms(post, platformId, termsById);
        continue;
      }

      // Lo que costó clasificarlo (estimado por el proveedor), para la fila
      // de search_seen: el rendimiento de cada término se mide con eso.
      let llmUsd = null;
      const onUsage = (usage) => {
        const cost = Number(usage && usage.costUsd);
        if (usage && usage.costUsd != null && Number.isFinite(cost)) llmUsd = (llmUsd || 0) + cost;
      };
      const evaluation = await evaluateRelevance(post, plainKeywords, { platform, onUsage });
      progress.tick();
      if (evaluation.relevant) relevantNew += 1;
      else discardedNew += 1;

      const postWithClassification = guardarEvaluado(post, evaluation, {
        platform,
        platformId,
        terminos: termsById.get(String(post.id)) || null,
        llmUsd,
        runId: cycleRunId,
      });
      if (!postWithClassification) continue;
      newPosts.push(postWithClassification);
      porPlataforma[platformId].newCount += 1;
      if (post.imageUrl) newPostImages.push({ id: post.id, url: post.imageUrl });
    }
    // Resumen de la fase para la pantalla, antes de que arranque la de fotos.
    progress.setPhaseSummary('Clasificando relevancia', {
      label: 'Relevancia',
      detail: `${plural(relevantNew, 'relevante', 'relevantes')}, ${plural(discardedNew, 'descartado', 'descartados')}`,
    });

    // Foto de los posteos recién guardados (openspec/changes/monitoreo-fotos),
    // con el link que ya vino en esta misma respuesta: no se pide nada más.
    // Un posteo ya conocido no se toca acá (su foto la completa el refresco
    // por URL). Nunca tira ni frena el ciclo; una plataforma sin fotos (X) o
    // POST_IMAGES=0 no hace nada.
    await syncPostImages(platformId, newPostImages);

    // Los posteos de las búsquedas levantadas ya pasaron por la tubería:
    // recién ahora sus filas dejan de estar pendientes.
    cerrarRecuperadas(recovery, { platformId, runId: cycleRunId });

    // Cuentas trackeadas cuyo perfil se scrapeó de verdad en este ciclo (no
    // las de hashtag/keyword: ahí solo se pesca el posteo puntual que
    // matcheó, nunca "los últimos N" de esa cuenta). src/metricsRefresh.js las
    // usa para no volver a pedirle al scraper una cuenta que ya se acaba de
    // consultar. Por plataforma: el mismo handle puede existir en dos redes.
    // En Instagram queda vacío (detectAccounts: false): ninguna cuenta se
    // consultó en la detección, así que el refresco las pide si les toca.
    scrapedAccounts[platformId] = [...accountsToScrape];

    // Marcas de detección, ANTES de cualquier throw: cada fuente avanza
    // según cómo le fue (ver advanceSourceMarks). Los posteos de las que
    // respondieron ya quedaron guardados o anotados arriba.
    const todasAvanzaron = advanceSourceMarks(platformId, outcomes, cycleNowMs);

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
    } else if (todasAvanzaron) {
      // Todas las fuentes de la red respondieron: se escribe también la
      // marca de la RED (`detection_last_success:<red>`), que es la que usa
      // el código anterior si se vuelve atrás, y se anota que este código
      // la vio (ver migrateDetectionMarks). Si alguna fuente no avanzó, la
      // marca de la red se queda donde estaba.
      try {
        const iso = new Date(cycleNowMs).toISOString();
        db.setRefreshState(`detection_last_success:${platformId}`, iso);
        db.setRefreshState(`detection_por_fuente:${platformId}`, iso);
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
 * Completa la clasificación de los posteos guardados (no ignorados) de una
 * plataforma: título + sentimiento + tema para los que no tienen título
 * (posteos de antes de esta funcionalidad, o alguno que falló), y SOLO el
 * tema para los ya clasificados que no lo tienen (guardados antes de la
 * columna tema). Una llamada al LLM por posteo, de a una. Se puede llamar
 * las veces que haga falta: no vuelve a tocar lo que ya está completo.
 * Hasta `max` posteos por invocación (BACKFILL_MAX, 200 por defecto, ver
 * src/backfillConfig.js): el resto queda para la próxima. Una sola a la vez
 * en todo el proceso: con otra en curso tira code BACKFILL_EN_CURSO (la ruta
 * responde 409); dos clics seguidos pagarían dos veces los mismos posteos.
 * @returns {Promise<{ classified: number, temasCompletados: number, stillPending: number }>}
 *   classified: sin título que quedaron clasificados; temasCompletados: ya
 *   clasificados a los que solo se les completó el tema; stillPending: los
 *   que quedan pendientes (el clasificador no pudo, o no entraron en el tope).
 */
let backfillEnCurso = false;

async function backfillClassification(platformId, { max = resolveBackfillMax() } = {}) {
  requirePlatformId(platformId, 'backfillClassification');
  if (backfillEnCurso) {
    const e = new Error('Ya hay un backfill de la clasificación en curso');
    e.code = 'BACKFILL_EN_CURSO';
    e.userMessage = 'Ya hay una clasificación en curso. Esperá a que termine.';
    throw e;
  }
  backfillEnCurso = true;
  try {
    return await backfillSinCandado(platformId, max);
  } finally {
    backfillEnCurso = false;
  }
}

async function backfillSinCandado(platformId, max) {
  const platform = getPlatform(platformId);
  const todos = db.listUnclassified({ plataforma: platformId });
  const pending = todos.slice(0, max);
  const sinIntentar = todos.length - pending.length;
  let classified = 0;
  let temasCompletados = 0;
  let stillPending = 0;

  if (todos.length > 0) {
    console.log(
      `[monitor] backfill (${platformId}): ${todos.length} posteo(s) sin clasificar o sin tema` +
        (sinIntentar > 0 ? `; van ${pending.length} (tope BACKFILL_MAX=${max}), ${sinIntentar} quedan para la próxima.` : '.')
    );
  }
  for (const [i, row] of pending.entries()) {
    // Puede tardar (una llamada por posteo): una línea cada 50 para seguirlo.
    if (i > 0 && i % 50 === 0) console.log(`[monitor] backfill (${platformId}): ${i} de ${pending.length}`);

    // Sin pista: el origen ya quedó en matched_reason. El modelo también
    // devuelve relevant, pero desde acá no se borra nada ya guardado.
    const r = await clasificarPosteo(row.caption, { platformLabel: platform.label });

    if (row.title != null) {
      // Ya clasificado, solo le falta el tema: se completa ESO. Título,
      // sentimiento y matched_reason quedan como estaban, diga lo que diga
      // el modelo sobre la relevancia (eso ya se decidió al guardarlo).
      if (r.unclassified || !r.tema) {
        stillPending++;
        continue;
      }
      if (db.updateTema(row.id, r.tema, platformId)) temasCompletados++;
      continue;
    }

    // Sin título: se completan título, sentimiento, tema y motivo, y si el
    // modelo dice que no es relevante queda avisado en matched_reason para
    // que alguien lo revise.
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
    db.updateClassification(row.id, { title: r.title, sentiment: r.sentiment, tema: r.tema, matchedReason });
    classified++;
  }

  if (stillPending > 0) {
    console.warn(
      `[monitor] backfill: ${stillPending} posteo(s) siguen sin clasificar o sin tema (el clasificador falló). Se reintentan en la próxima corrida.`
    );
  }
  return { classified, temasCompletados, stillPending: stillPending + sinIntentar };
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
  sourceMarkKey,
  sourceKey,
  migrateDetectionMarks,
  // Expuestos para tests.
  evaluateRelevance,
  pickMetrics,
  raiseLimitForWindow,
  // Código de la URL de un posteo (/p/{code}/): lo usa también el refresco
  // por URL (src/metricsRefresh.js) para cruzar la respuesta del actor.
  postCodeOf,
  guardarEvaluado,
};
