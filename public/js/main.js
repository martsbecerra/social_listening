// Cambio de solapas (tabs), dropdown del header y sesión.

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));

    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');

    if (btn.dataset.tab === 'claims-map' && typeof window.refreshClaimsMap === 'function') {
      window.refreshClaimsMap();
    }
  });
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
  } catch {
    window.location.replace('/');
    return;
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } finally {
        window.location.replace('/');
      }
    });
  }
}

initAuthHeader();

// Réplica de solo lectura (APP_MODE=replica, ver
// openspec/changes/replicas-solo-lectura): <html data-readonly> esconde por
// CSS los controles que escriben, una franja dice de cuándo son los datos y
// la solapa de análisis (que gasta en Apify y en el LLM) no se abre. El
// servidor es la barrera real: lo que se escape de acá recibe 403.
function formatReadOnlyDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

function leaveAnalysisTab() {
  const analysis = document.querySelector('.tab-btn[data-tab="analysis"]');
  if (analysis && analysis.classList.contains('active')) {
    document.querySelector('.tab-btn[data-tab="monitoring"]')?.click();
  }
}

async function initReadOnlyMode() {
  let mode;
  try {
    const res = await fetch('/api/app/mode', { credentials: 'same-origin' });
    if (!res.ok) return;
    mode = await res.json();
  } catch {
    return;
  }
  if (!mode || !mode.readOnly) return;

  document.documentElement.dataset.readonly = '1';
  // Los selectores que ya se dibujaron antes de saber el modo; los nuevos
  // salen deshabilitados de buildSentimentSelect y estadoSelectHtml.
  document
    .querySelectorAll('select.sentiment-select, select.claims-popup-estado')
    .forEach((select) => (select.disabled = true));
  const bar = document.createElement('div');
  bar.className = 'readonly-bar';
  bar.setAttribute('role', 'status');
  const fecha = mode.dataAsOf ? formatReadOnlyDate(mode.dataAsOf) : null;
  bar.textContent = `Copia de solo lectura · ${fecha ? `Datos al ${fecha}` : 'Todavía no hay datos descargados'}`;
  if (mode.newerAppAvailable) {
    const aviso = document.createElement('span');
    aviso.className = 'readonly-bar-update';
    aviso.textContent = 'Hay una versión nueva de la app: pedí el instalador actualizado';
    bar.append(' · ', aviso);
  }
  document.body.prepend(bar);

  leaveAnalysisTab();
  document.addEventListener('DOMContentLoaded', leaveAnalysisTab);
}

initReadOnlyMode();

// Atajos del pie de página: si la URL trae #tab-analysis / #tab-monitoring /
// #tab-claims-map, abre esa solapa al cargar. Dispara el mismo click que ya
// usa el usuario — no es un camino de navegación nuevo.
//
// Se difiere a DOMContentLoaded porque main.js corre ANTES que claimsMap.js
// en el orden de scripts: en este momento window.refreshClaimsMap todavía no
// existe, y el click directo abriría la solapa del mapa sin inicializarlo
// (el guard del handler lo saltea en silencio). DOMContentLoaded dispara
// recién cuando todos los scripts clásicos del final del body terminaron.
document.addEventListener('DOMContentLoaded', () => {
  if (location.hash.startsWith('#tab-')) {
    const targetTab = location.hash.slice('#tab-'.length);
    document.querySelector(`.tab-btn[data-tab="${targetTab}"]`)?.click();
  }
});
