# Archive report: ignore-detected-post

## SDD Cycle Complete

Fecha: 2026-08-26

## Goal

La cruz de cada fila de "Monitoreo en vivo" ignora el posteo (soft-ignore en SQLite) en vez de borrarlo, para que no vuelva a cargarse ni a re-notificarse.

## Spec coverage

| Req | Status | Evidence |
|-----|--------|----------|
| REQ-IGNORE-01 Confirmación / copy ignorar | Done | `public/instagram.html` modal; `public/js/monitoring.js` `confirmIgnore` |
| REQ-IGNORE-02 Persistencia, no DELETE | Done | `ignorePost` UPDATE; tests de fila + `ignored_at` |
| REQ-IGNORE-03 Invisible en producto | Done | listados/conteos `ignored = 0`; test de listado vacío |
| REQ-IGNORE-04 Sigue conocido | Done | `findExistingPostId` sin filtro; test de no re-insert |
| REQ-IGNORE-05 No refresh de métricas | Done | `applyMetricsRefresh` null; test likes intactos |
| REQ-IGNORE-06 Chips intactos | Done | `removeAccount` / `removeKeyword` sin cambios |
| REQ-IGNORE-07 POST `/ignore`, sin DELETE | Done | `server.js` |

## Verification

```
npm test
→ 5/5 pass (test/ignoreDetectedPost.test.js)
```

UI en browser: no ejercida acá (hace falta sesión). Tras reiniciar `npm start`, recargar Instagram → Monitoreo en vivo → cruz de una fila → confirmar. El posteo sale de la tabla; al recargar no vuelve; "Actualizar ahora" no lo re-detecta.

## Follow-ups

- UI para listar / deshacer ignorados (`ignored_at` ya está).
- Reiniciar el server local: la migración y el POST nuevo no aplican hasta que recargue `src/db.js` / `server.js`.

## Relevant files

- `src/db.js` — columnas, `ignorePost`, filtros
- `server.js` — `POST /api/monitoring/posts/:id/ignore`
- `public/js/monitoring.js`, `public/instagram.html`
- `test/ignoreDetectedPost.test.js`
