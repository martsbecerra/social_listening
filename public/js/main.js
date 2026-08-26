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

// Atajos del pie de página: si la URL trae #tab-analysis / #tab-monitoring /
// #tab-claims-map, abre esa solapa al cargar. Dispara el mismo click que ya
// usa el usuario — no es un camino de navegación nuevo.
if (location.hash.startsWith('#tab-')) {
  const targetTab = location.hash.slice('#tab-'.length);
  document.querySelector(`.tab-btn[data-tab="${targetTab}"]`)?.click();
}
