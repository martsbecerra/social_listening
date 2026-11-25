// ==========================================================================
// asyncRoute.js
// --------------------------------------------------------------------------
// rutaAsync(handler) (rama rate-limit-y-salud): Express 4 no le pasa al
// manejador de errores el rechazo de un handler `async`; sin esto, una
// promesa rechazada en una ruta terminaba en unhandledRejection y el proceso
// se cerraba (installProcessHandlers, src/httpSecurity.js). Envuelto, el
// rechazo (o un throw) va a next(err): responde errorHandler con 500
// { error: 'Error interno.' } y la app sigue viva.
//
// Regla: TODA ruta async usa el envoltorio:
//   app.<método>(<ruta>, rutaAsync(async (req, res) => { … }));
// test/rutasAsync.test.js recorre server.js y src/ y falla con una que no.
// ==========================================================================

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: Function) => any} handler
 * @returns {import('express').RequestHandler}
 */
function rutaAsync(handler) {
  return function rutaEnvuelta(req, res, next) {
    Promise.resolve()
      .then(() => handler(req, res, next))
      // Un rechazo sin error (reject() a secas) también es un error: si no,
      // next() seguiría a la ruta siguiente como si nada.
      .catch((err) => next(err || new Error('Una ruta async se rechazó sin error.')));
  };
}

module.exports = { rutaAsync };
