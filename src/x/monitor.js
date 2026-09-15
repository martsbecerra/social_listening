// ==========================================================================
// monitor.js — Ciclo de monitoreo de X (Grok X Search, no Apify).
// --------------------------------------------------------------------------
// Config propia: config/monitoring-x.json (cuentas y keywords de esa red).
// Cada corrida busca from:handle por cuenta y la keyword literal por término,
// con un tope de posts por fuente. Los ya conocidos (id/URL) no se reinsertan.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { callGrokJson } = require('./grokFetch');
const { parseCount } = require('./parseCount');
const { parseXPostUrl, canonicalizeStatusUrl, statusUrl, cleanHandle } = require('./url');

const CONFIG_PATH =
  process.env.MONITORING_X_CONFIG_PATH || path.join(__dirname, '..', '..', 'config', 'monitoring-x.json');

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function emptyConfig() {
  return { accounts: [], keywords: [] };
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map((a) => String(a).trim()).filter(Boolean) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyConfig();
    throw err;
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function resultsLimit() {
  const n = Number(process.env.X_MONITOR_RESULTS_LIMIT || 30);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.round(n)) : 30;
}

function addAccount(account) {
  const clean = cleanHandle(account);
  if (!clean || !HANDLE_RE.test(clean)) {
    const e = new Error('Handle de X inválido');
    e.userMessage = 'Escribí un usuario de X válido (hasta 15 caracteres, letras, números o _).';
    throw e;
  }
  const config = loadConfig();
  const isNew = !config.accounts.some((a) => a.toLowerCase() === clean.toLowerCase());
  if (isNew) {
    config.accounts.push(clean);
    saveConfig(config);
  }
  return config;
}

function removeAccount(account) {
  const clean = cleanHandle(account);
  const config = loadConfig();
  config.accounts = config.accounts.filter((a) => a.toLowerCase() !== clean.toLowerCase());
  saveConfig(config);
  return config;
}

function addKeyword(keyword) {
  const clean = String(keyword || '').trim();
  if (!clean) {
    const e = new Error('Keyword vacía');
    e.userMessage = 'Escribí una palabra clave o hashtag.';
    throw e;
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

function buildSearchPrompt(query, limit) {
  return `Usá X Search para encontrar hasta ${limit} posteos recientes (últimas 24 horas) de X.

Búsqueda: ${query}

Devolvé ÚNICAMENTE un JSON válido (sin markdown) con esta forma:
{
  "posts": [
    {
      "id": "id numérico del tweet",
      "url": "https://x.com/handle/status/id",
      "authorHandle": "sin @",
      "text": "texto del posteo",
      "likes": 0,
      "retweets": 0,
      "replies": 0,
      "views": 0,
      "createdAt": "ISO-8601 o vacío"
    }
  ]
}

Reglas:
- Solo posteos originales, no replies.
- Números enteros, sin sufijos K/M.
- url canónica https://x.com/{handle}/status/{id} (no t.co ni i/web/status).
- Si no hay resultados, posts debe ser [].`;
}

function buildClassifyPrompt(text) {
  return `Clasificá este posteo de X para un tablero de social listening del Gobierno de la Ciudad de Buenos Aires (Jefe de Gobierno / gestión CABA).

Texto:
${String(text || '').slice(0, 2000)}

Devolvé ÚNICAMENTE JSON:
{"relevant": true, "title": "título corto en español", "sentiment": "positivo"}

sentiment es uno de: positivo, neutral, negativo.
relevant=true si habla del Jefe de Gobierno porteño, su gestión, CABA o política de la ciudad.
title: 4 a 12 palabras, sin hashtags.`;
}

function normalizeXMonitorPost(raw, { account, sourceType }) {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseXPostUrl(String(raw.url || ''));
  const tweetId = String(parsed?.id || raw.id || '').replace(/\D/g, '');
  if (!tweetId) return null;
  const handle = cleanHandle(raw.authorHandle || parsed?.handle || account) || account || 'N/D';
  const url = canonicalizeStatusUrl(raw.url, handle, tweetId) || statusUrl(handle, tweetId);
  if (!url) return null;
  return {
    id: `x:${tweetId}`,
    account: handle,
    url,
    caption: typeof raw.text === 'string' ? raw.text : '',
    likes: parseCount(raw.likes),
    comments: parseCount(raw.replies),
    retweets: parseCount(raw.retweets),
    views: parseCount(raw.views),
    postedAt: raw.createdAt || null,
    sourceType,
    plataforma: 'x',
  };
}

async function searchXPosts(query, { limit, account, sourceType }) {
  const { parsed } = await callGrokJson(buildSearchPrompt(query, limit), { maxTokens: 8000 });
  const rows = Array.isArray(parsed?.posts) ? parsed.posts : [];
  return rows
    .map((raw) => normalizeXMonitorPost(raw, { account, sourceType }))
    .filter(Boolean);
}

function textIncludesAny(text, needles) {
  const lower = (text || '').toLowerCase();
  return needles.find((needle) => lower.includes(String(needle).toLowerCase()));
}

async function classifyXPost(text) {
  try {
    const { parsed } = await callGrokJson(buildClassifyPrompt(text), { maxTokens: 400 });
    if (!parsed || typeof parsed !== 'object') return { unclassified: true };
    const sentiment = ['positivo', 'neutral', 'negativo'].includes(parsed.sentiment)
      ? parsed.sentiment
      : 'neutral';
    return {
      relevant: parsed.relevant !== false,
      title: typeof parsed.title === 'string' ? parsed.title.trim() : null,
      sentiment,
    };
  } catch (err) {
    console.warn('[x-monitor] clasificar falló:', err.message);
    return { unclassified: true };
  }
}

async function evaluateXRelevance(post, keywords) {
  const text = (post.caption || '').trim();
  if (!text) {
    if (post.sourceType === 'account') {
      return {
        relevant: true,
        title: 'Sin texto',
        sentiment: 'neutral',
        matchedReason: `Cuenta trackeada: @${post.account}`,
      };
    }
    return { relevant: false };
  }

  const literalMatch = textIncludesAny(text, keywords);
  if (literalMatch || post.sourceType === 'keyword') {
    const classified = await classifyXPost(text);
    const reason = post.sourceType === 'account'
      ? `Cuenta trackeada: @${post.account}${literalMatch ? ` (coincidencia: "${literalMatch}")` : ''}`
      : `Coincidencia con palabra clave${literalMatch ? `: "${literalMatch}"` : ''}`;
    if (classified.unclassified) {
      return { relevant: true, title: null, sentiment: null, matchedReason: `${reason} — sin clasificar` };
    }
    return {
      relevant: true,
      title: classified.title,
      sentiment: classified.sentiment,
      matchedReason: reason,
    };
  }

  const classified = await classifyXPost(text);
  if (classified.unclassified) {
    return {
      relevant: true,
      title: null,
      sentiment: null,
      matchedReason: `Cuenta trackeada: @${post.account} — sin clasificar (relevancia sin verificar)`,
    };
  }
  if (!classified.relevant) return { relevant: false };
  return {
    relevant: true,
    title: classified.title,
    sentiment: classified.sentiment,
    matchedReason: `Cuenta trackeada: @${post.account} (relacionado por contenido)`,
  };
}

async function runXMonitoringCycle() {
  const { accounts, keywords } = loadConfig();
  const limit = resultsLimit();
  const plainKeywords = keywords.map((k) => (k.startsWith('#') ? k.slice(1) : k));

  if (accounts.length === 0 && keywords.length === 0) {
    return { checked: 0, newPosts: [] };
  }

  const searches = [
    ...accounts.map((account) =>
      searchXPosts(`from:${account}`, { limit, account, sourceType: 'account' }).catch((err) => {
        console.error(`[x-monitor] falló from:${account}:`, err.message);
        return [];
      })
    ),
    ...keywords.map((keyword) =>
      searchXPosts(keyword, { limit, account: null, sourceType: 'keyword' }).catch((err) => {
        console.error(`[x-monitor] falló keyword "${keyword}":`, err.message);
        return [];
      })
    ),
  ];

  const batches = await Promise.all(searches);
  const seenInThisRun = new Map();
  for (const post of batches.flat()) {
    if (post.url && !seenInThisRun.has(post.id)) seenInThisRun.set(post.id, post);
  }

  const newPosts = [];
  for (const post of seenInThisRun.values()) {
    const existingId = db.findExistingPostId(post.id, post.url);
    if (existingId) {
      db.applyMetricsRefresh(existingId, {
        likes: post.likes,
        comments: post.comments,
        retweets: post.retweets,
        views: post.views,
      });
      continue;
    }

    const evaluation = await evaluateXRelevance(post, plainKeywords);
    if (!evaluation.relevant) continue;

    const row = {
      ...post,
      title: evaluation.title,
      sentiment: evaluation.sentiment,
      matchedReason: evaluation.matchedReason,
      followers: null,
      plataforma: 'x',
    };
    const inserted = db.saveDetectedPost(row);
    if (!inserted) continue;
    newPosts.push(row);
  }

  return { checked: seenInThisRun.size, newPosts };
}

module.exports = {
  runXMonitoringCycle,
  loadConfig,
  addAccount,
  removeAccount,
  addKeyword,
  removeKeyword,
  normalizeXMonitorPost,
  resultsLimit,
  CONFIG_PATH,
};
