// ==========================================================================
// replicaRoutes.js — GET /api/app/mode y las dos acciones de la réplica.
// --------------------------------------------------------------------------
// Con /api/app/mode el frontend (public/js/main.js) sabe si está en una
// réplica de solo lectura: esconde los controles que escriben y muestra de
// cuándo son los datos. En la principal va detrás del login como todo /api;
// en la réplica, detrás de src/replicaGuard.js.
//
// El snapshot aplicado (data/replica-snapshot.json, lo deja
// src/replicaSync.js) se lee en cada pedido: es chico y cambia con cada
// reinicio de la réplica. newerAppAvailable: la principal publicó con otro
// código que el de esta réplica (hay que correr el instalador nuevo); solo
// si las dos versiones se conocen. needsToken: falta DATA_REPO_TOKEN, el
// frontend muestra el modal para pegarlo. tokenRejected: hay token pero el
// repo ya no lo acepta (src/replicaPoller.js); el frontend muestra el mismo
// modal para pegar uno nuevo. bootId cambia con cada arranque:
// después de pedir un reinicio, la página espera a que cambie (sincronizar y
// arrancar puede tardar menos que su intervalo de consulta).
//
// Solo en la réplica (el guard las deja pasar únicamente desde la página de
// la app en esta máquina):
//   POST /api/replica/refresh  "Buscar datos nuevos": si hay, responde 202 y
//                              reinicia (código 75: el lanzador sincroniza).
//   POST /api/replica/token    { token }: lo prueba contra el repo de datos,
//                              lo guarda en el .env y reinicia. Nunca lo
//                              devuelve.
// ==========================================================================

const fs = require('fs');

const MAX_TOKEN_LENGTH = 500;

function readSnapshotInfo(infoPath) {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    return info && typeof info === 'object' ? info : {};
  } catch (err) {
    return {};
  }
}

const TOKEN_ERRORS = {
  acceso: [400, 'Ese token no puede leer el repo de datos. Revisá que sea el de solo lectura que te pasaron y que no esté vencido.'],
  red: [502, 'No se pudo probar el token: no hay conexión con GitHub. Revisá la red y volvé a intentar.'],
  'sin-repo': [409, 'Esta copia no sabe cuál es el repo de datos (falta REPLICA_REPO_URL): hay que reinstalarla.'],
};

/** Responde y, recién cuando la respuesta salió, reinicia. */
function respondThenRestart(res, status, body, restart) {
  res.on('finish', () => restart());
  res.status(status).json(body);
}

/**
 * @param {import('express').Express} app
 * @param {{ mode: 'principal'|'replica', infoPath: string, appVersion: string|null,
 *   replica?: { hasToken: () => boolean, tokenRejected: () => boolean,
 *     checkForUpdate: () => Promise<'same'|'new'|'error'|'denied'>,
 *     verifyToken: (token: string) => Promise<{ ok: boolean, reason?: string }>,
 *     saveToken: (token: string) => void, restart: () => void } }} options
 */
function register(app, { mode, infoPath, appVersion, replica, bootId = null }) {
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
      needsToken: !replica.hasToken(),
      tokenRejected: replica.hasToken() && replica.tokenRejected(),
      bootId,
    });
  });

  if (mode !== 'replica') return;

  app.post('/api/replica/refresh', async (req, res) => {
    if (!replica.hasToken()) {
      return res.status(409).json({ error: 'Falta el token de lectura del repo de datos.' });
    }
    const result = await replica.checkForUpdate();
    if (result === 'new') return respondThenRestart(res, 202, { status: 'actualizando' }, replica.restart);
    if (result === 'same') return res.json({ status: 'al-dia' });
    if (result === 'denied') {
      return res.status(401).json({
        error: 'El token de lectura guardado ya no sirve (venció o lo revocaron). Pegá uno nuevo.',
        tokenRejected: true,
      });
    }
    return res.status(502).json({ error: 'No se pudo consultar si hay datos nuevos (sin conexión con GitHub o sin acceso al repo de datos).' });
  });

  app.post('/api/replica/token', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || /\s/.test(token) || token.length > MAX_TOKEN_LENGTH) {
      return res.status(400).json({ error: 'Pegá el token de lectura del repo de datos (una sola línea, sin espacios).' });
    }
    const check = await replica.verifyToken(token);
    if (!check.ok) {
      const [status, error] = TOKEN_ERRORS[check.reason] || TOKEN_ERRORS.acceso;
      return res.status(status).json({ error });
    }
    try {
      replica.saveToken(token);
    } catch (err) {
      console.error(`[réplica] no se pudo guardar el token en el .env: ${err.message}`);
      return res.status(500).json({ error: 'No se pudo guardar el token en esta máquina. Revisá los permisos de la carpeta de la app.' });
    }
    return respondThenRestart(res, 200, { status: 'guardado' }, replica.restart);
  });
}

module.exports = { register };
