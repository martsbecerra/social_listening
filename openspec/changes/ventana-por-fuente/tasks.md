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

- [x] 6.1 `instagramApidojo.scrapeSearch` por el asincrónico con vencimiento compartido; `recoverSearchRun`; fachada (REQ-VPF-07)
- [x] 6.2 `monitor.js`: `recoverPendingSearchRuns` al empezar la detección; lo levantado entra a la tubería del ciclo; `cerrarRecuperadas`; `src/searchWait.js` (REQ-VPF-08)
- [x] 6.3 `server.js`: valida `SEARCH_WAIT_MS` y `SEARCH_RUN_TIMEOUT_SECS`
- [x] 6.4 Tests: `busquedasPendientes.test.js`; `apidojoProvider.test.js` y `searchSource.test.js` adaptados

## Phase 7: ventana por fuente

- [x] 7.1 `detectionWindowFor` por fuente, `MONITOR_MIN_WINDOW`, reglas de avance, marca de la red solo si todas avanzaron (REQ-VPF-09)
- [x] 7.2 Migración desde la marca de la red y re-migración; marcas huérfanas; alta y baja de una fuente (REQ-VPF-10)
- [x] 7.3 `db.js`: lecturas y escrituras de `refresh_state` por prefijo
- [x] 7.4 Tests: `ventanaPorFuente.test.js` (`detectionWindow.test.js` y `xMonitoring.test.js` siguen pasando sin cambios: la ventana de la red se conserva)

## Phase 8: `applyWindow` por el día de `until`

- [x] 8.1 `instagramApidojo.js`: `until` desde `sinceIso`; `applyWindow(posts, until)`; meta de la consulta; aviso del tope corregido (REQ-VPF-11)
- [x] 8.2 Tests: `apidojoProvider.test.js`; contrato en `platforms/index.js`

## Phase 9: tope por término y segunda consulta

- [x] 9.1 `src/busquedaTope.js`; `db.lastSearchCallsForTerm` (REQ-VPF-12)
- [x] 9.2 `monitor.js`: segunda consulta con el tope lleno, dentro del techo del excedente; `tope_lleno` si no entra
- [x] 9.3 `scheduler.js`: la línea `[costo]` suma las búsquedas esperando y las clasificaciones; `server.js` valida las variables
- [x] 9.4 Tests: `topeBusqueda.test.js`

## Phase 10: pantalla

- [x] 10.1 `monitoringProgress.js`: estado `wait`, `updateItem`, nota de cierre, estado de la corrida en la vista (REQ-VPF-13)
- [x] 10.2 Recuadro de "Actualizar ahora": ventana de la fuente, tope lleno, "sigue en Apify", fase "Recuperando búsquedas pendientes", cierre "Corrida incompleta"
- [x] 10.3 Barra superior, inicio y Pipeline: estado `incompleta` / `cortada` y qué falló
- [x] 10.4 Tests: `monitoringProgress.test.js`; capturas a 1366 y 375 px, claro, oscuro y movimiento reducido

## Phase 11: estadísticas

- [x] 11.1 `listRunTracesForStats`: una corrida sin ninguna fuente que respondiera no cuenta como día con corridas (REQ-VPF-14)
- [x] 11.2 Tests: `stats.test.js`

## Phase 12: reportes

- [x] 12.1 `scripts/gastos.js`: rendimiento por término; marca de corrida incompleta (REQ-VPF-15)
- [x] 12.2 `scripts/costo-apify.js`: pendientes y corridas no registradas en `--conciliar` (`apify.listActorRuns`); `--asentar` (REQ-VPF-16); el aviso de ciclo sin actividad baja a uno por minuto
- [x] 12.3 Tests: `gastos.test.js`, `costoApifyAsentar.test.js`

## Phase 13: documentación

- [x] 13.1 `.env.example`
- [x] 13.2 `CLAUDE.md`, `README.md`
- [x] 13.3 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`

## Phase 14: textos (al aprobar las capturas, 20/11/2026)

- [x] 14.1 `runStatus.resumenFallidas`: cuando una búsqueda falló y otra sigue en Apify, el título, el chip, la frase y el párrafo del Pipeline nombran las dos (REQ-VPF-06)

## Phase 15: corridas hondas (20/11/2026)

- [x] 15.1 `src/deepRun.js`: `MONITOR_DEEP_HOURS`, `MONITOR_DEEP_WINDOW`, `decidirHonda` (REQ-VPF-17)
- [x] 15.2 `db.js`: `monitoring_runs.honda`, `getLastFinishedDeepRunAt`
- [x] 15.3 `monitor.js`: `detectionWindowFor(…, { minWindowMs })`; el ciclo recibe `pasada`; línea del log con el costo estimado (`busquedaTope.estimarResultados`, `costoDeBusquedas`) (REQ-VPF-18)
- [x] 15.4 `scheduler.js`: `decidirPasada`, `describeNextRun`, la corrida queda registrada como honda; `server.js` valida las variables
- [x] 15.5 Tests: `corridaHonda.test.js`; `.env.example`, `CLAUDE.md`, `README.md`

## Phase 16: revisión por áreas antes del PR (20/11/2026)

Cinco revisores y un agente por hallazgo intentando refutarlo; 20 confirmados, un commit por arreglo (design.md, decisión 12).

- [x] 16.1 Marcas: `addSearch` no borra la marca de un término que ya está; misma clave = misma fuente (`addSearch`, `addKeyword`, `removeSearch`, `removeKeyword`, el ciclo); las keywords de X no heredan la marca de la red; si falla el detalle, la búsqueda que trajo esos resultados no avanza
- [x] 16.2 Lo levantado de Apify: la segunda cortada seguida cuenta; `tope_lleno` en la fila levantada; no se cierra con resultados sin texto sin procesar (hasta 2 días)
- [x] 16.3 `src/apify.js` y costo: el corte al leer el cuerpo es un fallo pasajero; `asyncGuardMs`; la conciliación espera 10 minutos desde el fin del run
- [x] 16.4 Tope: `busquedaTope.historiaPara` y `consultasParecidas`; `lastSearchCallsForTerm` compara en JS; `presupuesto.liberar`; `db.clearTopeLlenoPrimerIntento`; el aviso "sin consultas de esa ventana" en la línea del costo
- [x] 16.5 Estado y textos: salteada = sigue en Apify; levantada a medias = levantada; tope lleno con su segunda consulta; `tituloLineas`; `lastRun.estadoDeLaEscucha`; la respuesta de "Actualizar ahora" sin `fuentes`
- [x] 16.6 Tests de cada arreglo en `ventanaPorFuente`, `busquedasPendientes`, `topeBusqueda`, `estadoCorrida`, `fuentesPorCorrida`, `apifyCorridaCortada`, `apifyCosts` y `corridaHonda`; suite verde con los dos actores (1010)
