// ==========================================================================
// replicaRoutes.js — GET /api/app/mode.
// --------------------------------------------------------------------------
// Con esto el frontend (public/js/main.js) sabe si está en una réplica de
// solo lectura: esconde los controles que escriben y muestra de cuándo son
// los datos. En la principal va detrás del login como todo /api; en la
// réplica, detrás de src/replicaGuard.js.
//
// El snapshot aplicado (data/replica-snapshot.json, lo deja
// src/replicaSync.js) se lee en cada pedido: es chico y cambia con cada
// reinicio de la réplica. newerAppAvailable: la principal publicó con otro
// código que el de esta réplica (hay que correr el instalador nuevo); solo
// si las dos versiones se conocen.
// ==========================================================================

const fs = require('fs');

function readSnapshotInfo(infoPath) {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    return info && typeof info === 'object' ? info : {};
  } catch (err) {
    return {};
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ mode: 'principal'|'replica', infoPath: string, appVersion: string|null }} options
 */
function register(app, { mode, infoPath, appVersion }) {
  app.get('/api/app/mode', (req, res) => {
    if (mode !== 'replica') return res.json({ mode, readOnly: false });
    const info = readSnapshotInfo(infoPath);
    const snapshotAppVersion = info.appVersion || null;
    res.json({
      mode,
      readOnly: true,
      dataAsOf: info.publishedAt || null,
      runId: info.runId ?? null,
      appVersion: appVersion || null,
      snapshotAppVersion,
      newerAppAvailable: Boolean(appVersion && snapshotAppVersion && appVersion !== snapshotAppVersion),
    });
  });
}

module.exports = { register };
