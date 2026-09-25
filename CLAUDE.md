# Social Listening App — guía para trabajar en este repo

App Node (Express + `node:sqlite`, sin paso de build) que analiza
publicaciones de Instagram y X y monitorea menciones del Jefe de Gobierno
porteño. Todo va en castellano rioplatense: comentarios del código, commits,
README y esta guía. El README explica cada módulo; acá está lo que hay que
saber antes de tocar algo.

## Cómo se trabaja acá

- `npm test` corre `node --test test/*.test.js`. Cada archivo es un proceso
  propio: fija sus variables de entorno (base y config en tempfiles vía
  `MONITORING_DB_PATH`, `MONITORING_CONFIG_PATH`, `MONITORING_X_CONFIG_PATH`)
  ANTES de los `require`, y stubea el clasificador (`src/classifier.js`),
  los adapters (sobre el objeto del módulo) y `global.fetch`. Ningún test
  toca `data/monitoring.db` ni `config/monitoring.json`, ni llama a Apify o
  a un LLM. La suite tiene que pasar también con `IG_ACTOR=apify`.
- Nada corre contra Apify real (ni tests, ni scripts, ni el server) sin
  autorización explícita del dueño; cada prueba real se pide con el costo
  estimado.
- Un commit por paso, mensajes en castellano; nunca mergear a `main` sin
  confirmación. `.env`, `data/` y backups no se versionan.
- Los cambios grandes se registran en `openspec/changes/<nombre>/`
  (proposal, design, tasks, spec), con el formato de los que ya están.

## Instagram: dos actores de Apify

- **Monitoreo** (detección, benchmark, refresco de métricas, validación de
  cuentas y hashtags, `scripts/recalc-account-stats.js`): el actor lo elige
  `IG_ACTOR` (`src/platforms/igActor.js`). Default `apidojo` =
  `apidojo/instagram-scraper-api` (`src/platforms/instagramApidojo.js`);
  `apify` = `apify/instagram-scraper` (`src/platforms/instagramApify.js`, el
  comportamiento anterior, sin cambios). `src/platforms/instagram.js` es la
  fachada: monitor, accountStats, metricsRefresh, db, server y frontend no
  saben qué actor hay abajo. Un valor desconocido aborta el arranque.
- **Análisis de publicación** (`src/apify.js` → `scrapeInstagram`,
  `POST /api/analyze`): SIEMPRE `apify/instagram-scraper`, porque apidojo no
  devuelve comentarios. No migrarlo.
- Todas las llamadas pasan por `runActorSync` (`src/apify.js`): cola global
  de `APIFY_MAX_CONCURRENT` runs, un reintento del 402
  `concurrent-runs-limit-exceeded`, y registro de cada llamada en
  `apify_calls`. El actor apidojo va por el flujo asincrónico (arrancar el
  run, esperar, bajar los items) para guardar el `apify_run_id`; el costo
  real (`usd_real`) NO se lee al terminar (Apify lo asienta con demora):
  lo concilia `apifyCost.reconcileRealCosts` al cerrar el ciclo siguiente
  o `node scripts/costo-apify.js --conciliar`. `APIFY_REAL_COST=0` lo apaga.
  El oficial sigue con `run-sync-get-dataset-items`.

## Las cuatro fuentes de detección (`config/monitoring.json`, sección `instagram`)

1. `accounts`: cuentas trackeadas. Una consulta de perfil por cuenta y por
   ciclo, `MONITOR_ACCOUNT_LIMIT` posteos, con `until` y una ventana
   DINÁMICA (`monitor.detectionWindowFor`, no ya el fijo `MONITOR_LOOKBACK`):
   desde el fin de la última detección exitosa de esa plataforma hasta
   ahora, con techo `MONITOR_LOOKBACK_MAX` (default 7 días) — así una caída
   del server no pierde lo publicado en el medio, sin disparar una
   recuperación gigante. En el caso normal (cron al día) da "1 day", igual
   que antes. Si supera 1 día, `MONITOR_ACCOUNT_LIMIT`/`MONITOR_HASHTAG_LIMIT`
   suben proporcionalmente (tope 5x) para no perder posteos por el tope de
   cantidad. Un posteo sin caption entra igual.
2. `keywords` que empiezan con `#`: hashtags. Una consulta por hashtag y por
   ciclo (`MONITOR_HASHTAG_LIMIT`), misma ventana dinámica que cuentas.
   Traen todo lo que usa el tag: se filtran.
3. `searches`: búsquedas por palabra clave (solo con apidojo, `scrapeSearch`,
   ventana fija `MONITOR_LOOKBACK` de siempre — no la dinámica de arriba).
   Una consulta por término y por ciclo (`SEARCH_RESULTS_LIMIT`). Se filtran
   como un hashtag; `sourceType 'search'`, motivo `Búsqueda: <término>`.
   Pocos términos, elegidos a mano; con `IG_ACTOR=apify` se ignoran con aviso.
   Llegan sin caption ni contadores: a los nuevos se les pide el detalle
   antes de filtrarlos (ver abajo).
4. `keywords` sin `#`: NO son una fuente. Son el filtro de texto gratuito
   que decide si lo que trajeron las otras tres habla del tema, más
   `classifyRelevance` (semántica) cuando no hay coincidencia literal. En X,
   en cambio, cada keyword (con o sin `#`) es una búsqueda de Grok.

Relevancia y dedupe viven en `src/monitor.js` (`evaluateRelevance`; si un
posteo llega por varias fuentes gana `keyword` (X) > `account` > `hashtag`
= `search`). Los seguidores vienen en los posteos de perfil de apidojo
(`owner.followerCount`, solo en consultas de perfil) y actualizan
`account_followers` en cualquier fase (`monitor.rememberFollowers`). Ese
número es el del perfil CONSULTADO: en un posteo en colaboración (owner
distinto de la cuenta consultada) el actor lo repite, así que el proveedor
deja `followers` en null para esos items.

Los resultados de búsqueda llegan recortados (caption, likes y comentarios
en null aunque el posteo los tenga). `monitor.enrichSearchResults` pide el
detalle de los NUEVOS (ni en `detected_posts` ni en `search_seen`) en un
solo run por ciclo con todas las URLs, `instagram.fetchPostDetails`, fase
`busqueda`. Ese detalle va SIEMPRE por `apify/instagram-scraper` (0,0023
por posteo en Starter y varias URLs por run, contra 0,005 de apidojo), con
cualquier `IG_ACTOR`: es la única función de `instagramApify.js` que la
fachada expone con apidojo activo. Tope por ciclo `SEARCH_ENRICH_LIMIT`
(20; 0 lo apaga; los más nuevos primero, el resto al ciclo siguiente).
`search_seen` anota lo ya pagado (`guardado` | `descartado` | `sin_caption`
| `sin_detalle`): un descartado no se vuelve a consultar ni a evaluar; se
purga a los 30 días. Si el run falla entero no se anota nada.

## Modelo de costo (`src/apifyCost.js`)

- `apify/instagram-scraper` cobra **por resultado devuelto** (items de error
  incluidos): `APIFY_RATE_{FREE,STARTER,SCALE}` por 1000 y `APIFY_PLAN`. El
  detalle de resultados de búsqueda queda registrado con este actor,
  `query_type` `post`, fase `busqueda`.
- `apidojo/instagram-scraper-api` cobra **por consulta** con posteos
  incluidos, más `APIDOJO_RATE_ITEM` (0,0005) por posteo de más: perfil
  0,005 (10 incl.), hashtag 0,015 (30), búsqueda 0,015 (20), posteo suelto
  0,005 (`APIDOJO_RATE_*`, `APIDOJO_INCLUDED_*`). Uso de plataforma incluido.
- `apify_calls` guarda por llamada: fase, ciclo, `actor`, `query_type`
  (user | hashtag | search | post | details), items, `usd` estimado,
  `usd_real`, `apify_run_id`. `monitoring_runs`, una fila por ciclo. Fases:
  `monitoreo`, `busqueda`, `benchmark`, `refresco` (las marcan
  `src/scheduler.js` y `src/monitor.js` con `src/usageContext.js`),
  `validacion`, `recalc-script`, `analisis`.
- Salidas: la línea `[costo] ciclo #N: X llamadas, Y resultados ≈ US$ Z
  (monitoreo · busqueda · benchmark · refresco)`, `npm run costo` y
  `GET /api/monitoring/costs`.

## Ciclo de monitoreo: progreso real

`src/monitoringProgress.js` guarda en memoria la fase del ciclo en curso
(detectando posteos, detalle de búsquedas, clasificando relevancia,
benchmark, refresco), su contador y un porcentaje global (trabajo
completado / trabajo conocido, recalculado en cada `startPhase`).
`GET /api/monitoring/progress` (mismo control de acceso que el resto de
`/api/monitoring`) lo expone; `null` sin ciclo corriendo. El frontend lo
consulta cada 1,5s mientras espera "Actualizar ahora" — ya no hay frases
fijas ni barra simulada. Cuentas, hashtags, búsquedas y keywords se lanzan
juntas (`Promise.allSettled`) y se muestran como una sola fase combinada
("Detectando posteos nuevos"); una fase sin trabajo para esa plataforma
(ej. benchmark en X) nunca se anuncia, sin casos especiales por plataforma.

`refreshStaleAccountStats` y `refreshPostMetrics` también lanzan sus
cuentas con `Promise.allSettled`, cada uno a través de SU PROPIO limitador
(`benchmarkLimiter`, `refreshLimiter` en `src/concurrencyLimiter.js`) —
NUNCA el `apifyLimiter` de `src/apify.js`: compartir esa instancia entre la
capa "cuenta" y la capa "llamada real" (`runActorSync` usa `apifyLimiter`
más adentro) es un deadlock real — pasó en producción, colgó ~30 min — con
`APIFY_MAX_CONCURRENT` cuentas en vuelo ocupando todos los cupos del mismo
limitador, ninguna consigue uno para su propia llamada. Mismo VALOR de
`APIFY_MAX_CONCURRENT`, instancia SEPARADA por capa. Un flag compartido
corta los lanzamientos pendientes apenas una llamada devuelve
`QUOTA_EXCEEDED` (las ya en vuelo terminan); el benchmark automático no
tenía este corte antes, se agregó porque paralelizar sin él dispararía N
llamadas condenadas a la vez.

## Diagnóstico del ciclo (siempre activo, sin flag de DEBUG)

`[ciclo] inicio`/`fin` (scheduler.js), `[fase] arranca`/`termina` con N
ok/N error (monitoringProgress.js), `[apify] →`/`←` por llamada real y
`[limiter:<nombre>]` al esperar/adquirir/liberar cupo (concurrencyLimiter.js)
quedan siempre en consola. Si pasan 15s sin que termine ninguna llamada
mientras un ciclo está en curso, `[heartbeat]` (scheduler.js) loguea la
fase actual y qué target tiene cada tarea activa en `apifyLimiter`,
`benchmarkLimiter` y `refreshLimiter`. `APIFY_CALL_TIMEOUT_MS` (default
120000, piso 1000) corta cada llamada a Apify que no respondió a tiempo,
libera su cupo y la deja en `apify_calls` con `error='TIMEOUT'`.

## Separación por plataforma

Una publicación de X nunca se muestra ni se procesa en Instagram, ni al
revés. La lectura filtra por `detected_posts.plataforma` (cada solapa manda
`?plataforma=`); la escritura la garantiza `db.saveDetectedPost`, que rechaza
(`code: 'PLATAFORMA_INCONSISTENTE'`) un posteo cuya url sea de otra red
según `platformForUrl` (`src/platforms/urlPlatform.js`, sin dependencias
porque lo requiere db.js). El ciclo atrapa ese error, loguea `descartado` y
sigue. Dominio desconocido = null, nunca "instagram por defecto". El
análisis de publicación valida con `checkAnalyzeUrl(url, plataforma)` del
mismo módulo antes de llamar a Apify/Grok: otra red → 400 "Esta sección
solo analiza publicaciones de <red>"; el cliente repite solo el chequeo de
dominio. Ignorar y corregir sentimiento van por id Y plataforma
(`db.ignorePost`, `db.updateSentiment`: 404 desde otra solapa; sin
plataforma tiran). Ninguna función por plataforma tiene default a
`'instagram'` (db, monitor, accountStats, `runActorSync`): sin ella tiran
"falta plataforma", y `/api/monitoring/*` responde 400 salvo en `/status`,
`/progress`, `/counts` y `/costs`. Al sumar una función nueva por
plataforma: parámetro obligatorio, sin default.

## Datos que no se tocan

- `detected_posts.id` es el id numérico de Instagram y `url` es
  `/p/{code}/`: iguales en los dos actores (verificado contra una corrida
  real, fixtures en `test/fixtures/apidojo/`); el dedupe y el refresco de
  métricas cruzan por ahí. `post_type` es `reel` | `imagen` | `carrusel` |
  null, los mismos valores de `account_stats`.
- El módulo de X (`src/platforms/x.js`, `src/x/`) y el análisis de
  publicación quedaron fuera de la migración de actor.
