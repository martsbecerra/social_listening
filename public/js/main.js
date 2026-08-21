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

  btn.addEventListener('click', () => {
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
});

async function initAuthHeader() {
  const emailEl = document.querySelector('.user-dropdown .user-email');
  const logoutBtn = document.querySelector('.user-dropdown .logout-btn');
  if (!emailEl && !logoutBtn) return;

  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.replace('/');
      return;
    }
    const data = await res.json();
    if (emailEl) emailEl.textContent = data.email || '';
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
