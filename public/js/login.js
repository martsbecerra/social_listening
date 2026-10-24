// --------------------------------------------------------------------
// La tarjeta del login (index.html), diseño v4: el link mágico en dos
// pasos.
//   1. El correo y "Mandarme el link →" (enviando… y enviado ✓).
//   2. "Revisá tu correo": a qué dirección se mandó, "Mandar otro link"
//      (con la cuenta regresiva de retryAfterSeconds) y "Cambiar el
//      correo", que vuelve al paso 1 sin trabar otra dirección.
// /api/auth/magic-link responde SIEMPRE lo mismo, esté o no habilitado el
// correo: la pantalla nunca dice "no autorizado". Los únicos errores son
// los reales: un correo mal escrito (se mira acá), 429, 503 y sin
// conexión. La visual de la izquierda es loginScene.js.
//
// La espera del reenvío es por dirección y queda en sessionStorage (esa
// pestaña, unos minutos): recargar y volver a pedir para la misma dirección
// no hace creer que salió otro link, cosa que el backend tampoco haría
// (RESEND_COOLDOWN_MS en src/auth/rateLimit.js: responde lo mismo y no
// manda nada). Nunca en localStorage: en una máquina compartida la
// dirección no tiene por qué quedar escrita.
//
// Script clásico: todo lo suyo lleva prefijo login / LOGIN_. Todo texto
// entra por textContent.
// --------------------------------------------------------------------
const LOGIN_COOLDOWN_FALLBACK_SECONDS = 120; // si la respuesta no trae retryAfterSeconds
const LOGIN_SENT_KEY = 'sl.login.enviados';
const LOGIN_OLD_KEY = 'sl-login-cooldown-until'; // el de antes (solo la hora): se borra
const LOGIN_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_LABEL = 'Mandarme el link →';
const LOGIN_AGAIN_LABEL = 'Mandar otro link';
const loginReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const loginStep1 = document.getElementById('loginStep1');
const loginStep2 = document.getElementById('loginStep2');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginSubmit = document.getElementById('loginSubmit');
const loginErr = document.getElementById('loginErr');
const loginErr2 = document.getElementById('loginErr2');
const loginMailTo = document.getElementById('loginMailTo');
const loginSentNote = document.getElementById('loginSentNote');
const loginBack = document.getElementById('loginBack');
const loginAgain = document.getElementById('loginAgain');
const loginLive = document.getElementById('loginLive');

// Lo mandado en esta página, por si sessionStorage no anda.
const loginSentMemory = new Map();
let loginAddress = ''; // la dirección del paso 2
let loginTimer = 0;
// Uno por pedido: con un reenvío en vuelo se puede volver al paso 1 y pedir
// para otra dirección.
let loginSending = false; // "Mandarme el link →"
let loginResending = false; // "Mandar otro link"

function loginWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, loginReducedMotion.matches ? 0 : ms));
}

function loginMmSs(totalSeconds) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function loginSetLabel(text) {
  loginSubmit.firstElementChild.textContent = text;
}

// ---------- lo ya mandado, por dirección ----------

function loginReadSent() {
  const now = Date.now();
  const sent = {};
  try {
    const raw = JSON.parse(sessionStorage.getItem(LOGIN_SENT_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      for (const [address, until] of Object.entries(raw)) if (Number(until) > now) sent[address] = Number(until);
    }
  } catch {
    /* sin almacenamiento: queda lo de la memoria */
  }
  for (const [address, until] of loginSentMemory) if (until > now && !(sent[address] > until)) sent[address] = until;
  return sent;
}

function loginSentUntil(address) {
  return loginReadSent()[address.toLowerCase()] || 0;
}

function loginRememberSent(address, until) {
  const key = address.toLowerCase();
  loginSentMemory.set(key, until);
  try {
    const sent = loginReadSent();
    sent[key] = until;
    sessionStorage.setItem(LOGIN_SENT_KEY, JSON.stringify(sent));
  } catch {
    /* sin almacenamiento: el backend espera igual */
  }
}

// ---------- pantalla ----------

function loginShowError(el, text) {
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('shake');
  void el.offsetWidth; // para que la sacudida vuelva a empezar
  el.classList.add('shake');
}

function loginClearError(el) {
  el.hidden = true;
  el.textContent = '';
  el.classList.remove('shake');
}

function loginShowStep(step) {
  const show = step === 2 ? loginStep2 : loginStep1;
  const hide = step === 2 ? loginStep1 : loginStep2;
  hide.hidden = true;
  hide.classList.remove('in');
  show.hidden = false;
  show.classList.remove('in');
  void show.offsetWidth;
  show.classList.add('in');
}

// aria-disabled y no disabled: deshabilitar el botón que tiene el foco lo
// manda a <body> (y con Tab ya no se llegaría a la cuenta regresiva).
function loginSetAgainOff(off) {
  if (off) loginAgain.setAttribute('aria-disabled', 'true');
  else loginAgain.removeAttribute('aria-disabled');
}

// "Mandar otro link en 1:52" mientras haya que esperar; después, el botón.
function loginTickAgain() {
  clearInterval(loginTimer);
  loginTimer = 0;
  const update = () => {
    const left = Math.ceil((loginSentUntil(loginAddress) - Date.now()) / 1000);
    if (left > 0) {
      loginSetAgainOff(true);
      loginAgain.textContent = `${LOGIN_AGAIN_LABEL} en ${loginMmSs(left)}`;
      return true;
    }
    loginSetAgainOff(false);
    loginAgain.textContent = LOGIN_AGAIN_LABEL;
    return false;
  };
  if (update()) {
    loginTimer = setInterval(() => {
      if (!update()) {
        clearInterval(loginTimer);
        loginTimer = 0;
      }
    }, 1000);
  }
}

function loginGoToStep2(address, { already = false } = {}) {
  loginAddress = address;
  loginMailTo.textContent = address;
  loginSentNote.textContent = already ? 'Ya te mandamos un link hace instantes a:' : 'Tocá el link que te mandamos a:';
  loginClearError(loginErr2);
  loginLive.textContent = '';
  loginShowStep(2);
  loginTickAgain();
  document.getElementById('loginTitle2').focus();
}

// ---------- pedir el link ----------

// { ok: true, seconds } o { ok: false, error }
async function loginRequest(address) {
  try {
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: address }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const seconds = Number(data.retryAfterSeconds) > 0 ? Number(data.retryAfterSeconds) : LOGIN_COOLDOWN_FALLBACK_SECONDS;
      return { ok: true, seconds };
    }
    if (res.status === 429) return { ok: false, error: 'Demasiados intentos. Probá en unos minutos.' };
    if (res.status === 503) return { ok: false, error: 'El acceso no está disponible ahora. Avisale a quien administra la app.' };
    return { ok: false, error: 'No se pudo mandar el link. Probá de nuevo.' };
  } catch {
    return { ok: false, error: 'No hay conexión con la app. Revisá la red y probá de nuevo.' };
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginSending) return;
  loginClearError(loginErr);
  const address = loginEmail.value.trim();
  if (!LOGIN_EMAIL_RE.test(address)) {
    loginShowError(loginErr, address ? 'Revisá el correo: tiene que ser como nombre@buenosaires.gob.ar.' : 'Escribí tu correo.');
    loginEmail.focus();
    return;
  }
  // Ya se pidió hace instantes para esta dirección: el backend no mandaría
  // otro; el que salió sigue sirviendo.
  if (loginSentUntil(address) > Date.now()) {
    loginGoToStep2(address, { already: true });
    return;
  }

  loginSending = true;
  loginSubmit.setAttribute('aria-disabled', 'true');
  loginSubmit.classList.add('busy');
  loginSetLabel('Enviando el link…');
  const result = await loginRequest(address);
  loginSubmit.classList.remove('busy');
  if (!result.ok) {
    loginSending = false;
    loginSubmit.removeAttribute('aria-disabled');
    loginSetLabel(LOGIN_LABEL);
    loginShowError(loginErr, result.error);
    return;
  }
  loginRememberSent(address, Date.now() + result.seconds * 1000);
  loginSubmit.classList.add('ok');
  loginSetLabel('Link enviado ✓');
  await loginWait(700);
  loginSubmit.classList.remove('ok');
  loginSubmit.removeAttribute('aria-disabled');
  loginSetLabel(LOGIN_LABEL);
  loginSending = false;
  loginGoToStep2(address);
});

loginEmail.addEventListener('input', () => {
  if (!loginErr.hidden) loginClearError(loginErr);
});

loginAgain.addEventListener('click', async () => {
  if (loginResending || loginAgain.getAttribute('aria-disabled') === 'true') return;
  loginClearError(loginErr2);
  loginLive.textContent = '';
  loginResending = true;
  clearInterval(loginTimer);
  loginTimer = 0;
  loginSetAgainOff(true);
  loginAgain.textContent = 'Enviando…';
  const address = loginAddress;
  const result = await loginRequest(address);
  loginResending = false;
  if (!result.ok) {
    loginShowError(loginErr2, result.error);
    loginTickAgain();
    return;
  }
  loginRememberSent(address, Date.now() + result.seconds * 1000);
  loginAgain.textContent = 'Link reenviado ✓';
  loginLive.textContent = `Te mandamos otro link a ${address}.`;
  await loginWait(2500);
  if (loginAddress === address && !loginStep2.hidden) loginTickAgain();
});

loginBack.addEventListener('click', () => {
  clearInterval(loginTimer);
  loginTimer = 0;
  loginClearError(loginErr);
  loginShowStep(1);
  loginEmail.focus();
  loginEmail.select();
});

// El cooldown de antes (una sola hora para cualquier dirección) ya no se usa.
try {
  localStorage.removeItem(LOGIN_OLD_KEY);
} catch {
  /* nada que borrar */
}
