// ==========================================================================
// healthRoutes.js
// --------------------------------------------------------------------------
// GET /health (rama rate-limit-y-salud, OWASP ASVS V16): el chequeo que usa
// Railway para saber si la app está viva. Público y sin datos: solo
// { status, db, uptime }. 200 si un SELECT 1 a la base anda; 503 si no.
//
// server.js la registra antes que todo lo demás (después de los headers de
// seguridad): sin sesión, sin límite de pedidos y sin leer el cuerpo. El
// gate igual la dejaría pasar (no es /api ni una página). Test:
// test/health.test.js.
// ==========================================================================

// Por el objeto del módulo (no desarmado): el test stubea db.ping.
const db = require('./db');

const HEALTH_ROUTE = '/health';
// Una línea de log por minuto como mucho mientras la base no responde:
// Railway pregunta seguido.
const AVISO_CADA_MS = 60 * 1000;

/**
 * @param {import('express').Express} app
 * @param {{ uptime?: () => number }} [deps] segundos desde que arrancó el proceso.
 */
function register(app, { uptime = () => process.uptime() } = {}) {
  let ultimoAviso = 0;
  app.get(HEALTH_ROUTE, (req, res) => {
    let dbOk = false;
    try {
      dbOk = db.ping() === true;
    } catch (err) {
      if (Date.now() - ultimoAviso >= AVISO_CADA_MS) {
        ultimoAviso = Date.now();
        console.error(`[health] la base no responde: ${err.code || err.message}`);
      }
    }
    res.set('Cache-Control', 'no-store');
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'error',
      db: dbOk ? 'ok' : 'error',
      uptime: Math.floor(uptime()),
    });
  });
}

module.exports = { register, HEALTH_ROUTE };
