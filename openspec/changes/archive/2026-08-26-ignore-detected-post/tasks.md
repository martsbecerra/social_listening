# Tasks: ignore-detected-post

## Phase 1: Persistencia

- [x] 1.1 Migrar `ignored` + `ignored_at` en `src/db.js`. (REQ-IGNORE-02)
- [x] 1.2 Reemplazar `deletePost` por `ignorePost` (conserva `ignored_at`). (REQ-IGNORE-02)
- [x] 1.3 Filtrar `ignored = 0` en listados/conteos/refresh; no filtrar en `findExistingPostId`. (REQ-IGNORE-03, REQ-IGNORE-04)
- [x] 1.4 `applyMetricsRefresh` / `updatePostMetricsIfChanged` no-op si ignorado. (REQ-IGNORE-05)
- [x] 1.5 `MONITORING_DB_PATH` para tests contra tempfile.

## Phase 2: API + UI

- [x] 2.1 `POST /api/monitoring/posts/:id/ignore`; quitar `DELETE`. (REQ-IGNORE-07)
- [x] 2.2 Modal/copy/handlers de ignore en `instagram.html` + `monitoring.js`; refrescar destacados. (REQ-IGNORE-01)
- [x] 2.3 Titles de la cruz en `design/monitoreo.html` y `design/plataforma.html`.
- [x] 2.4 Nota en `README.md` sobre ignorados.

## Phase 3: Tests + verify

- [x] 3.1 `test/ignoreDetectedPost.test.js` cubre REQ-IGNORE-02..05. (script `npm test`)
- [x] 3.2 Correr tests y marcar esta lista.
