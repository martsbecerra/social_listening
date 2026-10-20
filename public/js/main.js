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
  const text = document.createElement('span');
  text.setAttribute('role', 'status');
  const fecha = mode.dataAsOf ? formatReadOnlyDate(mode.dataAsOf) : null;
  text.textContent = `Copia de solo lectura · ${fecha ? `Datos al ${fecha}` : 'Todavía no hay datos descargados'}`;
  bar.append(text);
  if (mode.newerAppAvailable) {
    const aviso = document.createElement('span');
    aviso.className = 'readonly-bar-update';
    aviso.textContent = 'Hay una versión nueva de la app: pedí el instalador actualizado';
    bar.append(' · ', aviso);
  }
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'readonly-bar-btn';
  bar.append(action);
  document.body.prepend(bar);

  if (mode.needsToken) {
    action.textContent = 'Cargar token';
    action.addEventListener('click', () => openReplicaTokenDialog(mode, text));
    openReplicaTokenDialog(mode, text);
  } else {
    action.textContent = 'Buscar datos nuevos';
    action.addEventListener('click', () => refreshReplicaData(mode, text, action));
  }

  leaveAnalysisTab();
  document.addEventListener('DOMContentLoaded', leaveAnalysisTab);
}

// Las dos acciones de la copia (POST /api/replica/refresh y
// /api/replica/token) terminan en un reinicio: la app sale, el lanzador baja
// el snapshot y la vuelve a levantar. Mientras tanto la página espera a que
// responda un arranque nuevo (otro bootId) y se recarga.
const REPLICA_WAIT_EVERY_MS = 2000;
const REPLICA_WAIT_MAX_MS = 10 * 60 * 1000;

async function replicaPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitForReplicaRestart(previousBootId, statusEl) {
  const started = Date.now();
  while (Date.now() - started < REPLICA_WAIT_MAX_MS) {
    await new Promise((resolve) => setTimeout(resolve, REPLICA_WAIT_EVERY_MS));
    try {
      const res = await fetch('/api/app/mode', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok && (await res.json()).bootId !== previousBootId) {
        window.location.reload();
        return;
      }
    } catch {
      // Todavía reiniciando: la app no responde mientras baja el snapshot.
    }
  }
  statusEl.textContent = 'La copia tarda más de lo normal en volver. Probá recargar la página en un rato.';
}

async function refreshReplicaData(mode, statusEl, button) {
  button.disabled = true;
  button.textContent = 'Buscando…';
  try {
    const { status, data } = await replicaPost('/api/replica/refresh');
    if (status === 202) {
      button.hidden = true;
      statusEl.textContent = 'Bajando los datos nuevos… La página se recarga sola cuando estén.';
      await waitForReplicaRestart(mode.bootId, statusEl);
      return;
    }
    if (status === 200) {
      button.textContent = 'Ya tenés los datos más nuevos';
      setTimeout(() => {
        button.textContent = 'Buscar datos nuevos';
        button.disabled = false;
      }, 4000);
      return;
    }
    statusEl.textContent = data.error || 'No se pudo buscar datos nuevos.';
  } catch {
    statusEl.textContent = 'No se pudo buscar datos nuevos.';
  }
  button.textContent = 'Buscar datos nuevos';
  button.disabled = false;
}

function openReplicaTokenDialog(mode, statusEl) {
  let dialog = document.querySelector('.replica-token');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'replica-token';
    dialog.setAttribute('aria-labelledby', 'replica-token-title');
    dialog.innerHTML = `
      <form class="replica-token-box" method="dialog" novalidate>
        <h2 id="replica-token-title">Falta el token de lectura</h2>
        <p>Para bajar los datos del monitoreo, esta copia necesita el token de
          lectura del repo de datos. Pedíselo a quien administra la app y pegalo acá.
          Se guarda solo en esta computadora.</p>
        <label for="replica-token-input">Token</label>
        <input id="replica-token-input" type="password" autocomplete="off" spellcheck="false" required />
        <p class="replica-token-error" role="alert" hidden></p>
        <div class="replica-token-actions">
          <button type="button" class="btn-ghost" data-action="later">Ahora no</button>
          <button type="submit" class="btn">Guardar</button>
        </div>
      </form>`;
    document.body.append(dialog);
  }
  const form = dialog.querySelector('form');
  const input = dialog.querySelector('input');
  const errorEl = dialog.querySelector('.replica-token-error');
  const submit = dialog.querySelector('button[type="submit"]');
  const later = dialog.querySelector('[data-action="later"]');

  later.onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const token = input.value.trim();
    if (!token) {
      errorEl.textContent = 'Pegá el token antes de guardar.';
      errorEl.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Probando…';
    try {
      const { status, data } = await replicaPost('/api/replica/token', { token });
      if (status === 200) {
        input.value = '';
        dialog.close();
        const barButton = document.querySelector('.readonly-bar-btn');
        if (barButton) barButton.hidden = true;
        statusEl.textContent = 'Token guardado. Bajando los datos… La primera vez puede tardar unos minutos.';
        await waitForReplicaRestart(mode.bootId, statusEl);
        return;
      }
      errorEl.textContent = data.error || 'No se pudo guardar el token.';
    } catch {
      errorEl.textContent = 'No se pudo guardar el token.';
    }
    errorEl.hidden = false;
    submit.disabled = false;
    submit.textContent = 'Guardar';
  };

  if (!dialog.open) dialog.showModal();
  input.focus();
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
