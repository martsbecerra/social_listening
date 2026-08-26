// ==========================================================================
// url.js — Validación y parseo de links de posteos de X.
// ==========================================================================

const STATUS_RE = /^\/(?:i\/web\/|[A-Za-z0-9_]+\/)status\/(\d+)/;

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isValidXPostUrl(url) {
  return Boolean(parseXPostUrl(url));
}

/**
 * @param {unknown} url
 * @returns {{ id: string, url: string, hostname: string } | null}
 */
function parseXPostUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const match = STATUS_RE.exec(u.pathname);
    if (!match) return null;
    return {
      id: match[1],
      url: `https://x.com/i/web/status/${match[1]}`,
      hostname: host,
    };
  } catch {
    return null;
  }
}

module.exports = { isValidXPostUrl, parseXPostUrl };
