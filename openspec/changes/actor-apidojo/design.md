# Design: actor-apidojo

## Technical Approach

El monitoreo ya separaba la fuente (adapter de `src/platforms/`) del
orquestador (`src/monitor.js`), el benchmark (`src/accountStats.js`) y el
refresco (`src/metricsRefresh.js`). El cambio de actor se hace en la fuente:
`src/platforms/instagram.js` pasa a ser una fachada sobre dos proveedores
con la misma interfaz y la misma forma normalizada de posteo, y todo lo
demás sigue igual. El análisis de publicación (`src/apify.js`) no se toca.

## Architecture Decisions

- **Fachada + dos proveedores, elegidos al cargar por `IG_ACTOR`.**
  `instagramApify.js` es el código anterior movido sin cambios (con
  `IG_ACTOR=apify` todo funciona exactamente como antes).
  `instagramApidojo.js` es el nuevo. La fachada expone `scrapeSearch` solo
  si el proveedor lo tiene: el orquestador decide por
  `typeof platform.scrapeSearch === 'function'`, nunca por el nombre del
  actor. Un `IG_ACTOR` desconocido aborta el arranque (`server.js` lo
  valida antes de cargar módulos), igual que `LLM_PROVIDER`.
- **Una llamada por fuente.** `startUrls` con una sola URL o `keywords` con
  un solo término, y `maxItems` como tope por fuente: el costo de cada
  llamada es predecible y la fila de `apify_calls` describe una consulta.
- **Ventana de fecha.** `until` = fecha UTC de (ahora − `MONITOR_LOOKBACK`),
  que con "1 day" es ayer. Como `until` filtra por día, el proveedor
  descarta además lo anterior a la ventana real por `createdAt`, fijados
  incluidos. Sin `lookback` (benchmark, refresco) no hay `until`.
- **Seguidores desde los posteos.** `owner.followerCount` viene en las
  consultas de perfil y es el del perfil CONSULTADO: en un posteo en
  colaboración (owner distinto) el actor repite ese número (ciclo real:
  `@somos100barrios` quedó con los 54 de `@somoslupaa`), así que el
  proveedor solo lo toma cuando el owner del item es la cuenta consultada.
  Cada posteo normalizado lleva `followers`;
  `monitor.rememberFollowers` actualiza `account_followers` en detección,
  benchmark y refresco. El adapter no toca la base. `fetchAccountFollowers`
  de apidojo devuelve null sin llamar; el benchmark lo usa solo de respaldo
  (actor oficial).
- **Topes por tipo de fuente.** `MONITOR_ACCOUNT_LIMIT` (10),
  `MONITOR_HASHTAG_LIMIT` (30), `SEARCH_RESULTS_LIMIT` (50), alineados a los
  posteos incluidos de cada consulta. `MONITOR_RESULTS_LIMIT` deja de
  usarse; si sigue en el `.env` y faltan los nuevos, vale para cuentas y
  hashtags con un aviso, así un `.env` viejo no cambia de comportamiento.
- **`searches` es una lista aparte de `keywords`.** Las keywords son un
  filtro gratis; cada término de `searches` es una consulta cobrada por
  ciclo. Aparece en el archivo con el primer alta y solo en la sección de
  Instagram. Sin validación contra Apify al agregar; se rechaza solo si la
  plataforma no busca (`IG_ACTOR=apify`, o X).
- **Los resultados de búsqueda se filtran.** Instagram asocia al término
  mucho contenido ajeno: `sourceType 'search'` pasa por relevancia literal
  o semántica como un hashtag, con motivo `Búsqueda: <término>`; sin caption
  se descarta. En el dedupe intra-ciclo gana el origen más específico:
  `keyword` (X) > `account` > `hashtag` = `search`.
- **Detalle de los resultados de búsqueda, por el actor oficial.** La
  búsqueda de apidojo devuelve objetos recortados: `caption`, `likeCount` y
  `commentCount` en null en todos los items vistos (fixtures y ciclo real),
  aunque el posteo tenga texto. Se pidió el mismo reel por URL a los dos
  actores (US$ 0,0073, `test/fixtures/apidojo/post.json` y
  `test/fixtures/apify/post-detail.json`): los dos traen caption y
  contadores, el oficial a 0,0023 por posteo y con varias URLs por run,
  apidojo a 0,005 por posteo. Por eso `fetchPostDetails(urls)` vive en
  `instagramApify.js` y la fachada lo expone con cualquier `IG_ACTOR`: es
  la única excepción a "un proveedor por `IG_ACTOR`".
  `monitor.enrichSearchResults` corre después del dedupe intra-ciclo y antes
  de la relevancia: candidatos = `sourceType 'search'` sin caption que no
  están en `detected_posts` ni en `search_seen`; los más nuevos primero
  hasta `SEARCH_ENRICH_LIMIT` (20; 0 apaga el paso), el resto queda sin
  anotar para el ciclo siguiente; UN run con todas las URLs en la fase
  `busqueda`; el detalle se cruza por id (respaldo: código de la URL) y
  vuelca caption, hashtags y contadores sobre el posteo de la búsqueda, que
  conserva `sourceType`, `sourceQuery` y sus seguidores en null. Después
  corre el pipeline de siempre. `search_seen (post_id, plataforma, url,
  term, outcome, first_seen_at)` anota todo aquello por lo que se pagó:
  `sin_detalle` (el run no devolvió ese posteo), `sin_caption` (el detalle
  tampoco trae texto: se descarta) y, tras la relevancia, `guardado` o
  `descartado`; un descartado no se vuelve a consultar ni a evaluar. Se
  purga a los 30 días al empezar cada ciclo. Si el run falla entero no se
  anota nada (se reintenta); un error de plataforma se trata como el de
  cualquier fuente.
- **Costo real por el flujo asincrónico, solo para apidojo, conciliado
  después.** El endpoint sincrónico no devuelve el id del run y el costo
  cobrado solo se lee del objeto del run. `POST
  /acts/{id}/runs?waitForFinish=60`, `GET` del run hasta que termine (dentro
  de `REQUEST_TIMEOUT_MS`) y `GET` de los items del dataset; la fila guarda
  `apify_run_id`. El ciclo real del 2026-09-18 mostró que `usageTotalUsd`
  leído al terminar el run todavía no está asentado (0 en 10 de 29 llamadas,
  sin los posteos extra en el resto), así que `usd_real` lo escribe
  `apifyCost.reconcileRealCosts`: relee con `apify.fetchRunCost` los runs de
  las llamadas de más de 10 minutos y menos de 7 días, deja pendiente lo que
  figura en 0 con eventos cobrados, y recalcula el usd de los ciclos
  afectados. Corre al cerrar cada ciclo y con `costo-apify.js --conciliar`.
  Mismo limitador, mismo reintento del 402, mismo registro.
  `APIFY_REAL_COST=0` vuelve al sincrónico. El oficial no cambia.
- **Costo estimado por actor.** Oficial: resultados × tarifa del plan
  (`APIFY_RATE_*`). Apidojo: tarifa de la consulta según `query_type` +
  (items − incluidos) × `APIDOJO_RATE_ITEM`. Los reportes recalculan al
  oficial con las tres tarifas y usan `usd_real` para apidojo cuando existe.
- **Sin migración de datos.** `id` y `url` coinciden entre actores; las
  columnas nuevas de `apify_calls` se agregan con `ALTER TABLE` si faltan y
  las filas viejas (actor NULL) cuentan como oficial.

## Data Flow

```
ciclo (scheduler) ── fase monitoreo ──► monitor.runMonitoringCycle
   accounts  → instagram.scrapeAccount  → apidojo: { startUrls:[perfil],  maxItems, until }
   #hashtags → instagram.scrapeHashtag  → apidojo: { startUrls:[tag],     maxItems, until }
   searches  → instagram.scrapeSearch   → apidojo: { keywords:[término],  maxItems, until }   (fase busqueda)
      → normalizePost (id, url, caption, likes, comments, postedAt, postType, followers, sourceType, sourceQuery)
      → applyWindow (createdAt ≥ ahora − lookback)
   → rememberFollowers → dedupe (keyword > account > hashtag = search)
   → enrichSearchResults: 'search' sin caption, nuevos y no vistos, hasta SEARCH_ENRICH_LIMIT
        → instagram.fetchPostDetails(urls) → apify/instagram-scraper { directUrls:[...], resultsType:'posts', resultsLimit:1 }   (fase busqueda)
        → caption + hashtags + contadores sobre el mismo posteo · search_seen: sin_detalle | sin_caption
   → conocidos: applyMetricsRefresh gratis · nuevos: evaluateRelevance → saveDetectedPost
        → search_seen: guardado | descartado (solo los que pagaron detalle)
   ── fase benchmark ──► accountStats (scrapeAccount sin until; seguidores de los posteos)
   ── fase refresco  ──► metricsRefresh (scrapeAccount sin until; rememberFollowers)

runActorSync(input, { actorId })
   oficial → run-sync-get-dataset-items ──► items
   apidojo → POST runs?waitForFinish=60 → GET run (hasta terminar) → GET dataset items
   → recordApifyCall { actor, query_type, items, usd estimado, apify_run_id }

cierre del ciclo → reconcileRealCosts (llamadas de más de 10 min con apify_run_id y sin usd_real)
   → apify.fetchRunCost(run) → usd_real → recomputeMonitoringRunUsd
```

## Salida real del actor (2026-09-18)

`test/fixtures/apidojo/` guarda la salida de una corrida chica autorizada.
Campos: `type` (siempre `"post"`), `id` (numérico, igual al oficial),
`code`, `url` (`/p/{code}/`), `createdAt`, `caption` (puede ser null),
`likeCount` y `commentCount` (pueden ser null), `isVideo` + `video
{ playCount, duration }`, `isCarousel` + `carouselMedia[]`, `isPinned`,
`isPaidPartnership`, `isLikeAndViewCountsDisabled`, `location`, `audio`,
`owner { username, isVerified, followerCount (solo perfil) }`. Un perfil
inexistente devuelve `[]`. Los posteos de un perfil vienen del más nuevo al
más viejo.

## Cost model

| Operación | apify/instagram-scraper (Starter) | apidojo |
|---|---|---|
| Cuenta por ciclo, con novedades | hasta 0,0345 (15 res.) | 0,005 |
| Cuenta por ciclo, sin novedades | 0,0023 | 0,005 |
| Hashtag por ciclo | 0,0345 | 0,015 |
| Búsqueda, 50 resultados | — | 0,030 |
| Detalle de un resultado de búsqueda nuevo | 0,0023 (siempre este actor) | 0,005 (no se usa) |
| Benchmark (15 posteos + seguidores) | 0,0368 | 0,0075 |
| Refresco (15 posteos) | 0,0345 | 0,0075 |
| Validar cuenta / hashtag | 0,0023 / 0,0023 | 0,005 / 0,015 |
