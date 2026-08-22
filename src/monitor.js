// ==========================================================================
// monitor.js
// --------------------------------------------------------------------------
// Detecta posteos nuevos de Instagram relevantes para el monitoreo, a partir
// de dos tipos de fuentes:
//   - Cuentas trackeadas (config/monitoring.json).
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
// Reusa runActorSync (mismo actor "apify/instagram-scraper" que ya usa
// src/apify.js para el análisis puntual). La base SQLite (src/db.js) es la
// que decide qué es realmente "nuevo": no se vuelve a evaluar ni gastar
// clasificación en algo ya conocido.
//
// NOTA sobre nombres de campos: igual que en src/apify.js, los nombres que
// devuelve el actor pueden variar según la versión (ver README). Si algo
// aparece vacío, revisar una corrida real en el panel de Apify.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { runActorSync } = require('./apify');
const { classifyPost, classifyRelevance } = require('./classifier');
const db = require('./db');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'monitoring.json');

/**
 * Las cuentas son simplemente el nombre de usuario. Acepta también el
 * formato { username, onlyIfKeywordMatch } que se usó brevemente, por si
 * quedó algo sin migrar en el archivo.
 */
function normalizeAccount(entry) {
  return typeof entry === 'string' ? entry : entry.username;
}

/**
 * config/monitoring.json tiene dos formatos posibles:
 *   - Viejo (anidado): { instagram: { accounts, hashtags, keywords: {categoría: [...]} } }.
 *     Las keywords venían agrupadas por categoría y los hashtags aparte, sin
 *     el "#" — solo para que el archivo se pudiera leer y mantener a mano.
 *   - Actual (plano): { accounts: [...], keywords: [...] } — es lo que
 *     escribe saveConfig() cada vez que se agrega/saca algo desde la app
 *     (addAccount/removeAccount/addKeyword/removeKeyword), así que un
 *     archivo que arrancó anidado termina en este formato apenas se edita
 *     una vez desde la UI.
 * Acá se soportan los dos, aplanando el viejo a la misma forma que ya espera
 * el resto del código (evaluateRelevance, runMonitoringCycle no saben que
 * existían categorías; a un hashtag "JorgeMacri" se le vuelve a poner el "#"
 * adelante para que el filter(k => k.startsWith('#')) lo siga reconociendo).
 */
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (parsed.instagram) {
    const ig = parsed.instagram;
    const keywordGroups = ig.keywords || {};
    const flatKeywords = [
      ...Object.values(keywordGroups).flat(),
      ...(Array.isArray(ig.hashtags) ? ig.hashtags.map((h) => `#${h}`) : []),
    ];
    return {
      accounts: (Array.isArray(ig.accounts) ? ig.accounts : []).map(normalizeAccount),
      keywords: flatKeywords,
    };
  }

  return {
    accounts: (Array.isArray(parsed.accounts) ? parsed.accounts : []).map(normalizeAccount),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Chequea contra Apify que la cuenta/hashtag realmente exista antes de
 * guardarla, para no quedar cada 4hs consultando una página inexistente por
 * un typo. El actor no tira error HTTP para esto: devuelve un item con
 * "error": "not_found" (cuentas) o "no_items" (hashtags) en vez de datos
 * reales, así que basta con mirar ese campo.
 */
async function validateAccountExists(account) {
  const items = await runActorSync({
    directUrls: [`https://www.instagram.com/${account}/`],
    resultsType: 'posts',
    resultsLimit: 1,
  });
  const first = Array.isArray(items) && items[0];
  if (first && first.error) {
    const e = new Error(`Cuenta no encontrada: ${account}`);
    e.userMessage = `No encontramos la cuenta @${account} en Instagram. Revisá que esté bien escrita.`;
    throw e;
  }
}

async function validateHashtagExists(tag) {
  const items = await runActorSync({
    directUrls: [`https://www.instagram.com/explore/tags/${tag}/`],
    resultsType: 'posts',
    resultsLimit: 1,
  });
  const first = Array.isArray(items) && items[0];
  if (first && first.error) {
    const e = new Error(`Hashtag no encontrado: ${tag}`);
    e.userMessage = `No encontramos contenido para el hashtag #${tag}. Revisá que esté bien escrito.`;
    throw e;
  }
}

/**
 * Agrega una cuenta a trackear (sacando "@" si lo escribieron de más).
 * Antes de guardarla, valida que exista de verdad en Instagram. No hace
 * nada si ya estaba (evita duplicados).
 */
async function addAccount(account) {
  const clean = String(account || '').trim().replace(/^@/, '');
  if (!clean) {
    const e = new Error('Cuenta vacía');
    e.userMessage = 'Escribí un nombre de cuenta.';
    throw e;
  }
  await validateAccountExists(clean);
  const config = loadConfig();
  const isNew = !config.accounts.some((a) => a.toLowerCase() === clean.toLowerCase());
  if (isNew) {
    config.accounts.push(clean);
    saveConfig(config);

    // Sin esto la cuenta queda hasta un mes sin referencia (la cadencia
    // normal es mensual, ver accountStats.js). Sin "await": no demorar la
    // respuesta de "agregar cuenta" — ya hace su propio llamado a Apify
    // arriba (validateAccountExists) y este es un segundo llamado aparte.
    // require() adentro de la función (no arriba del archivo) para evitar
    // una dependencia circular: accountStats.js ya importa este módulo para
    // reusar scrapeAccount/loadConfig.
    require('./accountStats')
      .computeAccountStats(clean)
      .catch((err) => {
        console.error(`No se pudo calcular el benchmark de @${clean}:`, err.message);
      });
  }
  return config;
}

function removeAccount(account) {
  const config = loadConfig();
  config.accounts = config.accounts.filter((a) => a.toLowerCase() !== String(account).toLowerCase());
  saveConfig(config);
  return config;
}

/**
 * Agrega una palabra clave o hashtag. Si empieza con "#" se trata como
 * hashtag (se scrapea esa página directamente, y por eso se valida que
 * exista); si no, es texto libre a buscar dentro de lo que ya se scrapea
 * (ver limitación en el README) y no hay nada concreto que validar.
 */
async function addKeyword(keyword) {
  const clean = String(keyword || '').trim();
  if (!clean) {
    const e = new Error('Keyword vacía');
    e.userMessage = 'Escribí una palabra clave o hashtag.';
    throw e;
  }
  if (clean.startsWith('#')) {
    await validateHashtagExists(clean.slice(1));
  }
  const config = loadConfig();
  if (!config.keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) {
    config.keywords.push(clean);
    saveConfig(config);
  }
  return config;
}

function removeKeyword(keyword) {
  const config = loadConfig();
  config.keywords = config.keywords.filter((k) => k.toLowerCase() !== String(keyword).toLowerCase());
  saveConfig(config);
  return config;
}

function textIncludesAny(text, needles) {
  const lower = (text || '').toLowerCase();
  return needles.find((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * Dado un item crudo del actor (resultsType: 'posts'), lo deja en un formato
 * predecible. Mismo estilo defensivo ("pick" con varias alternativas) que
 * normalizePost() en src/apify.js.
 *
 * sourceType indica de dónde salió ('account' o 'hashtag') — se usa más
 * adelante para decidir cómo evaluar la relevancia de un posteo sin caption.
 */
/**
 * Tipo de posteo (reel|imagen|carrusel), para el benchmark de
 * src/accountStats.js. Sin verificar contra una corrida real de Apify
 * todavía (ver ese archivo) — probamos varios nombres de campo posibles del
 * actor y si ninguno aparece, devolvemos null (misma filosofía "pick" que ya
 * usa esta función y normalizePost() en apify.js).
 */
function derivePostType(raw) {
  const productType = String(raw.productType || '').toLowerCase();
  if (productType === 'clips') return 'reel';
  if (productType === 'carousel_container') return 'carrusel';

  const type = String(raw.type || '').toLowerCase();
  if (type === 'sidecar') return 'carrusel';
  if (type === 'video') return 'reel';
  if (type === 'image') return 'imagen';

  if (typeof raw.isVideo === 'boolean') return raw.isVideo ? 'reel' : 'imagen';

  return null;
}

// Apify (apify/instagram-scraper) devuelve -1 en likesCount cuando el autor
// ocultó el contador de "me gusta" del posteo — no es un dato real, es un
// centinela de "no disponible" (confirmado: es un comportamiento documentado
// del actor, no un error de parseo nuestro). Lo tratamos igual que "sin
// dato" — null, nunca -1 ni 0 — para no inventar un valor ni contaminar la
// mediana de account_stats. No hay documentación de que commentsCount use el
// mismo centinela, pero por las dudas (y porque un comentario negativo nunca
// puede ser real) se aplica el mismo criterio ahí también.
function nullIfMissingSentinel(value) {
  return typeof value === 'number' && value < 0 ? null : value;
}

function normalizeMonitorPost(raw, { account, sourceType }) {
  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');
  const shortCode = pick(raw.shortCode, raw.code);
  const id = String(pick(raw.id, shortCode, raw.pk));
  const url = pick(raw.url, shortCode && `https://www.instagram.com/p/${shortCode}/`);
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags.join(' ') : '';

  return {
    id,
    account: pick(raw.ownerUsername, raw.owner && raw.owner.username, account, 'N/D'),
    url,
    caption: pick(raw.caption, ''),
    hashtagsText: hashtags,
    likes: nullIfMissingSentinel(pick(raw.likesCount, null)),
    comments: nullIfMissingSentinel(pick(raw.commentsCount, null)),
    postedAt: pick(raw.timestamp, null),
    postType: derivePostType(raw),
    sourceType,
  };
}

/**
 * Solo scrapea — el filtrado de relevancia se hace después, en
 * runMonitoringCycle, porque ahora combina coincidencia de texto con
 * detección semántica (ver classifyRelevance en src/classifier.js).
 */
async function scrapeAccount(username, { resultsLimit, lookback }) {
  const items = await runActorSync({
    directUrls: [`https://www.instagram.com/${username}/`],
    resultsType: 'posts',
    resultsLimit,
    onlyPostsNewerThan: lookback,
    skipPinnedPosts: true,
  });

  // Cuando no hay posteos nuevos (o la cuenta no tiene datos en esa
  // ventana), el actor devuelve un item con "error": "no_items"/"not_found"
  // en vez de un posteo real — hay que descartarlo, si no queda guardado
  // como si fuera un posteo (con el link del perfil en vez de uno real).
  return (Array.isArray(items) ? items : [])
    .filter((raw) => !raw.error)
    .map((raw) => normalizeMonitorPost(raw, { account: username, sourceType: 'account' }));
}

/**
 * Cantidad de seguidores de una cuenta. Los items de "posts" NO traen este
 * dato (confirmado contra la doc del actor apify/instagram-scraper: solo
 * ownerFullName/ownerUsername/ownerId a nivel de posteo) — hace falta una
 * corrida aparte con resultsType "details" sobre la URL del perfil, que
 * devuelve followersCount en el nivel superior del item. Se llama desde
 * accountStats.computeAccountStats, con la misma cadencia que el benchmark
 * (mensual / cuenta nueva / recálculo forzado) — no en cada corrida de 4hs.
 *
 * Nunca tira: sin token de Apify, cuenta privada, actor caído o cualquier
 * otro error, devuelve null (la columna de seguidores queda en "-", el
 * resto del ciclo de monitoreo sigue sin verse afectado).
 * @returns {Promise<number|null>}
 */
async function fetchAccountFollowers(username) {
  try {
    const items = await runActorSync({
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: 'details',
      resultsLimit: 1,
    });
    const raw = (Array.isArray(items) && items[0]) || null;
    if (!raw || raw.error) return null;
    const value = Number(raw.followersCount);
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    console.error(`No se pudieron traer los seguidores de @${username}:`, err.message);
    return null;
  }
}

async function scrapeHashtag(tag, { resultsLimit }) {
  const items = await runActorSync({
    directUrls: [`https://www.instagram.com/explore/tags/${tag}/`],
    resultsType: 'posts',
    resultsLimit,
  });

  return (Array.isArray(items) ? items : [])
    .filter((raw) => !raw.error)
    .map((raw) => normalizeMonitorPost(raw, { account: null, sourceType: 'hashtag' }));
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
    const { title, sentiment } = await classifyPost(post.caption);
    const matchedReason = post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account} (coincidencia: "${literalMatch}")`
      : `Coincidencia con palabra clave: "${literalMatch}"`;
    return { relevant: true, title, sentiment, matchedReason };
  }

  const result = await classifyRelevance(post.caption);
  if (!result.relevant) return { relevant: false };

  const matchedReason = post.sourceType === 'account'
    ? `Cuenta trackeada: @${post.account} (relacionado por contenido)`
    : 'Relacionado por contenido (sin palabra clave literal)';
  return { relevant: true, title: result.title, sentiment: result.sentiment, matchedReason };
}

/**
 * Corre un ciclo completo de monitoreo: scrapea todas las fuentes
 * configuradas, evalúa relevancia (texto o semántica), descarta lo ya
 * conocido y guarda + devuelve solo los posteos nuevos.
 */
async function runMonitoringCycle() {
  const { accounts, keywords } = loadConfig();
  const resultsLimit = Number(process.env.MONITOR_RESULTS_LIMIT || 15);
  const lookback = process.env.MONITOR_LOOKBACK || '1 day';

  const hashtagTags = keywords.filter((k) => k.startsWith('#')).map((k) => k.slice(1));
  // Para filtrar por substring usamos la lista completa de keywords, sin el "#".
  const plainKeywords = keywords.map((k) => (k.startsWith('#') ? k.slice(1) : k));

  const sourceResults = await Promise.allSettled([
    ...accounts.map((account) => scrapeAccount(account, { resultsLimit, lookback })),
    ...hashtagTags.map((tag) => scrapeHashtag(tag, { resultsLimit })),
  ]);

  const allCandidates = [];
  for (const result of sourceResults) {
    if (result.status === 'fulfilled') {
      allCandidates.push(...result.value);
    } else {
      // Una fuente que falla (cuenta privada/eliminada, error de Apify, etc.)
      // no debe tirar abajo el resto del ciclo.
      console.error('Monitoreo: falló una fuente:', result.reason && result.reason.message);
    }
  }

  // Dedupe por id dentro de esta misma corrida (una cuenta trackeada podría
  // aparecer también en un hashtag, por ejemplo).
  const seenInThisRun = new Map();
  for (const post of allCandidates) {
    if (post.url && !seenInThisRun.has(post.id)) {
      seenInThisRun.set(post.id, post);
    }
  }

  const newPosts = [];
  for (const post of seenInThisRun.values()) {
    // Evitamos gastar una clasificación en algo que ya conocemos.
    if (db.isKnownPost(post.id)) continue;

    const evaluation = await evaluateRelevance(post, plainKeywords);
    if (!evaluation.relevant) continue;

    const postWithClassification = {
      ...post,
      title: evaluation.title,
      sentiment: evaluation.sentiment,
      matchedReason: evaluation.matchedReason,
      // Snapshot de la caché (account_followers), no un llamado a Apify acá:
      // eso encarecería cada corrida de 4hs. Se refresca por afuera, en
      // accountStats.computeAccountStats. Posts sin cuenta (hashtag) o de
      // cuentas todavía sin caché quedan null -> "-" en la tabla.
      followers: post.account ? db.getAccountFollowers(post.account, 'instagram') : null,
    };

    db.saveDetectedPost(postWithClassification);
    newPosts.push(postWithClassification);
  }

  return { checked: seenInThisRun.size, newPosts };
}

/**
 * Genera título + sentimiento para los posteos guardados que todavía no lo
 * tienen (posteos de antes de esta funcionalidad, o alguno que falló). Se
 * puede llamar las veces que haga falta: no vuelve a tocar los que ya están
 * clasificados.
 */
async function backfillClassification() {
  const pending = db.listUnclassified();
  for (const row of pending) {
    const { title, sentiment } = await classifyPost(row.caption);
    db.updateClassification(row.id, { title, sentiment });
  }
  return { classified: pending.length };
}

module.exports = {
  runMonitoringCycle,
  backfillClassification,
  loadConfig,
  addAccount,
  removeAccount,
  addKeyword,
  removeKeyword,
  scrapeAccount,
  fetchAccountFollowers,
};
