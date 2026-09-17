// ==========================================================================
// url.js — Validación y parseo de links de posteos de X.
// ==========================================================================

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function cleanHandle(raw) {
  return String(raw || '')
    .replace(/^@+/, '')
    .trim();
}

/**
 * @param {unknown} handle
 * @returns {string}
 */
function profileUrl(handle) {
  const h = cleanHandle(handle);
  if (!h || !HANDLE_RE.test(h) || h.toLowerCase() === 'desconocido') return '';
  return `https://x.com/${h}`;
}

/**
 * @param {unknown} handle
 * @param {unknown} id
 * @returns {string}
 */
function statusUrl(handle, id) {
  const sid = String(id || '').replace(/\D/g, '');
  if (!sid) return '';
  const h = cleanHandle(handle);
  if (h && HANDLE_RE.test(h) && h.toLowerCase() !== 'i') {
    return `https://x.com/${h}/status/${sid}`;
  }
  return `https://x.com/i/web/status/${sid}`;
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isValidXPostUrl(url) {
  return Boolean(parseXPostUrl(url));
}

/**
 * @param {unknown} url
 * @returns {{ id: string, handle: string|null, url: string, hostname: string } | null}
 */
function parseXPostUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return null;

    const web = /^\/i\/web\/status\/(\d+)/i.exec(u.pathname);
    if (web) {
      return {
        id: web[1],
        handle: null,
        url: statusUrl(null, web[1]),
        hostname: host,
      };
    }

    const named = /^\/([A-Za-z0-9_]+)\/status\/(\d+)/i.exec(u.pathname);
    if (!named) return null;
    const handle = named[1];
    const id = named[2];
    return {
      id,
      handle,
      url: statusUrl(handle, id),
      hostname: host,
    };
  } catch {
    return null;
  }
}

/**
 * Preferí https://x.com/{handle}/status/{id} (no i/web ni t.co).
 * @param {unknown} url
 * @param {unknown} [handle]
 * @param {unknown} [id]
 * @returns {string}
 */
function canonicalizeStatusUrl(url, handle, id) {
  const parsed = typeof url === 'string' && url.trim() ? parseXPostUrl(url) : null;
  const sid =
    parsed?.id ||
    (String(id || '').match(/^\d+$/) ? String(id) : '') ||
    (typeof url === 'string' && /^\d+$/.test(url.trim()) ? url.trim() : '');
  const h = parsed?.handle || handle;
  const canonical = statusUrl(h, sid);
  if (canonical) return canonical;
  return typeof url === 'string' ? url.trim() : '';
}

module.exports = {
  HANDLE_RE,
  isValidXPostUrl,
  parseXPostUrl,
  statusUrl,
  profileUrl,
  canonicalizeStatusUrl,
  cleanHandle,
};
