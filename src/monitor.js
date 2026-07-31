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

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
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
  if (!config.accounts.some((a) => a.toLowerCase() === clean.toLowerCase())) {
    config.accounts.push(clean);
    saveConfig(config);
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
    likes: pick(raw.likesCount, null),
    comments: pick(raw.commentsCount, null),
    postedAt: pick(raw.timestamp, null),
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
};
