// ==========================================================================
// parseCount.js — Normaliza cifras de X / CSV (K, M, "Mil", "millones").
// ==========================================================================

/**
 * Convierte "45K", "1,2M", "86,6 Mil", "1,6 millones", 164000 → entero.
 * "Mil" NUNCA es millón: "163,2 Mil" = 163200.
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseCount(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw);
  }

  let s = String(raw).trim();
  if (!s || /^n\/?d$/i.test(s) || s === '-') return null;
  s = s.replace(/\s+/g, ' ');
  const lower = s.toLowerCase();

  let multiplier = 1;
  if (/millones|millón|million/.test(lower)) {
    multiplier = 1_000_000;
  } else if (/\bmil\b/.test(lower)) {
    multiplier = 1_000;
  } else {
    const compact = s.replace(/\s+/g, '');
    if (/[mM]$/.test(compact) && !/mil/i.test(compact)) multiplier = 1_000_000;
    else if (/[kK]$/.test(compact)) multiplier = 1_000;
  }

  const numericPart = s
    .replace(/millones|millón|million|\bmil\b/gi, '')
    .replace(/[kKmM]\s*$/g, '')
    .trim();

  if (!numericPart) return null;

  let n;
  if (multiplier > 1) {
    const normalized = numericPart.includes(',')
      ? numericPart.replace(/\./g, '').replace(',', '.')
      : numericPart;
    n = Number(normalized);
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(numericPart)) {
    n = Number(numericPart.replace(/[.,]/g, ''));
  } else if (/^\d+[.,]\d+$/.test(numericPart)) {
    n = Number(numericPart.replace(',', '.'));
  } else {
    n = Number(numericPart.replace(/[^\d.-]/g, ''));
  }

  if (!Number.isFinite(n)) return null;
  return Math.round(n * multiplier);
}

module.exports = { parseCount };
