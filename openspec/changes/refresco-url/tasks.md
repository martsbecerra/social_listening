# Tasks: refresco-url

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-RURL-*)

## Phase 1: regla única de métricas

- [ ] 1.1 `db.applyMetricsRefresh` y `db.updatePostMetricsIfChanged`: ausente, null o negativo conserva lo guardado, por campo (REQ-RURL-06)
- [ ] 1.2 `instagramApidojo.js`: `isLikeAndViewCountsDisabled` → likes null (REQ-RURL-06)
- [ ] 1.3 `test/metricasConservadas.test.js`; caso nuevo en `test/apidojoProvider.test.js`

## Phase 2: base e interruptor

- [ ] 2.1 Columnas `refresh_misses` y `refresh_stopped_at` en `detected_posts` (ALTER TABLE si faltan) (REQ-RURL-07)
- [ ] 2.2 `db.listPostsDueForRefresh` por publicación, `db.registerRefreshMiss`, reset del contador al escribir métricas (REQ-RURL-02, REQ-RURL-07)
- [ ] 2.3 `src/refreshMode.js` (`REFRESH_MODE`), validación en `server.js`, banner (REQ-RURL-01)
- [ ] 2.4 `monitor.postCodeOf` exportado

## Phase 3: refresco por URL

- [ ] 3.1 `metricsRefresh.js`: tramos y marcas compartidos, camino URL (orden, tope, lotes, cruce, escritura, saltos, fallos, marcas, log) (REQ-RURL-02 a REQ-RURL-05, REQ-RURL-07)
- [ ] 3.2 Despacho por `REFRESH_MODE`; camino perfil intacto (REQ-RURL-01, REQ-RURL-10)
- [ ] 3.3 `refreshTramos.test.js` y `parallelRefresh.test.js` con `REFRESH_MODE=perfil`; `apifyCosts.test.js` espera `query_type` `post` (REQ-RURL-09)

## Phase 4: tests del camino URL

- [ ] 4.1 `test/refreshPorUrl.test.js`: selección y cadencias, orden y tope, marcas, sin código, regla de métricas, fallos y freno, lote caído, cuota, fila de `apify_calls`
- [ ] 4.2 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`

## Phase 5: documentación

- [ ] 5.1 `.env.example` (`REFRESH_MODE`, `REFRESH_MAX_POSTS`, `REFRESH_MISSES_TO_STOP`; `MAX_ACCOUNTS_PER_REFRESH` y `BENCHMARK_POST_LIMIT` solo en perfil)
- [ ] 5.2 `CLAUDE.md`, `README.md`
- [ ] 5.3 Estimación de costo por ciclo con la base real; corrida real chica (pendiente de autorización)
