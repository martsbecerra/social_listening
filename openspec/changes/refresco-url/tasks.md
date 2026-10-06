# Tasks: refresco-url

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-RURL-*)

## Phase 1: regla única de métricas

- [x] 1.1 `db.applyMetricsRefresh` y `db.updatePostMetricsIfChanged`: ausente, null o negativo conserva lo guardado, por campo (REQ-RURL-06)
- [x] 1.2 `instagramApidojo.js`: `isLikeAndViewCountsDisabled` → likes null (REQ-RURL-06)
- [x] 1.3 `test/metricasConservadas.test.js`; caso nuevo en `test/apidojoProvider.test.js`

## Phase 2: base e interruptor

- [x] 2.1 Columnas `refresh_misses` y `refresh_stopped_at` en `detected_posts` (ALTER TABLE si faltan) (REQ-RURL-07)
- [x] 2.2 `db.listPostsDueForRefresh` por publicación, `db.registerRefreshMiss`, reset del contador al escribir métricas (REQ-RURL-02, REQ-RURL-07)
- [x] 2.3 `src/refreshMode.js` (`REFRESH_MODE`), validación en `server.js`, banner (REQ-RURL-01)
- [x] 2.4 `monitor.postCodeOf` exportado

## Phase 3: refresco por URL

- [x] 3.1 `metricsRefresh.js`: tramos y marcas compartidos, camino URL (orden, tope, lotes, cruce, escritura, saltos, fallos, marcas, log) (REQ-RURL-02 a REQ-RURL-05, REQ-RURL-07)
- [x] 3.2 Despacho por `REFRESH_MODE`; camino perfil intacto (REQ-RURL-01, REQ-RURL-10)
- [x] 3.3 `refreshTramos.test.js` y `parallelRefresh.test.js` con `REFRESH_MODE=perfil`; `apifyCosts.test.js` espera `query_type` `post` (REQ-RURL-09)

## Phase 4: tests del camino URL

- [x] 4.1 `test/refreshPorUrl.test.js`: selección y cadencias, orden y tope, marcas, sin código, regla de métricas, fallos y freno, lote caído, cuota, fila de `apify_calls`
- [x] 4.2 Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`

## Phase 5: documentación

- [x] 5.1 `.env.example` (`REFRESH_MODE`, `REFRESH_MAX_POSTS`, `REFRESH_MISSES_TO_STOP`; `MAX_ACCOUNTS_PER_REFRESH` y `BENCHMARK_POST_LIMIT` solo en perfil)
- [x] 5.2 `CLAUDE.md`, `README.md`
- [x] 5.3 Estimación de costo por ciclo con la base real (README, "Refresco de métricas por URL")
- [x] 5.4 Corrida real chica autorizada (2026-10-06, US$ 0,0115), desde el worktree contra una copia de la base con `REFRESH_MAX_POSTS=5`: un run de 24,6 s con las 5 publicaciones tibias más atrasadas; 5 de 5 respondieron y cruzaron por id (los items vuelven en otro orden), 5 con cambios (métricas de 6 días atrás), un salto detectado (9.716 → 30.131 likes), 363 diferidas y marcas de pase sin avanzar; fila en `apify_calls` con fase `refresco`, `query_type` `post`, actor oficial, usd 0,0115; costo real leído del run: 0,0115 (5 eventos `result` a 0,0023, "each result written to the dataset"). No cubrió likes ocultos (-1) ni items de error: ninguna de las 5 los trajo; esos dos caminos siguen verificados solo con stubs
- [x] 5.5 Segunda corrida real autorizada (2026-10-06, US$ 0,0046): un run de 27,8 s con 2 URLs elegidas para los dos casos que faltaban. Likes ocultos (`/p/DdZzrFHp5qB/`, @descalzo.nico): el actor devuelve `likesCount: -1` con `commentsCount` real (1.526) y `videoPlayCount`; se normaliza a likes null, el valor guardado no se pisa, los comentarios pasan de 1.396 a 1.526 y la marca avanza. Shortcode inexistente (`/p/DnoExiste01/`): el actor escribe en el dataset `{ url, error: "not_found", errorDescription: "Post does not exist" }` (sin `id` ni `inputUrl`), `fetchPostDetails` lo descarta y el refresco suma un intento sin respuesta (`refresh_misses` 0 → 1) sin tocar métricas ni marca. Costo real leído del run: 0,0046 = 2 eventos `result`: el item de error SE COBRA (0,0023), igual que lo estima `apify_calls` (items 2). Pendiente de decisión del dueño: los posteos que ya tenían guardado un 0 de likes ocultos (22 con 0 likes y comentarios > 0) conservan ese 0, porque la regla única no lo pisa con null
