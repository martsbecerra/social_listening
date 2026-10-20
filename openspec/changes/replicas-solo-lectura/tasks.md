# Tasks: replicas-solo-lectura

## Phase 0: SDD y verificación previa

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-REP-*)
- [ ] 0.2 Desde una máquina de la red: `github.com` responde y un `git clone` de un repo privado de prueba anda con un token (a mano, el dueño)
- [ ] 0.3 En una copia de la base principal: cuántos posteos tienen foto y cuánto pesa `data/media/` (a mano, el dueño)

## Phase 1: modo y git

- [x] 1.1 `src/appMode.js` (`APP_MODE`) y su test (REQ-REP-01)
- [x] 1.2 `src/replicaGit.js`: token por entorno, filtro de errores (REQ-REP-09)
- [x] 1.3 `src/appVersion.js`

## Phase 2: publicación en la principal

- [x] 2.1 `src/replicaPublish.js`: base sin `magic_links`, config, media en espejo, `snapshot.json` (REQ-REP-02)
- [x] 2.2 Commit único y force-push; fallo sin tirar (REQ-REP-03)
- [x] 2.3 `src/scheduler.js`: publicar al cerrar el ciclo; `src/db.js` exporta `DB_PATH`

## Phase 3: réplica

- [x] 3.1 `src/replicaGuard.js` (REQ-REP-04, REQ-REP-05)
- [x] 3.2 `src/replicaSync.js` y `scripts/replica-sync.js` (REQ-REP-06)
- [x] 3.3 `src/replicaPoller.js` (REQ-REP-07)
- [x] 3.4 `src/replicaRoutes.js` (`GET /api/app/mode`) (REQ-REP-08)
- [x] 3.5 `server.js` según `APP_MODE`

## Phase 4: frontend

- [x] 4.1 `main.js`: modo, franja, solapa por defecto; CSS de solo lectura (REQ-REP-08)
- [x] 4.2 Prueba en el navegador con una réplica de prueba (copia de la base, snapshot local, sin GitHub)

## Phase 5: instalador

- [x] 5.1 `installer/armar-instalador.ps1`, `installer/instalar.ps1`, `installer/iniciar-replica.bat`, `.env` de réplica
- [x] 5.2 Armado de prueba del zip e instalación en una carpeta temporal

## Phase 6: documentación

- [x] 6.1 `.env.example`, README, CLAUDE.md
- [x] 6.2 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`

## Phase 7: acciones de la copia

- [x] 7.1 `src/replicaPoller.js`: `checkForUpdate` sin salir; sin clon consulta `REPLICA_REPO_URL`
- [x] 7.2 `src/replicaToken.js`: probar el token con `git ls-remote` y guardarlo en el `.env`
- [x] 7.3 `src/replicaGuard.js`: `POST /api/replica/refresh` y `/api/replica/token` solo con `Origin` local
- [x] 7.4 `src/replicaRoutes.js`: `needsToken`, `bootId` y las dos rutas (responden y después salen con 75)
- [x] 7.5 Frontend: botón "Buscar datos nuevos", modal del token; el instalador ya no pide el token
- [x] 7.6 Prueba en el navegador con una réplica de prueba y el lanzador (repo de datos local)

## Phase 8: snapshot liviano y token que deja de servir

- [x] 8.1 `src/replicaPublish.js`: datos solo en `PUBLISHED_TABLES` y base en `monitoring.db.gz` (REQ-REP-02)
- [x] 8.2 `src/replicaSync.js`: descomprime `monitoring.db.gz`; acepta `monitoring.db` del formato anterior (REQ-REP-06)
- [x] 8.3 `src/replicaGit.js`: `machineCredentials: false` en la réplica, sin ventana de Git Credential Manager (REQ-REP-10)
- [x] 8.4 Sondeo `denied` y `tokenRejected()`, consulta al arrancar, `tokenRejected` en `/api/app/mode`, refresh 401 (REQ-REP-10)
- [x] 8.5 Frontend: el modal también con token rechazado; prueba en el navegador con un remoto que responde 401
