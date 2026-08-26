// ==========================================================================
// rateLimit.js
// --------------------------------------------------------------------------
// Límite en memoria para POST /api/auth/magic-link (un solo proceso Express).
// ==========================================================================

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 10;

const hits = new Map();

function prune(now) {
  for (const [key, times] of hits) {
    const next = times.filter((t) => now - t < WINDOW_MS);
    if (next.length === 0) hits.delete(key);
    else hits.set(key, next);
  }
}

function isOverLimit(key, max, now) {
  const times = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= max) {
    hits.set(key, times);
    return true;
  }
  times.push(now);
  hits.set(key, times);
  return false;
}

/**
 * Consume un slot. Devuelve true si hay que rechazar el pedido.
 */
function isMagicLinkRateLimited({ ip, email }) {
  const now = Date.now();
  if (hits.size > 500) prune(now);
  const ipLimited = isOverLimit(`ip:${ip || 'unknown'}`, MAX_PER_IP, now);
  const emailLimited = isOverLimit(`email:${email || 'empty'}`, MAX_PER_EMAIL, now);
  return ipLimited || emailLimited;
}

module.exports = { isMagicLinkRateLimited };
