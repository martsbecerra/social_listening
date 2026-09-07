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

// --------------------------------------------------------------------------
// Cooldown de reenvío: máximo UN magic link cada 2 minutos por email. Es un
// límite aparte del de ráfaga de arriba y se comporta distinto: cuando pega,
// el endpoint responde el MISMO mensaje genérico de siempre (no revela que
// fue rate limit) y simplemente no manda el mail. La marca se pone recién
// cuando el SMTP aceptó el envío (ver server.js), así una falla de envío no
// deja al usuario bloqueado 2 minutos sin haber recibido nada.
// --------------------------------------------------------------------------

const RESEND_COOLDOWN_MS = 2 * 60 * 1000;

/** email (ya normalizado por el caller) -> timestamp del último envío OK */
const lastSentByEmail = new Map();

function isResendBlocked(email, now = Date.now()) {
  const last = lastSentByEmail.get(email);
  return last != null && now - last < RESEND_COOLDOWN_MS;
}

function markMagicLinkSent(email, now = Date.now()) {
  lastSentByEmail.set(email, now);
}

module.exports = {
  isMagicLinkRateLimited,
  isResendBlocked,
  markMagicLinkSent,
  RESEND_COOLDOWN_MS,
};
