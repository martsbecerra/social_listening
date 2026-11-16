// ==========================================================================
// sesion.js
// --------------------------------------------------------------------------
// La sesión del lado del navegador (noviembre 2026), en el <head> de las
// páginas con sesión (instagram.html, x.html, dashboard.html), después de
// theme.js y antes que cualquier otro script:
//
// - El rol. Marca <html data-rol="lector|operador">. Lo que gasta o escribe
//   lleva la clase `solo-operador` y el CSS lo oculta salvo con
//   data-rol="operador" (también mientras no se sabe el rol); un control que
//   no se oculta sino que se deshabilita (el selector de tono) lleva
//   `solo-operador-ctl` y queda `disabled`. Para un operador las pantallas no
//   cambian. El rol se recuerda en localStorage (`sl.rol`) solo como pista
//   para pintar la primera vez sin parpadeo; quien decide es el servidor
//   (el gate responde 403 a un lector en todo lo que no sea GET).
// - El 401. Si cualquier pedido a /api/ responde 401 (la sesión venció, se
//   revocó o el correo salió de la allowlist), la página va al login.
// - X-SL-Auto. slAuto(init) suma el header `X-SL-Auto: 1` a un pedido
//   automático (la barra superior, el inicio cada minuto, el progreso): el
//   servidor lo valida igual pero no lo cuenta como actividad, así dejar la
//   pestaña abierta no mantiene viva la sesión.
// Expone window.slMe (promesa de { email, role } o null), window.slAuto,
// window.slEsOperador y el evento `sl:rol` en document.
// ==========================================================================
(function () {
  const ROL_KEY = 'sl.rol';
  const ROLES = ['lector', 'operador'];
  const root = document.documentElement;

  function aplicarRol(rol) {
    if (ROLES.includes(rol)) root.dataset.rol = rol;
    else delete root.dataset.rol;
    const operador = root.dataset.rol === 'operador';
    document.querySelectorAll('.solo-operador-ctl').forEach((el) => {
      el.disabled = !operador;
    });
  }

  // La pista guardada, antes de pintar.
  try {
    const guardado = localStorage.getItem(ROL_KEY);
    if (ROLES.includes(guardado)) aplicarRol(guardado);
  } catch {
    /* sin almacenamiento: se sabe con /api/auth/me */
  }

  // --- 401 → al login -----------------------------------------------------
  const fetchOriginal = window.fetch.bind(window);
  let yendoAlLogin = false;

  function esApiPropia(input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      return url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/public/');
    } catch {
      return false;
    }
  }

  function irAlLogin() {
    if (yendoAlLogin) return;
    yendoAlLogin = true;
    try {
      localStorage.removeItem(ROL_KEY);
    } catch {
      /* nada */
    }
    window.location.assign('/');
  }

  window.fetch = async function slFetch(input, init) {
    const res = await fetchOriginal(input, init);
    if (res.status === 401 && esApiPropia(input)) irAlLogin();
    return res;
  };

  // --- X-SL-Auto ----------------------------------------------------------
  window.slAuto = function slAuto(init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set('X-SL-Auto', '1');
    return { ...init, headers };
  };

  window.slEsOperador = function slEsOperador() {
    return root.dataset.rol === 'operador';
  };

  // --- El rol, del servidor -----------------------------------------------
  window.slMe = fetchOriginal('/api/auth/me', { credentials: 'same-origin' })
    .then(async (res) => {
      if (res.status === 401) {
        irAlLogin();
        return null;
      }
      if (!res.ok) return null;
      const me = await res.json();
      const rol = ROLES.includes(me.role) ? me.role : null;
      aplicarRol(rol);
      try {
        if (rol) localStorage.setItem(ROL_KEY, rol);
      } catch {
        /* nada */
      }
      document.dispatchEvent(new CustomEvent('sl:rol', { detail: rol }));
      return me;
    })
    .catch(() => null);

  // Los controles que se arman antes de saber el rol quedan bien al llegar
  // (aplicarRol recorre los que ya están); los que se arman después leen
  // slEsOperador().
  document.addEventListener('DOMContentLoaded', () => aplicarRol(root.dataset.rol));
})();
