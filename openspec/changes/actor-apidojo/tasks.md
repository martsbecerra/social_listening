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

## Phase 4: correcciones del ciclo real (2026-09-18, US$ 0,1945)

- [x] 4.1 `followers` solo cuando el owner del item es la cuenta consultada (posteos en colaboración)
- [x] 4.2 `usd_real` conciliado después (`fetchRunCost`, `reconcileRealCosts`, `--conciliar`), no al terminar el run
- [x] 4.3 Verificado en el ciclo real: el refresco matchea por id (16 de 21 posteos calientes; los 5 restantes quedaron fuera de los 15 más nuevos o de la ventana), `until` convive con posteos fijados, la caché de seguidores se actualiza en detección y refresco
- [x] 4.4 Resultados de búsqueda sin caption ni contadores: detalle del mismo reel por los dos actores (US$ 0,0073), los dos traen el texto; el dueño eligió el actor oficial (0,0023 por posteo, varias URLs por run)

## Phase 5: detalle de los resultados de búsqueda

- [x] 5.1 `search_seen` en `src/db.js` (`getSearchSeen`, `isSearchSeen`, `markSearchSeen`, `purgeSearchSeen`)
- [x] 5.2 `fetchPostDetails(urls)` en `instagramApify.js`, expuesto por la fachada con cualquier `IG_ACTOR`; contrato en `platforms/index.js`
- [x] 5.3 `enrichSearchResults` en `src/monitor.js`: un run por ciclo en la fase `busqueda`, `SEARCH_ENRICH_LIMIT` (20, 0 apaga), vistos y purga a 30 días, `porPlataforma[id].searchEnrichment`
- [x] 5.4 `test/searchEnrichment.test.js` con los fixtures reales de la búsqueda y del detalle; suite en verde con los dos `IG_ACTOR`
- [x] 5.5 `.env.example`, README, `CLAUDE.md`, `config/README.md`, REQ-IGA-09
- [x] 5.6 Verificado contra Apify real (2026-09-18, US$ 0,0046): un run con 2 URLs devuelve un item por URL (`resultsLimit` es por URL), en otro orden que el pedido, con los ids de la búsqueda; fixture `test/fixtures/apify/post-details-2urls.json`

## Pendiente (fuera del código)

- [ ] Merge a `main` cuando el dueño lo confirme
