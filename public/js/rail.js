// ==========================================================================
// rail.js — riel lateral de instagram.html (design/riel-radar-v3.html)
// --------------------------------------------------------------------------
// Las solapas del riel las cambia main.js (data-tab), igual que en x.html.
// Acá va lo propio del riel. Lo carga solo instagram.html; script clásico,
// todo con prefijo rail / RAIL_.
//   - El alto real de la cabecera, para que el riel quede fijo justo debajo
//     (--top en styles.css).
//   - El panel de fuentes: lo abren los botones "Fuentes" del riel y los
//     enlaces del pie (#fuentes-busquedas | -cuentas | -palabras). Al abrir
//     hace scroll al grupo de ese botón y enfoca su campo. Se cierra con
//     Esc, con un clic afuera o con la ✕. Las listas y sus botones son los
//     de siempre: los maneja monitoring.js con sus mismos ids.
// ==========================================================================

const railTopbarEl = document.querySelector('.topbar');

function railMeasureTop() {
  if (!railTopbarEl) return;
  document.documentElement.style.setProperty('--top', `${railTopbarEl.offsetHeight}px`);
}

railMeasureTop();
if (railTopbarEl && typeof ResizeObserver === 'function') new ResizeObserver(railMeasureTop).observe(railTopbarEl);

// ---------------------------------------------------------------------------
// Panel de fuentes
// ---------------------------------------------------------------------------
const RAIL_SOURCE_GROUPS = { busquedas: 'srcBusquedas', cuentas: 'srcCuentas', palabras: 'srcPalabras' };
const railPanelEl = document.getElementById('srcPanel');
const railBackdropEl = document.getElementById('srcBackdrop');
const railCloseEl = document.getElementById('srcClose');
const railSourceBtns = document.querySelectorAll('.rail-src');
const railReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let railOpenKey = null;
// Adónde vuelve el foco al cerrar: el botón que abrió el panel.
let railReturnFocusEl = null;

function railSourcesOpen() {
  return railOpenKey !== null;
}

function railOpenSources(key, openerEl = null) {
  if (!railPanelEl || !RAIL_SOURCE_GROUPS[key]) return;
  railOpenKey = key;
  if (openerEl) railReturnFocusEl = openerEl;
  railPanelEl.inert = false;
  railPanelEl.setAttribute('aria-hidden', 'false');
  railPanelEl.classList.add('on');
  railBackdropEl.classList.add('on');
  railSourceBtns.forEach((btn) => btn.setAttribute('aria-expanded', String(btn.dataset.src === key)));

  const group = document.getElementById(RAIL_SOURCE_GROUPS[key]);
  if (!group) return;
  group.scrollIntoView({ block: 'start', behavior: railReducedMotion.matches ? 'auto' : 'smooth' });
  const input = group.querySelector('input');
  if (input) input.focus({ preventScroll: true });
}

function railCloseSources() {
  if (!railPanelEl || !railSourcesOpen()) return;
  railOpenKey = null;
  railPanelEl.classList.remove('on');
  railBackdropEl.classList.remove('on');
  railPanelEl.setAttribute('aria-hidden', 'true');
  railPanelEl.inert = true;
  railSourceBtns.forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
  if (railReturnFocusEl && document.contains(railReturnFocusEl)) railReturnFocusEl.focus({ preventScroll: true });
  railReturnFocusEl = null;
}

// Enlace del pie (instagram.html#fuentes-cuentas): abre el panel en ese
// grupo y deja en el hash la solapa abierta, así el mismo enlace vuelve a
// funcionar la próxima vez.
function railOpenFromHash() {
  const match = /^#fuentes-(busquedas|cuentas|palabras)$/.exec(location.hash);
  if (!match) return;
  const activeTab = document.querySelector('[data-tab].active');
  history.replaceState(null, '', activeTab ? `#tab-${activeTab.dataset.tab}` : location.pathname);
  railOpenSources(match[1], null);
}

if (railPanelEl) {
  railSourceBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      // El mismo botón con el panel abierto lo cierra; otro, salta a su grupo.
      if (railOpenKey === btn.dataset.src) railCloseSources();
      else railOpenSources(btn.dataset.src, btn);
    });
  });
  railCloseEl.addEventListener('click', railCloseSources);
  railBackdropEl.addEventListener('click', railCloseSources);
  document.addEventListener('keydown', (e) => {
    // Esc del pop-up del feed o de un modal no es para el panel.
    if (e.key === 'Escape' && railSourcesOpen() && !document.querySelector('dialog[open]')) railCloseSources();
  });
  window.addEventListener('hashchange', railOpenFromHash);
  railOpenFromHash();
}
