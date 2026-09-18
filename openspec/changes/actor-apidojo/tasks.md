# Tasks: actor-apidojo

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-IGA-*)

## Phase 1: proveedor apidojo detrás del adapter

- [x] 1.1 `igActor.js` (interruptor `IG_ACTOR`, validado en `server.js`) y fachada `instagram.js` (REQ-IGA-01)
- [x] 1.2 `instagramApify.js`: el proveedor anterior, movido sin cambios (REQ-IGA-01)
- [x] 1.3 `instagramApidojo.js`: cuentas, hashtags, benchmark, validación con `maxItems 1`, normalización, `until` + ventana propia, `fetchAccountFollowers` sin consulta (REQ-IGA-02, REQ-IGA-03, REQ-IGA-04)
- [x] 1.4 Topes por fuente en `monitor.js` con respaldo de `MONITOR_RESULTS_LIMIT` (REQ-IGA-05)
- [x] 1.5 Seguidores desde los posteos: `rememberFollowers` en detección, benchmark y refresco (REQ-IGA-06)
- [x] 1.6 Fixtures reales (corrida autorizada, US$ 0,045) y tests del proveedor y del interruptor

## Phase 2: búsqueda por palabra clave

- [x] 2.1 Lista `searches` en el config, `addSearch` / `removeSearch`, `POST`/`DELETE /api/monitoring/searches` (REQ-IGA-07)
- [x] 2.2 Una llamada por término en la fase `busqueda`; `sourceType 'search'`, relevancia y dedupe (REQ-IGA-07)
- [x] 2.3 Tercera caja en `public/instagram.html` + `monitoring.js` (chips, "Ver todas", modal)
- [x] 2.4 Tests del pipeline con fuente `search`; aviso e ignorar con `IG_ACTOR=apify`

## Phase 3: costos y documentación

- [x] 3.1 `apify_calls`: `actor`, `query_type`, `usd_real`, `apify_run_id` (ALTER TABLE si faltan) (REQ-IGA-08)
- [x] 3.2 Costo estimado por actor (`usdForCall`), flujo asincrónico con costo real (`APIFY_REAL_COST`) (REQ-IGA-08)
- [x] 3.3 Reportes por actor (`npm run costo`, `GET /api/monitoring/costs`), línea `[costo]` con `busqueda`
- [x] 3.4 `.env.example`, README (costo, fuentes, decisión "Septiembre 2026"), `CLAUDE.md`, `config/README.md`

## Pendiente (fuera del código)

- [ ] Ciclo completo real con apidojo (autorización del dueño): verificar `until` con fijados, resultados de búsqueda con caption, `usd_real` contra el panel de Apify
- [ ] Merge a `main` cuando el dueño lo confirme
