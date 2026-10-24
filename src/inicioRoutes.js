'use strict';

// ==========================================================================
// inicioRoutes.js — GET /api/inicio, las tarjetas del inicio (dashboard.html).
// --------------------------------------------------------------------------
// Con sesión, como todo /api/. Una entrada por red registrada:
//   - enCron: si el ciclo automático la corre (MONITOR_PLATFORMS): "escuchando"
//     o "en pausa" (X, hoy). La próxima corrida es la del cron, solo para las
//     redes que corre.
//   - hoy y sieteDias: salen de stats.armarEstadisticas para los últimos 7
//     días (hoy incluido), así los números son los mismos de Estadísticas
//     ("Hoy" = publicadas desde las 00:00 de Argentina, como el Monitoreo;
//     sin tono = neutral; "se despegó" = top.level 'alto', solo con
//     benchmark).
//   - lastRunAt / lastRun: la última corrida terminada (src/lastRun.js, el
//     mismo resumen del Pipeline).
//   - corridasHoy: las corridas que arrancaron hoy (hora de Argentina), con
//     su estado real: terminada, cortada por cuota o en curso.
// Lo que depende de la app (registro de redes, scheduler) llega por
// parámetro, para probarla sin levantar server.js.
// ==========================================================================

const db = require('./db');
const stats = require('./stats');
const { buildLastRun } = require('./lastRun');

const INICIO_ROUTE = '/api/inicio';
const DIAS = 7;

function estadoDe(run) {
  if (!run.finishedAt) return 'en curso';
  return run.quotaExceeded ? 'cortada' : 'ok';
}

/**
 * @param {object} deps
 * @param {() => string[]} deps.listPlatformIds
 * @param {(id: string) => { capabilities?: { benchmark?: boolean } }} deps.getPlatform
 * @param {() => string[]} deps.cronPlatforms las redes del ciclo automático
 * @param {() => Date} deps.nextRunAt la próxima corrida del cron
 * @param {() => number[]} deps.runHours
 * @param {number} [deps.ahora] para los tests
 */
function armarInicio({ listPlatformIds, getPlatform, cronPlatforms, nextRunAt, runHours, ahora = Date.now() }) {
  const hoy = stats.fechaArgentina(ahora);
  const desdeHoy = new Date(stats.inicioDelDia(hoy)).toISOString();
  const hastaHoy = new Date(stats.inicioDelDia(stats.sumarDias(hoy, 1))).toISOString();
  const enCron = new Set(cronPlatforms());
  const proxima = nextRunAt().toISOString();
  const redes = listPlatformIds().map((id) => {
    const capabilities = (getPlatform(id) || {}).capabilities || {};
    const conAlcance = Boolean(capabilities.benchmark);
    const s = stats.armarEstadisticas({ plataforma: id, desde: stats.sumarDias(hoy, -(DIAS - 1)), hasta: hoy, conAlcance, ahora });
    const delDia = s.porDia.find((d) => d.fecha === hoy);
    return {
      id,
      enCron: enCron.has(id),
      nextRunAt: enCron.has(id) ? proxima : null,
      hoy: delDia ? delDia.total : 0,
      sieteDias: {
        publicaciones: s.resumen.relevantes,
        seDespegaron: conAlcance ? s.resumen.seDespegaron : null,
        positivoPct: s.resumen.positivoPct,
        negativoPct: s.resumen.negativoPct,
        porDia: s.porDia.map((d) => ({ fecha: d.fecha, total: d.total })),
      },
      lastRunAt: db.getLastFinishedRunAt(id),
      lastRun: buildLastRun(id, { hasBenchmark: conAlcance }),
      corridasHoy: db.listRunsBetween({ plataforma: id, desdeIso: desdeHoy, hastaIso: hastaHoy }).map((run) => ({
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        trigger: run.trigger,
        nuevas: run.newCandidates,
        guardadas: run.newPosts,
        estado: estadoDe(run),
      })),
    };
  });
  return { generadoEn: new Date(ahora).toISOString(), hoy, runHours: runHours(), redes };
}

/**
 * @param {import('express').Express} app
 * @param {Parameters<typeof armarInicio>[0]} deps
 */
function register(app, deps) {
  app.get(INICIO_ROUTE, (req, res) => {
    try {
      res.json(armarInicio(deps));
    } catch (err) {
      console.error(`Error en ${INICIO_ROUTE}:`, err);
      res.status(500).json({ error: 'No se pudo armar el inicio. Revisá la consola del servidor.' });
    }
  });
}

module.exports = { register, armarInicio, INICIO_ROUTE };
