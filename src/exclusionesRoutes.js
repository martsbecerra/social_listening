// ==========================================================================
// exclusionesRoutes.js
// --------------------------------------------------------------------------
// Cuentas excluidas (noviembre 2026, rama clasificacion-foto-y-exclusiones):
// sus publicaciones se descartan antes de llegar al modelo, con el motivo
// anotado (ver cuentas_excluidas en src/db.js y el ciclo en src/monitor.js).
//
//   GET    /api/monitoring/excluded-accounts?plataforma=        la lista (un lector la ve)
//   POST   /api/monitoring/excluded-accounts { cuenta, motivo, plataforma }
//   DELETE /api/monitoring/excluded-accounts/:cuenta?plataforma=
//
// POST y DELETE son solo de operador: lo exige la regla general del gate
// (src/auth/gate.js) para todo lo que no es GET bajo /api. La plataforma la
// valida el middleware de /api/monitoring de server.js. Quién agregó una
// cuenta (`creado_por`, un correo) queda en la base y en el log, nunca en la
// respuesta. Agregar una cuenta pasa a ignorado lo ya guardado de ella;
// sacarla no lo des-ignora ni vuelve a evaluar lo excluido.
// ==========================================================================

// Por el objeto del módulo: los tests pueden stubear la base.
const db = require('./db');

const ROUTE = '/api/monitoring/excluded-accounts';
// Un usuario de Instagram (hasta 30) o de X (hasta 15): letras, números,
// punto y guion bajo.
const CUENTA_RE = /^[a-z0-9._]{1,30}$/;
const MAX_MOTIVO = 200;

function plataformaDe(req) {
  return String((req.query && req.query.plataforma) || (req.body && req.body.plataforma) || '').trim();
}

function register(app) {
  app.get(ROUTE, (req, res) => {
    res.json({ cuentas: db.listCuentasExcluidas(plataformaDe(req)) });
  });

  app.post('/api/monitoring/excluded-accounts', (req, res) => {
    const plataforma = plataformaDe(req);
    const cuenta = db.normalizarCuentaExcluida(req.body && req.body.cuenta);
    const motivo = typeof (req.body && req.body.motivo) === 'string' ? req.body.motivo.trim() : '';
    if (!CUENTA_RE.test(cuenta)) {
      return res.status(400).json({ error: 'Escribí el usuario de la cuenta (letras, números, punto o guion bajo).' });
    }
    if (!motivo) return res.status(400).json({ error: 'Contá por qué se excluye la cuenta.' });
    if (motivo.length > MAX_MOTIVO) return res.status(400).json({ error: `El motivo puede tener hasta ${MAX_MOTIVO} caracteres.` });
    try {
      const r = db.addCuentaExcluida({ plataforma, cuenta, motivo, creadoPor: req.auth ? req.auth.email : null });
      console.log(
        `[exclusiones] @${r.cuenta} excluida (${plataforma})${req.auth ? ` por ${req.auth.email}` : ''}: ${r.motivo} · ` +
          `${r.ignorados} publicación/es guardada/s pasaron a ignoradas`
      );
      return res.status(201).json(r);
    } catch (err) {
      if (err && err.code === 'CUENTA_EXCLUIDA_REPETIDA') {
        return res.status(409).json({ error: `La cuenta @${cuenta} ya está excluida.` });
      }
      throw err;
    }
  });

  app.delete('/api/monitoring/excluded-accounts/:cuenta', (req, res) => {
    const plataforma = plataformaDe(req);
    const cuenta = db.normalizarCuentaExcluida(req.params.cuenta);
    if (!db.removeCuentaExcluida(plataforma, cuenta)) {
      return res.status(404).json({ error: `La cuenta @${cuenta} no está en la lista.` });
    }
    console.log(`[exclusiones] @${cuenta} sacada de la lista (${plataforma})${req.auth ? ` por ${req.auth.email}` : ''}`);
    return res.json({ ok: true, cuenta });
  });
}

module.exports = { register, ROUTE, CUENTA_RE, MAX_MOTIVO };
