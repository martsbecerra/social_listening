// --------------------------------------------------------------------
// El último paso del link mágico (login-verify.html), diseño v4. El link
// del correo trae ?token=; la página lo guarda, lo saca de la dirección
// (history.replaceState: no queda en el historial ni en una captura) y
// entra recién con el clic en "Entrar", para que un filtro de correo que
// abre los links no use el token por la persona.
//
// "Entrar" manda el token a POST /api/auth/verify por fetch, con el mismo
// cuerpo del formulario de siempre (la ruta no cambió): si entró, la
// respuesta es la redirección al inicio con la cookie de sesión y se va a
// /dashboard.html; un 400 (vencido, usado o inválido) muestra la tarjeta
// "El link venció o ya se usó"; un error de red o del servidor deja
// probar de nuevo. La visual de la izquierda es loginScene.js.
//
// Script clásico: todo lo suyo lleva prefijo verify / VERIFY_. Todo texto
// entra por textContent.
// --------------------------------------------------------------------
const VERIFY_HOME = '/dashboard.html';
const verifyReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const verifyForm = document.getElementById('verifyForm');
const verifyTokenInput = document.getElementById('tokenInput');
const verifySubmit = document.getElementById('verifySubmit');
const verifyErr = document.getElementById('verifyErr');
const verifyStep = document.getElementById('verifyStep');
const verifyFail = document.getElementById('verifyFail');
const verifyFailTitle = document.getElementById('verifyFailTitle');
const verifyFailNote = document.getElementById('verifyFailNote');

const verifyToken = new URLSearchParams(window.location.search).get('token') || '';
let verifyBusy = false;

function verifySetLabel(text) {
  verifySubmit.firstElementChild.textContent = text;
}

function verifyShowError(text) {
  verifyErr.textContent = text;
  verifyErr.hidden = false;
  verifyErr.classList.remove('shake');
  void verifyErr.offsetWidth;
  verifyErr.classList.add('shake');
}

// La tarjeta del link que no sirve: vencido o usado, o sin token en la
// dirección (se abrió la página sola, o se recargó después de sacarlo).
function verifyShowFail({ missing = false } = {}) {
  if (missing) {
    verifyFailTitle.textContent = 'Falta el link';
    verifyFailNote.textContent = 'Abrí de nuevo el link del correo. Si ya lo usaste o pasaron más de 15 minutos, pedí otro.';
  }
  verifyStep.hidden = true;
  verifyFail.hidden = false;
  verifyFail.classList.add('in');
  verifyFailTitle.focus();
}

verifyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (verifyBusy) return;
  if (!verifyToken) {
    verifyShowFail({ missing: true });
    return;
  }
  verifyBusy = true;
  verifyErr.hidden = true;
  verifySubmit.setAttribute('aria-disabled', 'true');
  verifySubmit.classList.add('busy');
  verifySetLabel('Entrando…');
  let res = null;
  try {
    res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: new URLSearchParams({ token: verifyToken }),
    });
  } catch {
    res = null;
  }
  verifySubmit.classList.remove('busy');
  if (res && res.ok && res.redirected) {
    verifySubmit.classList.add('ok');
    verifySetLabel('Adentro ✓');
    setTimeout(() => window.location.replace(VERIFY_HOME), verifyReducedMotion.matches ? 0 : 400);
    return;
  }
  verifyBusy = false;
  verifySubmit.removeAttribute('aria-disabled');
  verifySetLabel('Entrar');
  if (res && res.status === 400) {
    verifyShowFail();
    return;
  }
  verifyShowError(res ? 'No se pudo entrar. Probá de nuevo en un rato.' : 'No hay conexión con la app. Revisá la red y probá de nuevo.');
});

verifyTokenInput.value = verifyToken;
if (verifyToken) {
  // Fuera de la dirección; el token sigue acá, en memoria, para el clic.
  window.history.replaceState(null, '', window.location.pathname);
} else {
  verifyShowFail({ missing: true });
}
