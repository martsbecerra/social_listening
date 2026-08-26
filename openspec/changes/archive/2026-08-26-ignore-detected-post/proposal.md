# Proposal: ignore-detected-post

## Intent

La cruz al final de cada fila de "Monitoreo en vivo" deja de **borrar** el posteo detectado. Pasa a **ignorarlo**: la fila queda en SQLite con estado ignorado, desaparece de la UI y el monitor la sigue tratando como ya vista, para que no vuelva a cargarse, reclasificarse ni re-notificarse.

## Scope

### In Scope

- Soft-ignore de un posteo detectado desde la cruz de la fila (con confirmación)
- Persistencia `ignored` + `ignored_at` en `detected_posts`
- Ocultar ignorados en tabla, destacados, mails pendientes, backfill de clasificación, conteo del dashboard y refresco de métricas
- Seguir reconociendo el posteo por id/URL (índice único intacto)
- Copy de UI: "ignorar", no "borrar"
- Tests de la semántica en SQLite

### Out of Scope

- Cruz de los chips de cuentas / keywords (sigue siendo "quitar" de la config)
- UI para listar o deshacer ignorados
- Borrado físico (hard delete)
- Ignorar una cuenta entera

## Capabilities

### New Capabilities

- `ignore-detected-post`: marcar un posteo detectado como ignorado sin sacarlo de la base

### Modified Capabilities

- Listado y conteo de `detected_posts` (solo no ignorados)
- Dedupe del ciclo de monitoreo (un ignorado sigue siendo conocido)
- Endpoint de la cruz: deja de ser `DELETE` destructivo

## Approach

1. Migración aditiva en `src/db.js` (mismo patrón `ALTER TABLE` que `title`/`sentiment`).
2. `ignorePost(id)` en vez de `deletePost(id)`.
3. `POST /api/monitoring/posts/:id/ignore`; se retira el `DELETE`.
4. Filtro `ignored = 0` en lecturas de producto; `findExistingPostId` / unique de URL **no** filtran.
5. UI: copy + modal + sacar la fila de Tabulator (y de "Se despegaron").

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/db.js` | Modified | Columnas, `ignorePost`, filtros de listados |
| `server.js` | Modified | `POST .../ignore`; se elimina `DELETE` |
| `public/js/monitoring.js` | Modified | Confirmación e ignore en vez de borrar |
| `public/instagram.html` | Modified | Copy del modal |
| `design/monitoreo.html`, `design/plataforma.html` | Modified | Title del botón de referencia |
| `test/ignoreDetectedPost.test.js` | New | Contrato de persistencia y visibilidad |
| `README.md` | Modified | `detected_posts` también sirve para no re-detectar ignorados |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Un ignorado sigue gastando Apify en refresh de métricas | Med | `applyMetricsRefresh` no-op si `ignored`; listados de refresh excluyen ignorados |
| Mail de alerta sale igual si se ignora antes del notify | Low | `listUnnotified` filtra `ignored = 0` |
| Re-insert por URL si se filtrara el unique | Low | La fila se queda; el índice único de URL no cambia |
| Tests pisan `data/monitoring.db` | Low | `MONITORING_DB_PATH` a un tempfile |

## Rollback Plan

Revertir el cambio de código. Las columnas `ignored` / `ignored_at` pueden quedar (aditivas, default 0). No hay hard delete que recuperar.

## Dependencies

Ninguna nueva.

## Success Criteria

- [ ] Ignorar un posteo lo saca de la tabla y lo deja en DB
- [ ] La misma URL no reaparece como detección nueva ni dispara mail
- [ ] Los chips de cuentas/keywords no cambian
- [ ] `node --test test/ignoreDetectedPost.test.js` pasa
