# Spec: actor-apidojo

Monitoreo de Instagram con el actor `apidojo/instagram-scraper-api` detrás del adapter, interruptor `IG_ACTOR`, búsqueda por palabra clave como cuarta fuente y costo por consulta con costo real.

---

## ADDED Requirements

### Requirement: REQ-IGA-01 — Interruptor `IG_ACTOR`

El monitoreo de Instagram MUST usar el actor que indique `IG_ACTOR`: `apidojo` (default) o `apify`. Con `apify` el comportamiento MUST ser el anterior al cambio (mismo input al actor, seguidores por consulta aparte, sin búsqueda). Un valor desconocido MUST abortar el arranque con un mensaje claro. El análisis de publicación MUST seguir con `apify/instagram-scraper` sin importar `IG_ACTOR`.

#### Scenario: Actor anterior

- GIVEN `IG_ACTOR=apify`
- WHEN el ciclo scrapea una cuenta trackeada
- THEN el input al actor es `{ directUrls, resultsType: 'posts', resultsLimit, onlyPostsNewerThan, skipPinnedPosts }` y `scrapeSearch` no existe

#### Scenario: Valor inválido

- GIVEN `IG_ACTOR=tiktok`
- WHEN arranca el server
- THEN aborta indicando los valores válidos

---

### Requirement: REQ-IGA-02 — Una consulta por fuente

Con apidojo, cada cuenta, hashtag o búsqueda MUST ser un run propio con `startUrls` de un solo elemento (o `keywords` de un solo término) y `maxItems` igual al tope de esa fuente. MUST NOT enviarse un run sin `maxItems`.

#### Scenario: Cuenta trackeada

- GIVEN `MONITOR_ACCOUNT_LIMIT=10`
- WHEN el ciclo scrapea `@cuenta`
- THEN el input es `{ startUrls: ['https://www.instagram.com/cuenta/'], maxItems: 10, until: <día UTC en que arranca la ventana> }`

---

### Requirement: REQ-IGA-03 — Normalización compatible

Los posteos de apidojo MUST normalizarse a la forma actual: `id` = id numérico de Instagram, `url` = `/p/{code}/`, `postedAt` = `createdAt`, `likes`/`comments` null cuando faltan (nunca 0), `postType` ∈ reel | imagen | carrusel | null, `followers` de `owner.followerCount`, `sourceType` y `sourceQuery`. Items sin id o url, o con `noResults`/`error`, MUST descartarse.

#### Scenario: Contador ausente

- GIVEN un item con `commentCount: null`
- WHEN se normaliza
- THEN `comments` es null

#### Scenario: Carrusel

- GIVEN un item con `isCarousel: true` y `carouselMedia` de 3
- WHEN se normaliza
- THEN `postType` es `carrusel`

---

### Requirement: REQ-IGA-04 — Ventana de fecha

Con `lookback`, el proveedor MUST enviar `until` = fecha UTC de (ahora − lookback) y MUST descartar del lado propio los posteos anteriores a (ahora − lookback), fijados incluidos, y los sin fecha. Sin `lookback` (benchmark, refresco) MUST NOT enviar `until` ni filtrar.

#### Scenario: Fijado viejo

- GIVEN `MONITOR_LOOKBACK="1 day"` y un posteo fijado de hace tres meses
- WHEN se scrapea la cuenta
- THEN el fijado no entra a la detección

---

### Requirement: REQ-IGA-05 — Topes por tipo de fuente

El orquestador MUST leer `MONITOR_ACCOUNT_LIMIT` (10), `MONITOR_HASHTAG_LIMIT` (30) y `SEARCH_RESULTS_LIMIT` (50). Si `MONITOR_RESULTS_LIMIT` está definido y faltan los topes de cuenta u hashtag, MUST usarse como respaldo para esos dos, avisando una vez.

#### Scenario: `.env` viejo

- GIVEN `MONITOR_RESULTS_LIMIT=15` y ningún tope nuevo
- WHEN corre el ciclo
- THEN cuentas y hashtags usan 15 y la búsqueda 50

---

### Requirement: REQ-IGA-06 — Seguidores desde los posteos

La caché `account_followers` MUST actualizarse con cada respuesta que traiga `followers`, en cualquier fase. `owner.followerCount` es el del perfil consultado: el proveedor MUST dejar `followers` en null cuando el owner del item no es la cuenta consultada (posteos en colaboración). El benchmark MUST tomar los seguidores de los posteos si vinieron y consultar aparte solo si no. Un posteo nuevo MUST guardarse con los seguidores que trajo. Una cuenta que no devuelve posteos MUST conservar el último valor conocido.

#### Scenario: Benchmark con apidojo

- GIVEN una cuenta cuyos posteos traen `followers: 555`
- WHEN se calcula su benchmark
- THEN la caché queda en 555 y no se hace ninguna consulta de perfil aparte

---

### Requirement: REQ-IGA-07 — Búsqueda por palabra clave

La sección de Instagram del config MAY tener `searches`, una lista aparte de `keywords`. En cada ciclo MUST hacerse una llamada por término (fase `busqueda`, tope `SEARCH_RESULTS_LIMIT`) solo si el adapter expone `scrapeSearch`; si hay términos y no la expone, MUST avisarse e ignorarse. Los resultados MUST entrar al mismo pipeline (dedupe, refresco de conocidos, relevancia literal o semántica, clasificación) con `sourceType 'search'` y motivo `Búsqueda: <término>`; sin caption MUST descartarse. Si el mismo posteo llega por cuenta trackeada y por búsqueda, MUST quedar como de la cuenta trackeada. Agregar un término MUST NOT llamar a Apify.

#### Scenario: Coincidencia literal

- GIVEN `searches: ['jorge macri']` y `keywords: ['jorge macri']`
- WHEN la búsqueda devuelve un posteo con caption "Jorge Macri inauguró"
- THEN se guarda con `matched_reason` `Búsqueda: jorge macri (coincidencia: "jorge macri")`

#### Scenario: Actor anterior

- GIVEN `IG_ACTOR=apify` y un término configurado
- WHEN corre el ciclo
- THEN no se busca, se avisa por consola y agregar otro término se rechaza

---

### Requirement: REQ-IGA-08 — Costo por actor y costo real

`apify_calls` MUST guardar `actor`, `query_type` (user | hashtag | search | post | details), `usd` estimado (oficial: resultados × tarifa del plan; apidojo: tarifa de la consulta + posteos extra × `APIDOJO_RATE_ITEM`), y para las llamadas por el flujo asincrónico `apify_run_id` y, conciliado después, `usd_real` (`usageTotalUsd` del run). `usd_real` MUST NOT leerse al terminar el run (Apify lo asienta con demora): MUST escribirlo la conciliación (llamadas de más de 10 minutos), que además MUST recalcular el usd del ciclo y dejar pendiente un run que figura en 0 con eventos cobrados. Con apidojo y `APIFY_REAL_COST` distinto de 0, las llamadas MUST ir por el flujo asincrónico. Los reportes MUST desglosar por actor, con las tres columnas por plan solo para el oficial y `usd_real` preferido al estimado para apidojo. La línea `[costo]` MUST incluir la fase `busqueda`.

#### Scenario: Consulta de hashtag con extras

- GIVEN una llamada apidojo de hashtag que devolvió 45 posteos
- WHEN se registra
- THEN `query_type` es `hashtag` y `usd` es 0,015 + 15 × 0,0005 = 0,0225

#### Scenario: Costo real

- GIVEN una llamada de hace 20 minutos con `apify_run_id` y sin `usd_real`, cuyo run dice `usageTotalUsd: 0.0065`
- WHEN corre la conciliación
- THEN `usd_real` queda en 0,0065 y el usd de su ciclo se recalcula con ese valor en vez del estimado
