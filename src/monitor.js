// ==========================================================================
// monitor.js
// --------------------------------------------------------------------------
// Orquestador del monitoreo, agnóstico de plataforma. Detecta posteos nuevos
// relevantes a partir de dos tipos de fuentes por plataforma:
//   - Cuentas trackeadas (config/monitoring.json, sección por plataforma).
//   - Páginas de hashtag configuradas (las keywords que empiezan con "#").
//
// Un posteo se considera relevante si:
//   1. Su caption/hashtags contienen alguna palabra clave literal
//      (case-insensitive), o
//   2. No hay coincidencia literal, pero Claude determina que el contenido
//      igual habla del Jefe de Gobierno porteño o su gestión (detección
//      semántica — ver classifyRelevance en src/classifier.js). Así no
//      dependemos únicamente de que el texto use exactamente alguna de las
//      palabras configuradas.
//
// Todo lo específico de cada plataforma (URLs, actor de Apify, nombres de
// campos) vive en su adapter de src/platforms/. Este módulo solo orquesta:
// scrapear vía adapter, evaluar relevancia, dedupe contra SQLite (src/db.js,
// que decide qué es realmente "nuevo") y guardado.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { classifyPost, classifyRelevance } = require('./classifier');
const { checkAndLogJump } = require('./viralJumpDetector');
const { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID } = require('./platforms');
const db = require('./db');

// MONITORING_CONFIG_PATH: solo para tests (tempfile), mismo patrón que
// MONITORING_DB_PATH en db.js. En runtime normal es config/monitoring.json.
const CONFIG_PATH =
  process.env.MONITORING_CONFIG_PATH || path.join(__dirname, '..', 'config', 'monitoring.json');

/**
 * Las cuentas son simplemente el nombre de usuario. Acepta también el
 * formato { username, onlyIfKeywordMatch } que se usó brevemente, por si
 * quedó algo sin migrar en el archivo.
 */
function normalizeAccount(entry) {
  return typeof entry === 'string' ? entry : entry.username;
}

/**
 * config/monitoring.json tiene tres formatos posibles:
 *   - Actual (secciones por plataforma): { instagram: { accounts: [...],
 *     keywords: [...] } }. Es el único que escribe saveConfig().
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
function loadConfigAll() {
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
  const all = {};
  for (const [platformId, section] of Object.entries(parsed)) {
    all[platformId] = {
      accounts: (Array.isArray(section.accounts) ? section.accounts : []).map(normalizeAccount),
      keywords: Array.isArray(section.keywords) ? section.keywords : [],
    };
  }
  return all;
}

/** Config de UNA plataforma, con la misma forma { accounts, keywords } de siempre. */
function loadConfig(platformId = DEFAULT_PLATFORM_ID) {
  return loadConfigAll()[platformId] || { accounts: [], keywords: [] };
}

function saveConfig(configAll) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configAll, null, 2) + '\n', 'utf8');
}

/**
 * Agrega una cuenta a trackear (sacando "@" si lo escribieron de más).
 * Antes de guardarla, valida que exista de verdad en la plataforma. No hace
 * nada si ya estaba (evita duplicados).
 */
async function addAccount(account, platformId = DEFAULT_PLATFORM_ID) {
  const clean = String(account || '').trim().replace(/^@/, '');
  if (!clean) {
    const e = new Error('Cuenta vacía');
    e.userMessage = 'Escribí un nombre de cuenta.';
    throw e;
  }
  const platform = getPlatform(platformId);
  await platform.validateAccount(clean);
  const all = loadConfigAll();
  const config = all[platformId] || (all[platformId] = { accounts: [], keywords: [] });
  const isNew = !config.accounts.some((a) => a.toLowerCase() === clean.toLowerCase());
  if (isNew) {
    config.accounts.push(clean);
    saveConfig(all);

    // Sin esto la cuenta queda hasta un mes sin referencia (la cadencia
    // normal es mensual, ver accountStats.js). Sin "await": no demorar la
    // respuesta de "agregar cuenta" — ya hace su propio llamado a Apify
    // arriba (validateAccount) y este es un segundo llamado aparte.
    // require() adentro de la función (no arriba del archivo) para evitar
    // una dependencia circular: accountStats.js importa este módulo para
    // reusar loadConfig.
    require('./accountStats')
      .computeAccountStats(clean, platformId)
      .catch((err) => {
        console.error(`No se pudo calcular el benchmark de @${clean}:`, err.message);
      });
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
 * Agrega una palabra clave o hashtag. Si empieza con "#" se trata como
 * hashtag (se scrapea esa página directamente, y por eso se valida que
 * exista); si no, es texto libre a buscar dentro de lo que ya se scrapea
 * (ver limitación en el README) y no hay nada concreto que validar.
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
    await platform.validateHashtag(clean.slice(1));
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

function textIncludesAny(text, needles) {
  const lower = (text || '').toLowerCase();
  return needles.find((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * Decide si un posteo candidato es relevante y, si lo es, le pone
 * título + sentimiento. Dos caminos:
 *   1. Coincidencia literal de palabra clave → clasificación directa
 *      (siempre relevante, no hace falta preguntarle a Claude si aplica).
 *   2. Sin coincidencia literal → se le pregunta a Claude si el contenido
 *      igual habla del Jefe de Gobierno porteño / su gestión (detección
 *      semántica), para no depender solo del texto exacto.
 * Un posteo sin caption solo se acepta si viene de una cuenta trackeada
 * (no hay texto que evaluar semánticamente, pero viene de la fuente que
 * explícitamente querés ver); si viene de un hashtag, se descarta.
 */
async function evaluateRelevance(post, keywords) {
  const text = `${post.caption} ${post.hashtagsText}`.trim();

  if (!post.caption || !post.caption.trim()) {
    if (post.sourceType === 'account') {
      return { relevant: true, title: 'Sin descripción', sentiment: 'neutral', matchedReason: `Cuenta trackeada: @${post.account}` };
    }
    return { relevant: false };
  }

  const literalMatch = textIncludesAny(text, keywords);
  if (literalMatch) {
    // La relevancia acá NO depende del LLM: ya matcheó una palabra clave. Si
    // el clasificador falla, el posteo entra igual, sin título ni sentimiento.
    const { title, sentiment, unclassified } = await classifyPost(post.caption);
    const base = post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account} (coincidencia: "${literalMatch}")`
      : `Coincidencia con palabra clave: "${literalMatch}"`;
    return {
      relevant: true,
      title,
      sentiment,
      unclassified,
      matchedReason: unclassified ? `${base} — sin clasificar` : base,
    };
  }

  const result = await classifyRelevance(post.caption);
  if (!result.relevant) return { relevant: false };

  // Sin palabra clave literal y con el clasificador caído no sabemos si es
  // relevante. Se guarda igual, marcado, para que alguien lo revise: un falso
  // positivo se ve y se borra; uno descartado en silencio no vuelve nunca.
  if (result.unclassified) {
    const origen = post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account}`
      : 'Hashtag monitoreado';
    return {
      relevant: true,
      title: null,
      sentiment: null,
      unclassified: true,
      matchedReason: `${origen} — sin clasificar (falló el clasificador, relevancia sin verificar)`,
    };
  }

  const matchedReason = post.sourceType === 'account'
    ? `Cuenta trackeada: @${post.account} (relacionado por contenido)`
    : 'Relacionado por contenido (sin palabra clave literal)';
  return { relevant: true, title: result.title, sentiment: result.sentiment, matchedReason };
}

/**
 * Corre un ciclo completo de monitoreo: por cada plataforma configurada,
 * scrapea todas las fuentes vía su adapter, evalúa relevancia (texto o
 * semántica), descarta lo ya conocido y guarda + devuelve solo los posteos
 * nuevos. La evaluación, el dedupe y el guardado son los mismos para todas
 * las plataformas; solo el scraping es del adapter.
 */
async function runMonitoringCycle() {
  const all = loadConfigAll();
  const resultsLimit = Number(process.env.MONITOR_RESULTS_LIMIT || 15);
  const lookback = process.env.MONITOR_LOOKBACK || '1 day';

  let checked = 0;
  const newPosts = [];
  const scrapedAccounts = [];
  let metricsRefreshedFree = 0;

  for (const platformId of listPlatformIds()) {
    const config = all[platformId];
    if (!config) continue;
    const platform = getPlatform(platformId);
    const { accounts, keywords } = config;

    const hashtagTags = keywords.filter((k) => k.startsWith('#')).map((k) => k.slice(1));
    // Para filtrar por substring usamos la lista completa de keywords, sin el "#".
    const plainKeywords = keywords.map((k) => (k.startsWith('#') ? k.slice(1) : k));

    const sourceResults = await Promise.allSettled([
      ...accounts.map((account) => platform.scrapeAccount(account, { resultsLimit, lookback })),
      ...hashtagTags.map((tag) => platform.scrapeHashtag(tag, { resultsLimit })),
    ]);

    const allCandidates = [];
    for (const result of sourceResults) {
      if (result.status === 'fulfilled') {
        allCandidates.push(...result.value);
      } else {
        // Una fuente que falla (cuenta privada/eliminada, error de Apify,
        // etc.) no debe tirar abajo el resto del ciclo.
        console.error('Monitoreo: falló una fuente:', result.reason && result.reason.message);
      }
    }

    // Dedupe por id dentro de esta misma corrida (una cuenta trackeada podría
    // aparecer también en un hashtag, por ejemplo). Por plataforma: dos
    // plataformas distintas nunca comparten id.
    const seenInThisRun = new Map();
    for (const post of allCandidates) {
      if (post.url && !seenInThisRun.has(post.id)) {
        seenInThisRun.set(post.id, post);
      }
    }
    checked += seenInThisRun.size;

    for (const post of seenInThisRun.values()) {
      // Por id o por url: si el scraper cambia el campo con el que armamos el
      // id, la URL sigue siendo la misma pieza y no hay que re-clasificarla.
      const existingId = db.findExistingPostId(post.id, post.url);
      if (existingId) {
        // Ya lo conocíamos (incluye ignorados: la fila sigue en SQLite para
        // no re-detectar). No reclasificar. Si no está ignorado, esta misma
        // respuesta del scraper trae likes/comments actuales — refrescar la
        // fila sale gratis. Si está ignorado, applyMetricsRefresh es no-op.
        const refresh = db.applyMetricsRefresh(existingId, { likes: post.likes, comments: post.comments });
        if (refresh) {
          metricsRefreshedFree += 1;
          checkAndLogJump({ account: refresh.account, id: existingId, postedAt: refresh.postedAt, metric: 'comentarios', previous: refresh.previousComments, current: refresh.comments });
          checkAndLogJump({ account: refresh.account, id: existingId, postedAt: refresh.postedAt, metric: 'likes', previous: refresh.previousLikes, current: refresh.likes });
        }
        continue;
      }

      const evaluation = await evaluateRelevance(post, plainKeywords);
      if (!evaluation.relevant) continue;

      const postWithClassification = {
        ...post,
        plataforma: platformId,
        title: evaluation.title,
        sentiment: evaluation.sentiment,
        matchedReason: evaluation.matchedReason,
        // Snapshot de la caché (account_followers), no un llamado al scraper
        // acá: eso encarecería cada corrida de 4hs. Se refresca por afuera,
        // en accountStats.computeAccountStats. Posts sin cuenta (hashtag) o
        // de cuentas todavía sin caché quedan null -> "-" en la tabla.
        followers: post.account ? db.getAccountFollowers(post.account, platformId) : null,
      };

      const inserted = db.saveDetectedPost(postWithClassification);
      if (!inserted) {
        // Carrera con otro ciclo: entre el findExisting y el INSERT el otro
        // proceso ya lo guardó. No es un posteo nuevo para notificar.
        const racedId = db.findExistingPostId(post.id, post.url);
        if (racedId) {
          db.applyMetricsRefresh(racedId, { likes: post.likes, comments: post.comments });
        }
        continue;
      }
      newPosts.push(postWithClassification);
    }

    // Cuentas trackeadas cuyo perfil se scrapeó de verdad en este ciclo (no
    // las de hashtag: ahí solo se pesca el posteo puntual que matcheó, nunca
    // "los últimos N" de esa cuenta). src/metricsRefresh.js las usa para no
    // volver a pedirle al scraper una cuenta que ya se acaba de consultar.
    scrapedAccounts.push(...accounts);
  }

  if (metricsRefreshedFree > 0) {
    console.log(`[monitor] ${metricsRefreshedFree} posteo(s) ya conocidos refrescados gratis con este mismo ciclo.`);
  }

  return { checked, newPosts, scrapedAccounts };
}

/**
 * Genera título + sentimiento para los posteos guardados que todavía no lo
 * tienen (posteos de antes de esta funcionalidad, o alguno que falló). Se
 * puede llamar las veces que haga falta: no vuelve a tocar los que ya están
 * clasificados.
 */
async function backfillClassification(platformId) {
  const pending = db.listUnclassified({ plataforma: platformId });
  let classified = 0;
  let stillPending = 0;

  for (const row of pending) {
    const { title, sentiment, unclassified } = await classifyPost(row.caption);
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
  addAccount,
  removeAccount,
  addKeyword,
  removeKeyword,
};
