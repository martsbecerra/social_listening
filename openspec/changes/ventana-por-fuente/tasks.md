# Tasks: ventana-por-fuente

Un commit por fase. La suite se corre en modo liviano y con los dos actores
(`IG_ACTOR=apidojo` y `IG_ACTOR=apify`). Ningún test llama a Apify ni a un
modelo. La fase 13 es el paso 14 del plan aprobado: el 13 (importar lo
recuperado de las corridas cortadas) quedó afuera por decisión del dueño.

## Phase 1: SDD

- [x] 1.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-VPF-*)

## Phase 2: descartados anotados con su búsqueda

- [x] 2.1 `search_seen`: columnas `posted_at`, `motivo`, `llm_usd`, `run_id`, `terminos`; `markSearchSeen` junta términos y no pisa con un dato ausente; `addSearchSeenTerms` (REQ-VPF-01)
- [x] 2.2 `classifier.clasificarPosteo(caption, { onUsage })`
- [x] 2.3 `monitor.guardarEvaluado`; el ciclo no vuelve a evaluar lo ya anotado y suma los términos (REQ-VPF-01, REQ-VPF-02)
- [x] 2.4 `countDiscardedSearchesForStats` por fecha de publicación
- [x] 2.5 Tests: `searchSeenPorTermino.test.js`, `searchSeenMigracion.test.js`; `searchEnrichment.test.js` y `clasificarPosteo.test.js` adaptados

## Phase 3: costo medido y `apify_calls` con estado

- [x] 3.1 `apifyCost.js`: búsqueda sin posteos incluidos; `maxUsdForSearch`; `describeInput` con `maxItems` y `until` (REQ-VPF-03)
- [x] 3.2 `apify_calls`: columnas `estado`, `max_items`, `until`; `openApifyCall` / `closeApifyCall`; conciliación de filas con run conocido que no terminaron bien
- [x] 3.3 `server.js`: línea de arranque con las tarifas de apidojo en uso
- [x] 3.4 Tests: `apifyCosts.test.js`

## Phase 4: el id del run nunca se pierde

- [x] 4.1 `apify.js`: arranque sin espera, fila abierta al volver el run, `onRunStarted`, plazo propio, reintentos del seguimiento, `TIMEOUT` con `runPending`, parciales, dataset con reintento (REQ-VPF-04)
- [x] 4.2 `fetchRun`, `fetchDatasetItems`
- [x] 4.3 Tests: `apifyCorridaCortada.test.js`; `apifyCosts.test.js` adaptado

## Phase 5: registro por fuente y estado de la corrida

- [x] 5.1 Tabla `monitoring_run_sources`, `monitoring_runs.error_code`, completado único de las corridas anteriores (REQ-VPF-05)
- [x] 5.2 `src/runStatus.js` (REQ-VPF-06)
- [x] 5.3 `monitor.js`: cada fuente abre y cierra su fila; filas `plataforma` y `detalle`
- [x] 5.4 `scheduler.js`: cierre con estado y línea `[ciclo] fin` con lo que falló
- [x] 5.5 `lastRun.js`, `inicioRoutes.js`, `server.js`: estado y fuentes fallidas en las respuestas, sin texto crudo
- [x] 5.6 Tests: `estadoCorrida.test.js`, `fuentesPorCorrida.test.js`, `fuentesPorCorridaMigracion.test.js`; los que miran el cierre del ciclo, adaptados

## Phase 6: búsquedas que esperan y se levantan después

- [ ] 6.1 `instagramApidojo.scrapeSearch` por el asincrónico con vencimiento compartido; `recoverSearchRun`; fachada (REQ-VPF-07)
- [ ] 6.2 `monitor.js`: `procesarCandidatos`; `recoverPendingSearchRuns` al empezar la detección (REQ-VPF-08)
- [ ] 6.3 `server.js`: valida `SEARCH_WAIT_MS` y `SEARCH_RUN_TIMEOUT_SECS`
- [ ] 6.4 Tests: `busquedasPendientes.test.js`; `apidojoProvider.test.js` y `searchSource.test.js` adaptados

## Phase 7: ventana por fuente

- [ ] 7.1 `detectionWindowFor` por fuente, `MONITOR_MIN_WINDOW`, reglas de avance, marca de la red solo si todas avanzaron (REQ-VPF-09)
- [ ] 7.2 Migración desde la marca de la red y re-migración; marcas huérfanas; alta y baja de una fuente (REQ-VPF-10)
- [ ] 7.3 `db.js`: lecturas y escrituras de `refresh_state` por prefijo
- [ ] 7.4 Tests: `ventanaPorFuente.test.js`; `detectionWindow.test.js` y `xMonitoring.test.js` adaptados

## Phase 8: `applyWindow` por el día de `until`

- [ ] 8.1 `instagramApidojo.js`: `until` desde `sinceIso`; `applyWindow(posts, until)`; meta de la consulta; aviso del tope corregido (REQ-VPF-11)
- [ ] 8.2 Tests: `apidojoProvider.test.js`, `searchSource.test.js`

## Phase 9: tope por término y segunda consulta

- [ ] 9.1 `src/busquedaTope.js`; `db.lastSearchCallsForTerm` (REQ-VPF-12)
- [ ] 9.2 `monitor.js`: segunda consulta con el tope lleno, dentro del techo del excedente; `tope_lleno` si no entra
- [ ] 9.3 `scheduler.js`: la línea `[costo]` suma las búsquedas esperando y las clasificaciones; `server.js` valida las variables
- [ ] 9.4 Tests: `topeBusqueda.test.js`

## Phase 10: pantalla

- [ ] 10.1 `monitoringProgress.js`: estado `wait`, `updateItem`, nota de cierre, estado de la corrida en la vista (REQ-VPF-13)
- [ ] 10.2 Recuadro de "Actualizar ahora": ventana de la fuente, tope lleno, "sigue en Apify", fase "Recuperando búsquedas pendientes", cierre "Corrida incompleta"
- [ ] 10.3 Barra superior, inicio y Pipeline: estado `incompleta` / `cortada` y qué falló
- [ ] 10.4 Tests: `monitoringProgress.test.js`; capturas a 1366 y 375 px, claro, oscuro y movimiento reducido

## Phase 11: estadísticas

- [ ] 11.1 `listRunTracesForStats`: una corrida sin ninguna fuente que respondiera no cuenta como día con corridas (REQ-VPF-14)
- [ ] 11.2 Tests: `stats.test.js`

## Phase 12: reportes

- [ ] 12.1 `scripts/gastos.js`: rendimiento por término; marca de corrida incompleta (REQ-VPF-15)
- [ ] 12.2 `scripts/costo-apify.js`: pendientes en `--conciliar`; `--asentar` (REQ-VPF-16)
- [ ] 12.3 Tests: `gastos.test.js`, `costoApifyAsentar.test.js`

## Phase 13: documentación

- [ ] 13.1 `.env.example`
- [ ] 13.2 `CLAUDE.md`, `README.md`
- [ ] 13.3 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`
