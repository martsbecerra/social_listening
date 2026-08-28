const GENERIC_MSG = 'Si el email está autorizado, te mandamos un link. Revisá tu casilla.';

// Fallback por si la respuesta no trae retryAfterSeconds (el valor real sale
// del backend: RESEND_COOLDOWN_MS en src/auth/rateLimit.js).
const COOLDOWN_FALLBACK_SECONDS = 120;

// Sólo la marca de tiempo, nunca la dirección: en una máquina compartida no
// hay por qué dejar el email escrito en localStorage.
const STORAGE_KEY = 'sl-login-cooldown-until';

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('loginEmail');
const statusEl = document.getElementById('loginStatus');
const submitBtn = document.getElementById('loginSubmit');
const cooldownEl = document.getElementById('loginCooldown');

let cooldownTimer = null;

function formatMmSs(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// localStorage puede fallar (modo privado, permisos): el login tiene que
// funcionar igual, sólo se pierde la restauración del contador al recargar.
function readCooldownUntil() {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function saveCooldownUntil(until) {
  try {
    localStorage.setItem(STORAGE_KEY, String(until));
  } catch {
    /* sin persistencia: el backend bloquea igual */
  }
}

function clearCooldown() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada que borrar */
  }
}

/**
 * Estado post-envío: botón "Link enviado" deshabilitado, email deshabilitado
 * (para no cambiar la dirección sin darse cuenta) y cuenta regresiva visual.
 * El contador es sólo UX: el bloqueo real está en el backend, que durante la
 * ventana responde el genérico sin mandar nada.
 */
function startCooldown(until) {
  clearInterval(cooldownTimer);
  submitBtn.disabled = true;
  submitBtn.textContent = 'Link enviado';
  emailInput.disabled = true;

  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      endCooldown();
      return;
    }
    cooldownEl.hidden = false;
    cooldownEl.textContent = `Podés pedir otro link en ${formatMmSs(left)}`;
  };
  tick();
  // tick() pudo haber cerrado el cooldown en el acto (until ya vencido): en
  // ese caso no queda nada que contar.
  if (until - Date.now() > 0) {
    cooldownTimer = setInterval(tick, 1000);
  }
}

function endCooldown() {
  clearInterval(cooldownTimer);
  cooldownTimer = null;
  clearCooldown();
  cooldownEl.hidden = true;
  cooldownEl.textContent = '';
  submitBtn.disabled = false;
  submitBtn.textContent = 'Reenviar link';
  emailInput.disabled = false;
}

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

  // Estado de carga: si el SMTP tarda, que no parezca colgado.
  const labelPrevio = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Enviando…';
  let cooldownArrancado = false;

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
      const seconds =
        Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : COOLDOWN_FALLBACK_SECONDS;
      const until = Date.now() + seconds * 1000;
      saveCooldownUntil(until);
      startCooldown(until);
      cooldownArrancado = true;
    }
  } catch {
    statusEl.textContent = 'No se pudo enviar el link. Intentá de nuevo.';
    statusEl.classList.add('is-error');
  } finally {
    if (!cooldownArrancado) {
      submitBtn.disabled = false;
      submitBtn.textContent = labelPrevio;
    }
  }
});

// Al cargar: si hay un cooldown vigente de una visita anterior, se restaura el
// estado (recargar la página no debe permitir reenviar; el backend tampoco lo
// permitiría, pero sin esto el botón parecería funcionar y el mail no saldría).
const pendingUntil = readCooldownUntil();
if (pendingUntil > Date.now()) {
  startCooldown(pendingUntil);
} else {
  clearCooldown();
}
