// Barra superior (diseño v4): solapas de la píldora, menú del usuario y
// sesión. Lo carga cada página con sesión (instagram.html, x.html y
// dashboard.html).

// ---------------------------------------------------------------------------
// Solapas: cada botón de la píldora ([role="tab"][data-tab]) muestra su
// .tab-panel (#tab-<nombre>) y esconde los demás; la pastilla de color se
// corre al botón elegido. La solapa abierta queda en el hash (#tab-<nombre>,
// sin sumar pasos al historial), y un cambio de hash abre esa solapa sin
// recargar: así navegan los enlaces del pie. Un botón con aria-disabled
// (Estadísticas, hasta que exista su pantalla) no abre nada.
// Teclas: 1, 2, 3... abren la solapa de ese número (no mientras se escribe
// ni con un pop-up abierto); ← y → recorren la píldora con el foco en ella.
// ---------------------------------------------------------------------------
const tabButtons = [...document.querySelectorAll('nav.tabs [role="tab"][data-tab]')];
const tabPillEl = document.querySelector('nav.tabs .pill');
const topEl = document.querySelector('.top');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function moveTabPill() {
  const selected = tabButtons.find((b) => b.getAttribute('aria-selected') === 'true');
  if (!tabPillEl || !selected) return;
  tabPillEl.style.left = `${selected.offsetLeft}px`;
  tabPillEl.style.width = `${selected.offsetWidth}px`;
}

// Las .rv de la solapa que aparece vuelven a subir escalonadas, como en la
// maqueta (sin esto la animación corre una sola vez, al cargar).
function replayReveal(panel) {
  panel.querySelectorAll('.rv').forEach((el) => {
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = '';
  });
}

function openTab(name, { updateHash = true } = {}) {
  const panel = document.getElementById(`tab-${name}`);
  const btn = tabButtons.find((b) => b.dataset.tab === name);
  if (!panel || !btn || btn.getAttribute('aria-disabled') === 'true') return false;

  const wasOpen = !panel.classList.contains('hidden');
  tabButtons.forEach((b) => {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  moveTabPill();
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p !== panel));
  if (!wasOpen) replayReveal(panel);
  if (updateHash && location.hash !== `#tab-${name}`) {
    history.replaceState(null, '', `#tab-${name}`);
  }

  if (name === 'claims-map' && typeof window.refreshClaimsMap === 'function') {
    window.refreshClaimsMap();
  }
  return true;
}

// Al cambiar de solapa la página arranca de nuevo arriba.
function openTabFromUser(name) {
  if (openTab(name)) window.scrollTo(0, 0);
}

tabButtons.forEach((btn) => {
  btn.tabIndex = btn.getAttribute('aria-selected') === 'true' ? 0 : -1;
  btn.addEventListener('click', () => openTabFromUser(btn.dataset.tab));
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const usable = tabButtons.filter((b) => b.getAttribute('aria-disabled') !== 'true');
    const i = usable.indexOf(btn);
    if (i < 0) return;
    const next = usable[(i + (e.key === 'ArrowRight' ? 1 : usable.length - 1)) % usable.length];
    e.preventDefault();
    next.focus();
    openTabFromUser(next.dataset.tab);
  });
});

function typingIn(target) {
  if (!target || !(target instanceof Element)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select'));
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
  if (!/^[1-9]$/.test(e.key) || typingIn(e.target)) return;
  // Con el pop-up del posteo o un modal abierto, las teclas son de ellos.
  if (document.querySelector('dialog[open], .modal-overlay:not(.hidden)')) return;
  const btn = tabButtons[Number(e.key) - 1];
  if (!btn) return;
  e.preventDefault();
  openTabFromUser(btn.dataset.tab);
});

window.addEventListener('resize', moveTabPill);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabPill);

// ---------------------------------------------------------------------------
// Alto real de la barra superior (--top en styles.css): la barra de filtros
// se pega justo debajo y las cajas de fuentes dejan ese aire al saltar a
// ellas.
// ---------------------------------------------------------------------------
function measureTop() {
  if (!topEl) return;
  document.documentElement.style.setProperty('--top', `${topEl.offsetHeight}px`);
}
measureTop();
if (topEl && typeof ResizeObserver === 'function') new ResizeObserver(measureTop).observe(topEl);

// ---------------------------------------------------------------------------
// Enlaces del pie a las fuentes (instagram.html#fuentes-busquedas | -cuentas
// | -palabras | -hashtags): abren el Monitoreo, bajan a esa caja y enfocan
// su campo. Después el hash vuelve a ser el de la solapa, así el mismo
// enlace sirve la próxima vez.
// ---------------------------------------------------------------------------
const SOURCE_BOXES = { busquedas: 'srcBusquedas', cuentas: 'srcCuentas', palabras: 'srcPalabras', hashtags: 'srcPalabras' };

function goToSourceBox(box, smooth) {
  box.scrollIntoView({ block: 'start', behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' });
  const input = box.querySelector('input');
  if (input) input.focus({ preventScroll: true });
}

// Al cargar la página (onLoad), el salto espera al load y es inmediato: si
// no, el navegador corta el desplazamiento y el campo pierde el foco cuando
// se llega desde un enlace de otra página.
function openSourceFromHash({ onLoad = false } = {}) {
  const match = /^#fuentes-(busquedas|cuentas|palabras|hashtags)$/.exec(location.hash);
  if (!match) return false;
  const box = document.getElementById(SOURCE_BOXES[match[1]]);
  if (!box || !openTab('monitoring', { updateHash: false })) return false;
  history.replaceState(null, '', '#tab-monitoring');
  if (!onLoad) goToSourceBox(box, true);
  else if (document.readyState === 'complete') goToSourceBox(box, false);
  else window.addEventListener('load', () => goToSourceBox(box, false), { once: true });
  return true;
}

window.addEventListener('hashchange', () => {
  if (openSourceFromHash()) return;
  if (location.hash.startsWith('#tab-')) openTab(location.hash.slice('#tab-'.length), { updateHash: false });
});

// ---------------------------------------------------------------------------
// Menú del usuario.
// ---------------------------------------------------------------------------
document.querySelectorAll('.user-btn').forEach((btn) => {
  const dropdown = document.getElementById(btn.dataset.dropdown);
  if (!dropdown) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(!dropdown.classList.contains('hidden')));
  });
});

function closeUserDropdowns(except) {
  document.querySelectorAll('.user-dropdown').forEach((dropdown) => {
    const btn = document.querySelector(`.user-btn[data-dropdown="${dropdown.id}"]`);
    if (except && ((btn && btn.contains(except)) || dropdown.contains(except))) return;
    dropdown.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('click', (e) => closeUserDropdowns(e.target));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUserDropdowns(null);
});

// ---------------------------------------------------------------------------
// Sesión: correo, iniciales y nombre del usuario; sin sesión, al login.
// ---------------------------------------------------------------------------
function initialsFromEmail(email) {
  const local = String(email || '').split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (local.slice(0, 2) || '?').toUpperCase();
}

function displayNameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return email || '';
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

async function initAuthHeader() {
  const emailEl = document.querySelector('.user-dropdown .user-email');
  const logoutBtn = document.querySelector('.user-dropdown .logout-btn');
  const avatarEl = document.querySelector('.user-btn .avatar');
  const nameEl = document.querySelector('.user-btn .user-name');
  if (!emailEl && !logoutBtn && !avatarEl) return;

  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json();
    const email = data.email || '';
    if (emailEl) emailEl.textContent = email;
    if (avatarEl) avatarEl.textContent = initialsFromEmail(email);
    // En el botón, el nombre de pila (como la maqueta): con el completo la
    // barra no entra en un renglón a 1366 px. El completo queda de título.
    if (nameEl) {
      const fullName = displayNameFromEmail(email);
      nameEl.textContent = fullName.split(' ')[0];
      nameEl.closest('.user-btn').title = fullName;
    }
    // El nombre en la columna "Cuenta" del pie (lo arma footer.js).
    document.querySelectorAll('[data-user-name]').forEach((el) => {
      el.textContent = displayNameFromEmail(email);
    });
  } catch {
    window.location.replace('/');
  }
}

// "Cerrar sesión" del menú del usuario y del pie. Delegado en el documento:
// el pie lo arma footer.js, que corre después que este archivo.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.user-dropdown .logout-btn, [data-logout]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.replace('/');
  }
});

initAuthHeader();

// Si la URL trae #tab-analysis / #tab-monitoring / #tab-claims-map (o
// #fuentes-…), abre esa solapa al cargar; sin hash queda la que el HTML
// marca elegida. Se difiere a DOMContentLoaded porque main.js corre ANTES que
// claimsMap.js: abrir el mapa ahora lo dejaría sin inicializar.
// El hash es también el id de la solapa, y el navegador salta hasta ella
// (con la cabecera tapada por la barra superior): la página arranca arriba,
// donde empieza la solapa igual.
document.addEventListener('DOMContentLoaded', () => {
  if (openSourceFromHash({ onLoad: true })) return;
  if (location.hash.startsWith('#tab-')) {
    openTab(location.hash.slice('#tab-'.length), { updateHash: false });
    window.scrollTo(0, 0);
    window.addEventListener('load', () => window.scrollTo(0, 0), { once: true });
  }
  moveTabPill();
});
moveTabPill();
