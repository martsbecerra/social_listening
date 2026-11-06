// ==========================================================================
// platform.js
// --------------------------------------------------------------------------
// La plataforma de la página (instagram.html, x.html) para monitoring.js y
// topbar.js: sale del data-platform del <body>. Antes era un <script> en
// línea, y la CSP (script-src 'self', ver src/httpSecurity.js) no deja
// correr ninguno. Va justo antes de monitoring.js.
// ==========================================================================
(function () {
  const plataforma = document.body && document.body.dataset.platform;
  if (plataforma === 'instagram' || plataforma === 'x') window.SL_PLATFORM = plataforma;
})();
