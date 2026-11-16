// ==========================================================================
// loginDestino.js
// --------------------------------------------------------------------------
// Adónde va el login (public/js/login.js) cuando ya hay sesión (noviembre
// 2026). La cookie es sameSite strict: un link a /instagram.html#analisis-57
// abierto desde Gmail o WhatsApp llega sin ella, el gate lo manda a
// /?volver=%2Finstagram.html y el login, al ver la sesión, vuelve ahí.
//
// Solo caminos internos: `volver` tiene que ser, tal cual, una de las
// páginas de LOGIN_VOLVER (la misma lista que PAGINAS_VOLVER en
// src/auth/gate.js; test/loginDestino.test.js las compara), y el # solo
// letras, números, "-" y "_" (los de la app: #tab-…, #analisis-57,
// #publicacion-…, #fuentes-…). Ante cualquier otra cosa (https://otro.com,
// //otro.com, /\otro.com, javascript:, dos `volver`, un # raro) va al inicio.
//
// Sin dependencias ni DOM: en el navegador deja loginDestino y LOGIN_VOLVER
// en window; en Node (los tests) los exporta.
// ==========================================================================
(function (raiz) {
  const LOGIN_INICIO = '/dashboard.html';
  const LOGIN_VOLVER = Object.freeze(['/dashboard.html', '/instagram.html', '/x.html']);
  const LOGIN_HASH_RE = /^#[A-Za-z0-9_-]{1,100}$/;

  /**
   * @param {string} search location.search ("?volver=%2Fx.html")
   * @param {string} hash location.hash ("#tab-analysis" o "")
   * @returns {string} un camino de la app, siempre empezando con una de
   *   LOGIN_VOLVER
   */
  function loginDestino(search, hash) {
    let volver;
    try {
      volver = new URLSearchParams(String(search || '')).getAll('volver');
    } catch {
      return LOGIN_INICIO;
    }
    if (volver.length !== 1 || !LOGIN_VOLVER.includes(volver[0])) return LOGIN_INICIO;
    const fragmento = String(hash || '');
    if (!fragmento) return volver[0];
    return LOGIN_HASH_RE.test(fragmento) ? volver[0] + fragmento : LOGIN_INICIO;
  }

  const api = { LOGIN_INICIO, LOGIN_VOLVER, loginDestino };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(raiz, api);
})(typeof window !== 'undefined' ? window : globalThis);
