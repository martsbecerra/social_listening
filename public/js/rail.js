// ==========================================================================
// rail.js — riel lateral de instagram.html (design/riel-radar-v3.html)
// --------------------------------------------------------------------------
// Las solapas del riel las cambia main.js (data-tab), igual que en x.html.
// Acá va lo propio del riel. Lo carga solo instagram.html; script clásico,
// todo con prefijo rail / RAIL_.
//   - El alto real de la cabecera, para que el riel quede fijo justo debajo
//     (--top en styles.css).
// ==========================================================================

const railTopbarEl = document.querySelector('.topbar');

function railMeasureTop() {
  if (!railTopbarEl) return;
  document.documentElement.style.setProperty('--top', `${railTopbarEl.offsetHeight}px`);
}

railMeasureTop();
if (railTopbarEl && typeof ResizeObserver === 'function') new ResizeObserver(railMeasureTop).observe(railTopbarEl);
