// Cambio de solapas (tabs), dropdown del header y sesión.

// Solapas: cada botón con data-tab muestra su .tab-panel (#tab-<nombre>) y
// esconde los demás. Son los botones del riel en instagram.html y los de la
// barra de solapas en x.html. La solapa abierta queda en el hash
// (#tab-<nombre>, sin sumar pasos al historial), y un cambio de hash abre
// esa solapa sin recargar: así navegan los enlaces del pie. Un botón con
// aria-disabled="true" (Estadísticas, hasta que exista) no abre nada.
function openTab(name, { updateHash = true } = {}) {
  const panel = document.getElementById(`tab-${name}`);
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (!panel || !btn || btn.getAttribute('aria-disabled') === 'true') return false;

  document.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b === btn;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p !== panel));
  if (updateHash && location.hash !== `#tab-${name}`) {
    history.replaceState(null, '', `#tab-${name}`);
  }

  if (name === 'claims-map' && typeof window.refreshClaimsMap === 'function') {
    window.refreshClaimsMap();
  }
  return true;
}

document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    // En el riel la página arranca de nuevo arriba, como en la maqueta.
    if (openTab(btn.dataset.tab) && btn.classList.contains('rail-btn')) window.scrollTo(0, 0);
  });
});

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#tab-')) openTab(location.hash.slice('#tab-'.length), { updateHash: false });
});

document.querySelectorAll('.user-btn').forEach((btn) => {
  const dropdown = document.getElementById(btn.dataset.dropdown);
  if (!dropdown) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });
});

document.addEventListener('click', (e) => {
  document.querySelectorAll('.user-dropdown').forEach((dropdown) => {
    const btn = document.querySelector(`.user-btn[data-dropdown="${dropdown.id}"]`);
    if (btn && (btn.contains(e.target) || dropdown.contains(e.target))) return;
    dropdown.classList.add('hidden');
  });
});

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
    if (nameEl) nameEl.textContent = displayNameFromEmail(email);
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

// Atajos del pie de página: si la URL trae #tab-analysis / #tab-monitoring /
// #tab-claims-map, abre esa solapa al cargar (sin hash, queda la que el HTML
// marca activa: Monitoreo en instagram.html).
//
// Se difiere a DOMContentLoaded porque main.js corre ANTES que claimsMap.js
// en el orden de scripts: en este momento window.refreshClaimsMap todavía no
// existe, y abrir la solapa del mapa ahora la dejaría sin inicializar.
// DOMContentLoaded dispara recién cuando todos los scripts clásicos del final
// del body terminaron.
document.addEventListener('DOMContentLoaded', () => {
  if (location.hash.startsWith('#tab-')) {
    openTab(location.hash.slice('#tab-'.length), { updateHash: false });
  }
});
