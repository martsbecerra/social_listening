# Proposal: actor-apidojo

## Intent

Migrar todo el monitoreo de Instagram (detección, benchmark, refresco de
métricas, validación de cuentas y hashtags, script de recálculo) del actor
`apify/instagram-scraper` al actor `apidojo/instagram-scraper-api`, y sumar
una cuarta fuente de detección: la búsqueda por palabra clave nativa de
Instagram. El análisis de una publicación (comentarios) sigue con
`apify/instagram-scraper`, que es el único que los devuelve.

**Por qué.** Apify cobra por lo que el actor produce. `apify/instagram-scraper`
cobra 2,30 usd por 1.000 resultados (plan Starter), un hashtag paga siempre
el tope completo y no existe búsqueda por palabra clave.
`apidojo/instagram-scraper-api` cobra por consulta con posteos incluidos
(perfil 0,005 usd con 10; hashtag 0,015 con 30; búsqueda 0,015 con 20) y
0,0005 usd por posteo extra, no necesita login ni cookies, trae los
seguidores del autor en cada posteo de perfil y tiene búsqueda por palabra
clave.

## Scope

### In Scope

- Interruptor `IG_ACTOR` (`apidojo` default | `apify`) detrás de la misma
  interfaz del adapter de Instagram, con la misma forma normalizada de
  posteo hacia el resto de la app (Fase 1)
- Proveedor apidojo: cuentas, hashtags, benchmark, validación, seguidores
  desde los posteos, ventana de fecha con `until` + descarte propio (Fase 1)
- Lista `searches` en `config/monitoring.json`, API, caja en la UI de
  Instagram, `sourceType 'search'` en el pipeline (Fase 2)
- Costo por actor y tipo de consulta en `apify_calls`, costo real por run
  (`usd_real`) vía el flujo asincrónico, reportes por actor, línea
  `[costo]` con la fase `busqueda`, `.env.example`, README, CLAUDE.md,
  este SDD (Fase 3)
- Detalle de los resultados de búsqueda sin caption: un run por ciclo del
  actor oficial con las URLs nuevas, tope `SEARCH_ENRICH_LIMIT`, tabla
  `search_seen` (Fase 5, después del primer ciclo real)

### Out of Scope

- El análisis de publicación (`src/apify.js`, `/api/analyze`)
- El módulo de X (`src/platforms/x.js`, `src/x/`)
- Migrar datos: `detected_posts`, `account_stats` y `account_followers`
  quedan como están (los ids y urls coinciden entre actores)
- Una tarjeta de costos en el frontend
- Un tope de gasto por run (`maxTotalChargeUsd`)

## Capabilities

### New Capabilities

- `actor-apidojo`: proveedor apidojo del adapter de Instagram, interruptor
  `IG_ACTOR`, búsqueda por palabra clave, costo por consulta y costo real

### Modified Capabilities

- Monitoreo de Instagram: topes por tipo de fuente (`MONITOR_ACCOUNT_LIMIT`,
  `MONITOR_HASHTAG_LIMIT`, `SEARCH_RESULTS_LIMIT`) reemplazan a
  `MONITOR_RESULTS_LIMIT`
- Seguidores: la caché `account_followers` se actualiza con cada respuesta
  que trae el dato, en cualquier fase; el benchmark consulta aparte solo
  cuando los posteos no lo trajeron
- Medición de gasto: `apify_calls` suma `actor`, `query_type`, `usd_real`,
  `apify_run_id`; los reportes desglosan por actor

## Approach

1. Fachada `src/platforms/instagram.js` que delega en
   `instagramApidojo.js` o `instagramApify.js` (el código anterior movido sin
   cambios) según `IG_ACTOR`. `scrapeSearch` solo se expone si el proveedor
   busca.
2. Una llamada por fuente (`startUrls` de un solo elemento o `keywords` de un
   solo término) con `maxItems` como tope por fuente y `until` = fecha UTC
   en que arranca la ventana; lo anterior a la ventana real (fijados
   incluidos) se descarta del lado nuestro.
3. Normalización a la forma actual: `id` numérico y `url` `/p/{code}/`
   idénticos a los del actor oficial (verificado contra una corrida real);
   `likeCount`/`commentCount` ausentes quedan null; `post_type` con los
   valores de `account_stats`; `followers` de `owner.followerCount`.
4. `searches` como lista aparte de `keywords`: cada término es una consulta
   cobrada por ciclo, y lo que trae se filtra como un hashtag.
5. Costo: estimado por actor al registrar; para apidojo, flujo asincrónico
   de Apify (run + lectura del run + items) para guardar `usageTotalUsd`
   como `usd_real`, que los reportes prefieren al estimado.

## Affected Areas

- `openspec/changes/actor-apidojo/` — este SDD
- `src/platforms/instagram.js`, `instagramApidojo.js`, `instagramApify.js`,
  `igActor.js`, `index.js` (contrato)
- `src/monitor.js` — topes por fuente, `rememberFollowers`, `searches`,
  relevancia y dedupe de `search`, fase `busqueda`
- `src/accountStats.js`, `src/metricsRefresh.js` — seguidores desde los posteos
- `src/apify.js` — transporte asincrónico con costo real
- `src/apifyCost.js`, `src/db.js` — costo por actor, columnas nuevas
- `server.js` — validación de `IG_ACTOR`, endpoints de `searches`
- `public/instagram.html`, `public/js/monitoring.js`, `public/css/styles.css`
- `scripts/costo-apify.js`, `scripts/recalc-account-stats.js`
- `.env.example`, `README.md`, `CLAUDE.md`, `config/README.md`, `test/`

## Risks

- `until` tiene granularidad de día y no está documentado cómo se lleva con
  los posteos fijados viejos; el descarte propio por `createdAt` lo cubre,
  pero queda por ver en un ciclo real si el actor corta la paginación al
  ver un fijado viejo.
- En la corrida de fixtures, los dos resultados de búsqueda vinieron con
  `caption`, `likeCount` y `commentCount` en null; si es lo normal de la
  búsqueda, la fuente aportará poco (sin caption se descarta). A mirar en
  el ciclo real. RESUELTO: es lo normal de la búsqueda (3 de 3 items); los
  posteos sí tienen texto y se completa con una consulta de detalle al
  actor oficial (REQ-IGA-09).
- `owner.followerCount` viene solo en consultas de perfil: una cuenta que
  aparece por hashtag o búsqueda queda sin seguidores hasta que el
  benchmark consulte su perfil (misma cadencia que antes).
- La búsqueda por palabra clave no tiene evento de cobro propio en el
  actor: se cobra como `tag-query` (0,015). El `usd_real` dirime.
- El flujo asincrónico agrega dos o tres requests por llamada (medio
  segundo). `APIFY_REAL_COST=0` vuelve al sincrónico.

## Rollback Plan

`IG_ACTOR=apify` en el `.env` y reiniciar: el monitoreo vuelve al actor
anterior con el comportamiento exacto de antes. Las columnas nuevas de
`apify_calls` y la lista `searches` son aditivas y pueden quedar.

## Dependencies

- `APIFY_API_TOKEN` con plan pago de Apify: el actor apidojo limita a los
  usuarios del plan Free a 5 runs por mes de 10 items.
- Tarifas de apidojo (`APIDOJO_*`) según su pestaña de precios; si cambian,
  el `.env` las corrige sin tocar código, y `usd_real` refleja lo cobrado.

## Success Criteria

- [x] Con `IG_ACTOR=apify` la suite pasa y el monitoreo se comporta como antes
- [x] Con apidojo, `id` y `url` de los posteos coinciden con los guardados
      (fixtures reales del 2026-09-18)
- [x] Un ciclo consulta cada término de `searches` una vez, en la fase `busqueda`
- [x] `apify_calls` registra actor, tipo de consulta, usd estimado y usd real
- [x] `npm run costo` y `GET /api/monitoring/costs` desglosan por actor
- [ ] Ciclo completo real con apidojo verificado (pendiente de autorización)
