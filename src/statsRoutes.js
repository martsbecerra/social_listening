'use strict';

// ==========================================================================
// statsRoutes.js — GET /api/monitoring/stats, la sección Estadísticas.
// --------------------------------------------------------------------------
// GET /api/monitoring/stats?plataforma=instagram&desde=AAAA-MM-DD&hasta=AAAA-MM-DD
// devuelve todos los bloques del período en una sola respuesta (los arma
// src/stats.js). Sin fechas: los últimos 30 días hasta hoy, en hora de
// Argentina. Va bajo /api/monitoring, así que tiene el mismo control de
// acceso que el resto (login y plataforma obligatoria, en server.js).
//
// Separada de server.js, como postImageRoutes.js, para probarla sin levantar
// la app. Lo que depende de la app llega por parámetro: las palabras clave y
// búsquedas de la plataforma (las frases de la nube de palabras) y si la
// plataforma tiene benchmark (sin él no hay alcance).
// ==========================================================================

const stats = require('./stats');

const STATS_ROUTE = '/api/monitoring/stats';

/**
 * @param {import('express').Express} app
 * @param {{ configFor: (plataforma: string) => {keywords?: string[], searches?: string[]},
 *   conAlcance: (plataforma: string) => boolean }} deps
 */
function register(app, { configFor, conAlcance }) {
  app.get(STATS_ROUTE, (req, res) => {
    const plataforma = String(req.query.plataforma || '').trim();
    try {
      if (!plataforma) {
        return res.status(400).json({ error: 'Falta el parámetro plataforma (instagram | x).' });
      }
      const config = configFor(plataforma) || {};
      const frases = [...(config.keywords || []), ...(config.searches || [])].filter((f) => typeof f === 'string');
      res.json(
        stats.armarEstadisticas({
          plataforma,
          desde: req.query.desde,
          hasta: req.query.hasta,
          frases,
          conAlcance: Boolean(conAlcance(plataforma)),
        })
      );
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.userMessage });
      console.error(`Error en ${STATS_ROUTE}:`, err);
      res.status(500).json({ error: 'No se pudieron armar las estadísticas. Revisá la consola del servidor.' });
    }
  });
}

module.exports = { register, STATS_ROUTE };
