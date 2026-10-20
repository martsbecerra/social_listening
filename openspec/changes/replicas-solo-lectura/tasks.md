# Tasks: replicas-solo-lectura

## Phase 0: SDD y verificación previa

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-REP-*)
- [ ] 0.2 Desde una máquina de la red: `github.com` responde y un `git clone` de un repo privado de prueba anda con un token (a mano, el dueño)
- [ ] 0.3 En una copia de la base principal: cuántos posteos tienen foto y cuánto pesa `data/media/` (a mano, el dueño)

## Phase 1: modo y git

- [ ] 1.1 `src/appMode.js` (`APP_MODE`) y su test (REQ-REP-01)
- [ ] 1.2 `src/replicaGit.js`: token por entorno, filtro de errores (REQ-REP-09)
- [ ] 1.3 `src/appVersion.js`

## Phase 2: publicación en la principal

- [ ] 2.1 `src/replicaPublish.js`: base sin `magic_links`, config, media en espejo, `snapshot.json` (REQ-REP-02)
- [ ] 2.2 Commit único y force-push; fallo sin tirar (REQ-REP-03)
- [ ] 2.3 `src/scheduler.js`: publicar al cerrar el ciclo; `src/db.js` exporta `DB_PATH`

## Phase 3: réplica

- [ ] 3.1 `src/replicaGuard.js` (REQ-REP-04, REQ-REP-05)
- [ ] 3.2 `src/replicaSync.js` y `scripts/replica-sync.js` (REQ-REP-06)
- [ ] 3.3 `src/replicaPoller.js` (REQ-REP-07)
- [ ] 3.4 `src/replicaRoutes.js` (`GET /api/app/mode`) (REQ-REP-08)
- [ ] 3.5 `server.js` según `APP_MODE`

## Phase 4: frontend

- [ ] 4.1 `main.js`: modo, franja, solapa por defecto; CSS de solo lectura (REQ-REP-08)
- [ ] 4.2 Prueba en el navegador con una réplica de prueba (copia de la base, snapshot local, sin GitHub)

## Phase 5: instalador

- [ ] 5.1 `installer/armar-instalador.ps1`, `installer/instalar.ps1`, `installer/iniciar-replica.bat`, `.env` de réplica
- [ ] 5.2 Armado de prueba del zip e instalación en una carpeta temporal

## Phase 6: documentación

- [ ] 6.1 `.env.example`, README, CLAUDE.md
- [ ] 6.2 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`
