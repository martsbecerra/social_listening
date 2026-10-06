# Design: refresco-url

## Technical Approach

El refresco ya tenía separados "qué toca refrescar" (tramos y cadencias
sobre `detected_posts`, marcas en `refresh_state`) de "cómo se consulta la
fuente" (hoy `platform.scrapeAccount` por cuenta). El cambio reemplaza la
segunda parte por `platform.fetchPostDetails(urls)` (actor oficial, un item
por URL, ya usado por el detalle de búsqueda) y baja la primera parte del
nivel cuenta al nivel publicación. Todo lo demás (escritura con
`db.applyMetricsRefresh`, saltos virales, fase y registro de costo,
limitador propio) se conserva.

## Architecture Decisions

- **Interruptor `REFRESH_MODE` (`url` | `perfil`, default `url`).**
  `src/refreshMode.js`, calcado de `igActor.js`: un valor desconocido aborta
  el arranque (`server.js` lo valida antes de cargar módulos). `perfil` es
  la función actual sin tocar: el rollback es un cambio de `.env`. El
  camino URL corre solo si la plataforma tiene `capabilities.metricsRefresh`
  y `fetchPostDetails`; si tiene lo primero y no lo segundo, cae al camino
  perfil (X no tiene ninguno: no se toca).
- **Selección por publicación.** `db.listPostsDueForRefresh({ sinceIso,
  untilIso, cadenceIso, plataforma })` devuelve los posteos no ignorados ni
  frenados con `posted_at` en la ventana del tramo y cuya última escritura
  de métricas es anterior a la cadencia. Un posteo nunca refrescado cuenta
  desde `detected_at` (`COALESCE(metrics_updated_at, detected_at)`): al
  detectarse ya trae las métricas del detalle, así que entra recién cuando
  pasa la cadencia, no en el mismo ciclo. Mismos tramos y gates de hoy:
  caliente por posteo cada `REFRESH_HOT_EVERY_HOURS`; tibio y frío con
  marca de pase (`warm_last_pass_at`, `cold_last_pass_at`) más cadencia por
  posteo.
- **Orden: tramo primero, atraso dentro.** Caliente, después tibio, después
  frío (lo decidió el dueño: lo caliente es lo que detecta saltos). Dentro
  de cada tramo, última escritura más vieja primero. Con el tope
  `REFRESH_MAX_POSTS` (150) lo que no entra queda para el ciclo siguiente y,
  como hoy, las marcas de pase NO avanzan si quedó algo afuera, si un lote
  falló o si se cortó por cuota: el tramo se reevalúa en el próximo ciclo
  y la cadencia por posteo retoma solo lo que faltaba. 150 porque el pase
  tibio más grande visto fue 125 posteos en un ciclo (#19): entra entero; el
  pase frío (278 vencidos hoy, 339 en tramo) se reparte en 2 o 3 ciclos
  seguidos del mismo día. Techo por ciclo: 150 × 0,0023 = 0,345 usd.
- **Un run por ciclo, en lotes de hasta 100 URLs.** El endpoint sincrónico
  de Apify corta a los 300 s y el detalle de 17 URLs tardó 19 s. Los lotes
  (`REFRESH_URLS_PER_RUN`, constante 100, el mismo tope del detalle de
  búsqueda) se lanzan con `refreshLimiter` (propio del módulo, nunca
  `apifyLimiter`: ver el deadlock del Cambio G) y `Promise.allSettled`; un
  flag compartido corta los lotes pendientes al primer `QUOTA_EXCEEDED`.
  Con el tope 150 son a lo sumo 2 runs.
- **Cruce por id y por código.** El item del actor trae `id` numérico y
  `shortCode`; se cruza primero por id (`detected_posts.id`) y, de respaldo,
  por el código de la URL (`monitor.postCodeOf`, el mismo del detalle de
  búsqueda). Solo entran a la cola URLs con código (`/p/`, `/reel/`,
  `/reels/`, `/tv/`); las 474 publicaciones de la base lo tienen. Un posteo
  sin código se saltea y se cuenta en el log; jamás se arma una URL con el
  id numérico (el actor no la acepta).
- **Regla única de métricas (`src/db.js`).** En `applyMetricsRefresh` y
  `updatePostMetricsIfChanged`, por campo: un valor undefined, null o
  negativo conserva lo guardado y no cuenta como cambio; un número mayor o
  igual a 0 pisa. `metrics_updated_at` avanza igual en `applyMetricsRefresh`
  (es lo que hace funcionar la cadencia). Antes `likes ?? null` pisaba con
  NULL lo guardado cuando faltaba un solo campo. En el adapter apidojo,
  `isLikeAndViewCountsDisabled: true` deja likes en null (hoy hay 22 posteos
  con 0 likes y comentarios positivos: contadores ocultos guardados como 0).
  El actor oficial ya mapea su centinela -1 a null.
- **Sin respuesta: contador y freno.** Si el lote terminó bien y un posteo
  pedido no volvió (ausente, o item con `error`), `db.registerRefreshMiss`
  suma 1 a `refresh_misses`; al llegar a `REFRESH_MISSES_TO_STOP` (2) escribe
  `refresh_stopped_at` y el posteo sale de la cola para siempre, con una
  línea de log (cuenta y URL) y conteo en el resumen del ciclo. Una
  respuesta válida (por el refresco o por el benchmark) vuelve el contador a
  0 y levanta el freno. Un lote caído entero no suma: se reintenta por
  cadencia. Las métricas del posteo frenado quedan en su último valor
  conocido: nunca se ponen en null ni en 0. El segundo intento llega al
  ciclo siguiente en caliente y al próximo pase en tibio y frío. Costo
  máximo por posteo borrado: 0,0046 usd.
- **Seguidores.** El actor oficial no trae seguidores por posteo, así que el
  camino URL no llama a `rememberFollowers`. Siguen llegando por el
  benchmark (`computeAccountStats`: de los posteos de perfil apidojo o de la
  consulta aparte), cadencia `BENCHMARK_RECALC_DAYS` (30) por cuenta cuando
  reaparece con un posteo nuevo, y por la validación al agregar una cuenta.
  Nada más dependía del refresco para eso (verificado: `rememberFollowers`
  se llama en el refresco y en la detección; los resultados de búsqueda no
  traen el dato). Hoy: 251 cuentas cacheadas, 4 posteos sin seguidores.
- **Costo.** Sale solo por `runActorSync`: actor oficial, fase `refresco`
  (contexto que pone el scheduler), `query_type` `post` (lo deriva la URL
  `/p/`), 0,0023 por resultado. `scripts/gastos.js` lo clasifica en
  `refresco` por la fase; `npm run costo` por fase y actor. Sin cambios.
- **Progreso y diagnóstico.** `progress.startPhase('Refrescando métricas',
  pedidos)`, un tick por posteo (error para los sin respuesta y para los de
  un lote caído). Línea de log nueva con tramos, pedidos, runs,
  respondidos, con cambios, sin respuesta, frenados, diferidos y sin
  código. Si se pidieron posteos y ninguno respondió sin que fallara el run,
  el aviso "revisar que los ids coincidan" de siempre.

## Data Flow

```
scheduler ── fase refresco ──► metricsRefresh.refreshPostMetrics({ plataformas, skipAccounts })
   REFRESH_MODE=perfil → refreshPostMetricsFor (hoy, sin cambios: scrapeAccount por cuenta)
   REFRESH_MODE=url    → refreshByUrlFor
      caliente: listPostsDueForRefresh(< HOT_HOURS, cadencia HOT_EVERY_HOURS)
      tibio:    gate warm_last_pass_at → listPostsDueForRefresh(HOT_HOURS..WARM_DAYS, cadencia WARM_EVERY_HOURS)
      frío:     gate cold_last_pass_at → listPostsDueForRefresh(WARM_DAYS..COLD_MAX_DAYS, cadencia COLD_EVERY_DAYS)
      − skipAccounts (cuentas que el benchmark acaba de pasar) − sin código en la URL
      orden: caliente › tibio › frío; dentro, última escritura más vieja primero
      tope REFRESH_MAX_POSTS → pedidos | diferidos
      lotes de ≤ 100 URLs → refreshLimiter.run(platform.fetchPostDetails(urls))
            → apify/instagram-scraper { directUrls, resultsType:'posts', resultsLimit:1 }  (apify_calls: refresco · post · 0,0023/res.)
      por posteo pedido: item por id, si no por código de la URL
         con item  → applyMetricsRefresh (regla única; misses = 0) → checkAndLogJump
         sin item  → registerRefreshMiss → al 2.º seguido: refresh_stopped_at + log
      marcas tibio/frío avanzan solo si: sin cuota agotada, sin lote caído, sin diferidos
```

## Cost model (corridas reales #17 a #32, 28/09 al 2/10/2026)

| | Perfil (real) | URL (0,0023 × posteos vencidos del log) |
|---|---|---|
| 16 ciclos, 659 posteos a refrescar | 3,27 | 1,52 (techo) |
| Por día | 0,85 | 0,39 |
| Ciclo solo caliente (11 a 47 posteos) | 0,04 a 0,22 | 0,03 a 0,11 |
| Pase tibio diario (60 a 125 posteos) | 0,36 a 0,64 | 0,14 a 0,29 |
| Pase frío semanal (242 a 339 posteos) | ~0,90 | 0,56 a 0,78 |

El 1,52 es techo: por perfil, un posteo que no vino entre los 15 últimos
sigue vencido y se vuelve a contar en el ciclo siguiente; por URL se
actualiza y sale de la cola hasta su próxima cadencia.
