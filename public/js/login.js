const GENERIC_MSG = 'Si el email está autorizado, te mandamos un link. Revisá tu casilla.';

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('loginEmail');
const statusEl = document.getElementById('loginStatus');
const submitBtn = document.getElementById('loginSubmit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusEl.textContent = '';
  statusEl.className = 'login-status';

  const email = emailInput.value.trim();
  if (!email) {
    statusEl.textContent = 'Ingresá tu email.';
    statusEl.classList.add('is-error');
    emailInput.focus();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Enviando…';

  try {
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      statusEl.textContent = data.error || 'Demasiados intentos. Probá en unos minutos.';
      statusEl.classList.add('is-error');
    } else if (!res.ok) {
      statusEl.textContent = data.error || 'No se pudo enviar el link. Intentá de nuevo.';
      statusEl.classList.add('is-error');
    } else {
      statusEl.textContent = data.message || GENERIC_MSG;
    }
  } catch {
    statusEl.textContent = 'No se pudo enviar el link. Intentá de nuevo.';
    statusEl.classList.add('is-error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Enviarme el link';
  }
});
