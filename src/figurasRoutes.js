'use strict';

// ==========================================================================
// figurasRoutes.js — La lista de figuras públicas (fase F).
// --------------------------------------------------------------------------
//   GET    /api/figuras             la lista (las del equipo y las sugeridas)
//   POST   /api/figuras             { username, nombre, rol, alineacion, notas }
//   PATCH  /api/figuras/:username   cambia lo que venga; confirma una sugerida
//   DELETE /api/figuras/:username
//
// Detrás del gate de login, como todo /api/. La validación (roles, la
// alineación solo para roles políticos o de prensa) vive en src/figuras.js
// y la usa db.js al escribir; un dato mal puesto es 400 con el mensaje para
// la persona. Quién cargó cada figura (un correo) no sale de acá. Separada
// de server.js para probarla sin levantar la app.
// ==========================================================================

const db = require('./db');
const { ROLES, ALINEACIONES, ROLES_CON_ALINEACION } = require('./figuras');

/** Una figura como va al navegador: sin el correo de quien la cargó. */
function paraNavegador(figura) {
  if (!figura) return null;
  const { creadoPor, ...resto } = figura;
  return resto;
}

function responderError(res, err, contexto) {
  if (err && err.code === 'FIGURA_EXISTE') return res.status(409).json({ error: err.userMessage });
  if (err && err.userMessage) return res.status(400).json({ error: err.userMessage });
  console.error(`Error en ${contexto}:`, err);
  return res.status(500).json({ error: 'No se pudo guardar la figura.' });
}

function register(app) {
  app.get('/api/figuras', (req, res) => {
    try {
      return res.json({
        figuras: db.listFiguras().map(paraNavegador),
        roles: ROLES,
        alineaciones: ALINEACIONES,
        rolesConAlineacion: [...ROLES_CON_ALINEACION],
      });
    } catch (err) {
      console.error('Error en GET /api/figuras:', err);
      return res.status(500).json({ error: 'No se pudo leer la lista de figuras.' });
    }
  });

  app.post('/api/figuras', (req, res) => {
    try {
      const figura = db.createFigura(req.body || {}, { creadoPor: req.auth ? req.auth.email : null });
      return res.status(201).json({ figura: paraNavegador(figura) });
    } catch (err) {
      return responderError(res, err, 'POST /api/figuras');
    }
  });

  app.patch('/api/figuras/:username', (req, res) => {
    try {
      const figura = db.updateFigura(req.params.username, req.body || {}, { por: req.auth ? req.auth.email : null });
      if (!figura) return res.status(404).json({ error: 'Esa figura no está en la lista.' });
      return res.json({ figura: paraNavegador(figura) });
    } catch (err) {
      return responderError(res, err, 'PATCH /api/figuras');
    }
  });

  app.delete('/api/figuras/:username', (req, res) => {
    try {
      if (!db.deleteFigura(req.params.username)) return res.status(404).json({ error: 'Esa figura no está en la lista.' });
      return res.status(204).end();
    } catch (err) {
      console.error('Error en DELETE /api/figuras:', err);
      return res.status(500).json({ error: 'No se pudo borrar la figura.' });
    }
  });
}

module.exports = { register };
