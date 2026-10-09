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
- Scripts sueltos, pruebas a mano y revisiones (de una persona o de un
  agente) trabajan con una COPIA de la base fuera del repo, nunca con
  `data/monitoring.db`, y sin `require` de módulos que la abran:
  `src/db.js` la abre en escritura y corre sus migraciones apenas se lo
  carga, y lo cargan otros módulos de `src/` (por ejemplo
  `src/accountStats.js`). Para usar código del backend, fijar
  `MONITORING_DB_PATH` a la copia ANTES del `require`, como hacen los tests.
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

## Fuentes de detección de Instagram (`config/monitoring.json`, sección `instagram`)

Desde septiembre 2026 **lo único que busca publicaciones nuevas en Instagram
es `searches`** (la lupita: búsqueda por palabra clave nativa, solo con
apidojo, `scrapeSearch`; una consulta cobrada por término y por ciclo;
`sourceType 'search'`, motivo `Búsqueda: <término>`; con `IG_ACTOR=apify` se
ignoran con aviso y no se detecta nada). Ventana DINÁMICA
(`monitor.detectionWindowFor`): sin corrida previa, `MONITOR_LOOKBACK` (1
día); con corrida previa, desde el fin de la última detección exitosa de esa
plataforma (`detection_last_success:<id>` en `refresh_state`), techo
`MONITOR_LOOKBACK_MAX` (30 días). Si la ventana supera 1 día,
`SEARCH_RESULTS_LIMIT` (y en X los topes de cuentas/hashtags) sube
proporcionalmente (tope 10x): el excedente sobre los 20 incluidos se paga
(0,0005 c/u), no se corta; si una búsqueda igual llena su `maxItems`, el
adapter apidojo lo avisa por log. `accounts` (cuentas trackeadas) y
`keywords` (con o sin `#`) NO se consultan en la detección: son guía para el
clasificador (pista de cuenta trackeada / coincidencia literal, ver
"Clasificación con contexto"). Lo declara el adapter en
`capabilities.detectAccounts` / `detectHashtags` (Instagram: false; X: true,
allá cada cuenta es `from:handle` y cada keyword o hashtag una búsqueda de
Grok); el orquestador decide por ahí, nunca por el nombre de la red. Un
resultado de búsqueda sin caption (ni después del detalle) se descarta. El
benchmark sigue igual: trabaja sobre las cuentas que aparecen en
`detected_posts`, con consultas de perfil (`scrapeAccount` sigue existiendo
para eso, para validar cuentas al agregarlas y para el refresco en modo
perfil). El refresco de métricas pide cada publicación vencida por su URL al
actor oficial (ver "Refresco de métricas por URL").

Relevancia y dedupe viven en `src/monitor.js` (`evaluateRelevance`; si un
posteo llega por varias fuentes gana `keyword` (X) > `account` > `hashtag`
= `search`). Los seguidores vienen en los posteos de perfil de apidojo
(`owner.followerCount`, solo en consultas de perfil) y actualizan
`account_followers` y los posteos ya guardados de esa cuenta en cualquier
fase (`monitor.rememberFollowers`; antes solo el benchmark propagaba). Ese
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
(100; 0 lo apaga; los más nuevos primero, el resto al ciclo siguiente solo
si la búsqueda lo vuelve a traer: por eso es holgado).
`search_seen` anota lo ya pagado (`guardado` | `descartado` | `sin_caption`
| `sin_detalle`): un descartado no se vuelve a consultar ni a evaluar; se
purga a los 30 días. Si el run falla entero no se anota nada.

## Modelo de costo (`src/apifyCost.js`)

- `apify/instagram-scraper` cobra **por resultado devuelto** (items de error
  incluidos): `APIFY_RATE_{FREE,STARTER,SCALE}` por 1000 y `APIFY_PLAN`. El
  detalle de resultados de búsqueda queda registrado con este actor,
  `query_type` `post`, fase `busqueda`; el refresco de métricas por URL,
  con `query_type` `post`, fase `refresco`.
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
  (monitoreo · busqueda · benchmark · refresco)`, `npm run costo`,
  `npm run gastos` (`scripts/gastos.js`: por corrida, por corrida y fase,
  por término de búsqueda y total; `--desde "AAAA-MM-DD HH:MM"` en hora de
  Argentina, default últimas 24 h; abre la base en solo lectura) y
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
Las fases de fotos son la excepción al porcentaje: se anuncian con su
contador pero `startPhase(..., { countsInPercent: false })` las deja fuera
del total global (si no, la barra volvía de 100 % a la mitad al final del
ciclo); `tick(n, { ok: null })` avanza sin contar como bien ni como error.

`refreshStaleAccountStats` y `refreshPostMetrics` también lanzan sus
cuentas (el refresco por URL, sus lotes de URLs) con `Promise.allSettled`,
cada uno a través de SU PROPIO limitador
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

## Refresco de métricas por URL (`src/metricsRefresh.js`)

Desde octubre 2026 el refresco de likes/comentarios de los posteos ya
guardados va **por publicación**, no por cuenta: `REFRESH_MODE=url`
(default, `src/refreshMode.js`; un valor desconocido aborta el arranque como
`IG_ACTOR`) pide cada posteo vencido por su URL `/p/<code>/` a
`instagram.fetchPostDetails` (SIEMPRE `apify/instagram-scraper`, 0,0023 por
posteo), en lotes de hasta 100 URLs por run (constante
`REFRESH_URLS_PER_RUN`: el endpoint sincrónico corta a los 300 s) lanzados
con `refreshLimiter`. `REFRESH_MODE=perfil` es el camino anterior intacto
(`scrapeAccount` por cuenta, `MAX_ACCOUNTS_PER_REFRESH`,
`BENCHMARK_POST_LIMIT`): el rollback es un cambio de `.env`. Por qué: por
perfil, tres de cada cuatro posteos se pagaban sin actualizarse (un posteo
de 2 a 7 días de un medio que publica mucho ya no está entre los últimos 15
del perfil). SDD en `openspec/changes/refresco-url/`.

- Mismos tramos y cadencias (`REFRESH_HOT_HOURS` 48 h con
  `REFRESH_HOT_EVERY_HOURS` 12 h; tibio hasta `REFRESH_WARM_DAYS` 7 d con
  marca `warm_last_pass_at` cada `REFRESH_WARM_EVERY_HOURS` 24 h; frío hasta
  `REFRESH_COLD_MAX_DAYS` 60 d con `cold_last_pass_at` cada
  `REFRESH_COLD_EVERY_DAYS` 7 d; más viejo, congelado), decididos por
  publicación con `db.listPostsDueForRefresh`: la cadencia se mide desde
  `metrics_updated_at` o, si nunca se refrescó, desde `detected_at` (un
  posteo recién detectado ya trae las métricas del detalle: entra a las 12 h,
  no en el mismo ciclo).
- Cola por tramo (caliente, tibio, frío) y, dentro de cada tramo, lo más
  atrasado primero. Tope `REFRESH_MAX_POSTS` (150) por ciclo; lo que no entra
  queda para el siguiente y las marcas de pase NO avanzan si quedó algo
  afuera, un run falló o se cortó por cuota (igual que antes).
- Solo URLs con código (`monitor.postCodeOf`: `/p/`, `/reel/`, `/reels/`,
  `/tv/`); nunca una URL armada con el id numérico (el actor no la acepta).
  La respuesta se cruza por id y, de respaldo, por el código de la URL. Las
  cuentas que el benchmark acaba de pasar se excluyen (`skipAccounts`).
- Regla única de métricas (`db.keepIfMissing`, en `applyMetricsRefresh` y
  `updatePostMetricsIfChanged`): un valor ausente, null o negativo NUNCA pisa
  lo guardado de ese campo, aunque el otro sí venga; solo un número >= 0
  pisa; `metrics_updated_at` avanza igual. El adapter apidojo deja likes en
  null con `isLikeAndViewCountsDisabled`; el oficial ya mapea -1 a null.
- Borrados o privados: si el run terminó bien y un posteo pedido no volvió,
  `db.registerRefreshMiss` suma 1 a `detected_posts.refresh_misses`; al
  `REFRESH_MISSES_TO_STOP` (2) seguido escribe `refresh_stopped_at` y el
  posteo deja de pedirse, con línea de log (cuenta y URL). Una respuesta
  válida por cualquier camino lo reanuda. Un run caído no suma. Sus métricas
  quedan en el último valor conocido.
- Likes null en la tabla de Monitoreo: es "sin dato", nunca 0. La celda
  muestra "—" (`formatCount` en `public/js/monitoring.js`);
  `accountStats.classifyValue` lo deja `sin-referencia` con `reason`
  (`sin-dato` falta el valor de ese posteo | `muestra-chica` | `sin-mediana`
  la cuenta no trae esa métrica) y el panel de detalle muestra ese motivo;
  `median` ignora los null. El destacado de "Se despegaron" lo calcula el
  backend (`benchmark.top`, `accountStats.highlightOf`) entre las métricas
  con referencia: un posteo con likes ocultos se destaca igual por sus
  comentarios. Test: `test/likesNull.test.js`.
- Seguidores: por URL no llegan (el actor oficial no los trae por posteo);
  los sigue trayendo el benchmark (`BENCHMARK_RECALC_DAYS`) y la validación
  de cuentas. Nada más dependía del refresco para eso.
- Costo: sale solo por `runActorSync` (actor oficial, fase `refresco`,
  `query_type` `post`); `npm run gastos` y `npm run costo` lo muestran sin
  cambios. Con las corridas reales #17 a #32: 3,27 usd por perfil contra
  1,52 por URL como techo.
- Solo plataformas con `capabilities.metricsRefresh` y `fetchPostDetails`
  (X no tiene ninguna: no se toca). Tests: `test/refreshPorUrl.test.js`,
  `test/refreshPorUrlLotes.test.js`, `test/metricasConservadas.test.js`; los
  del camino perfil (`refreshTramos`, `parallelRefresh`) fijan
  `REFRESH_MODE=perfil`.

## Diagnóstico del ciclo (siempre activo, sin flag de DEBUG)

`[ciclo] inicio`/`fin` (scheduler.js), `[fase] arranca`/`termina` con N
ok/N error (monitoringProgress.js), `[apify] →`/`←` por llamada real y
`[limiter:<nombre>]` al esperar/adquirir/liberar cupo (concurrencyLimiter.js)
quedan siempre en consola. Si pasan 15s sin que termine ninguna llamada
mientras un ciclo está en curso, `[heartbeat]` (scheduler.js) loguea la
fase actual y qué target tiene cada tarea activa en `apifyLimiter`,
`benchmarkLimiter` y `refreshLimiter`. `APIFY_CALL_TIMEOUT_MS` (default
300000, piso 1000; una llamada cortada se cobra igual y pierde sus
resultados, por eso es holgado) corta cada llamada a Apify que no respondió
a tiempo, libera su cupo y la deja en `apify_calls` con `error='TIMEOUT'`.

## Máquina despierta (Windows)

Al arrancar, `server.js` llama a `startKeepAwake` (`src/keepAwake.js`): en
Windows lanza un PowerShell hijo, `scripts/keep-awake.ps1`, que pide
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
ES_DISPLAY_REQUIRED)` sin permisos de administrador y se queda leyendo su
stdin (pipe): cuando el server muere, el pipe se cierra y el hijo sale
solo. `KEEP_AWAKE=0` lo apaga; fuera de Windows no hace nada; nunca tira.
Los tests inyectan `spawnFn` y nunca lanzan PowerShell. Para dejar la app
sola varios días: `scripts/iniciar-con-reinicio.bat` (reinicio automático,
log en `logs/`, QuickEdit apagado).

## Clasificación con contexto (LLM del monitoreo)

`src/classifier.js` tiene UNA función, `clasificarPosteo(caption, {
platformLabel, pista })`: una llamada con schema
(`llm.requestStructuredAnalysis`, `maxTokens` 300, `timeoutMs` 60000) que
devuelve `relevant`, `title`, `sentiment` y `motivo`, con el modelo de
análisis. En `openrouterProvider.js` toda request lleva timeout (default
5 min; el clasificador pasa 60 s) y un fallo transitorio (429, 408, 5xx,
red, timeout) se reintenta UNA vez a los 3 s (`LLM_RETRY_DELAY_MS` solo para
tests); 400/401/402 no. Con Anthropic el timeout va al SDK, que ya
reintenta solo. No hay modelo
clasificador aparte: `CLASSIFIER_MODEL` / `OPENROUTER_CLASSIFIER_MODEL` no
existen (si están en el `.env`, `warnObsoleteModelVars` avisa al arrancar);
`requestText` (reclamos, importador) usa el mismo modelo. La coincidencia
literal con una keyword NO da relevancia: `evaluateRelevance` la manda como
`pista.termino` (junto con `cuenta`, `hashtag`, `busqueda`) en la línea
`CONTEXTO:` del mensaje de usuario, y decide por `relevant`. El system prompt
es fijo y desambigua geografía: "Jefe de Gobierno" es también el de la
Ciudad de México; PDLC, "gobierno de la ciudad", alcalde, intendente solo
valen en contexto porteño; las señales de alerta (figuras de CDMX, Colombia,
España, Chile) no descartan por sí solas; se descarta Mauricio Macri sin
Jorge ni gestión porteña, la política nacional argentina que no toque a
Jorge Macri ni a la Ciudad, y la Provincia sin la Ciudad; la cuenta
trackeada es señal débil. Fallo del LLM o respuesta fuera del schema →
`unclassified` → se guarda sin clasificar (`— sin clasificar (falló el
clasificador, relevancia sin verificar)`), nunca descarte silencioso;
`relevant: false` sí descarta y se loguea `[clasificador] descartado (<red>)
@cuenta <url>: <motivo>`. `matched_reason` = motivo base + ` · <motivo>`. X
en stand by: `sourceType 'keyword'` entra directo (título y sentimiento,
`relevant` ignorado, sin motivo). El backfill completa título, sentimiento y
motivo y no borra: si el modelo dice no relevante, deja `no relevante según
el modelo: <motivo>`. Los tests stubean `llm.requestStructuredAnalysis` (por
el objeto del módulo) o `classifier.clasificarPosteo`; nunca el modelo real.

## Vista Feed del Monitoreo (solo Instagram)

La solapa "Monitoreo en vivo" de Instagram tiene dos vistas, Tabla y Feed
(tarjetas), con un interruptor que recuerda la última en `localStorage`
(`sl.monitoreo.vista`, con try/catch). El feed es
`public/js/monitoringFeed.js`: lo carga SOLO `instagram.html`, después de
`monitoring.js` (scripts clásicos, mismo ámbito global: todo lo suyo lleva
prefijo `feed` / `FEED_`); `x.html` no lo carga y no cambia. No tiene
datos propios ni filtro propio: dibuja las filas que la tabla ya filtró
(`monitoringTable.getData('active')`; la tabla filtra en `applyFilters` con
`postMatchesFilters(post, readFilterValues())`), así el feed, la tabla y el
contador muestran siempre el mismo conjunto. Al cambiar un filtro, el orden
o la vista con la página bajada, los resultados se muestran desde el
principio (`feedScrollToStart`). Un filtro nuevo va en ese predicado; si su
control existe solo en `instagram.html` (como `fAlcanceEl`), en X es null y
hay que tratarlo así. `monitoring.js` avisa los cambios con
`notifyMonitoringViews(change)` (sin argumento = redibujar;
`{ ignoredId }`; `{ goToId }` desde "Se despegaron"). El alcance de la
tarjeta y del filtro "Alcance" es `postReach`: combina los niveles que ya
manda el backend en `benchmark.likes` y `benchmark.comments` (vale el
mejor de los dos; "normal" se muestra "medio"; sin ninguna métrica con
referencia no hay etiqueta) y no recalcula nada. Todo dato del posteo entra
por `textContent`, nunca como HTML. Son cientos de tarjetas sin paginar: el
redibujo es completo, con espera de 150 ms y `content-visibility: auto`.
Toda la tarjeta abre un pop-up con el posteo completo: un clic en cualquier
parte, o Enter / Espacio con el foco en ella (`tabindex="0"`, aro de foco
visible). No lo abren sus controles (`FEED_CARD_CONTROLS`: la ✕ de ignorar,
el selector de sentimiento, "Abrir ↗") ni soltar el mouse después de marcar
texto (`feedSelectingIn`); un control nuevo en la tarjeta tiene que entrar
en esa lista. Ya no hay botón "Ver más". El pop-up es
`public/js/monitoringFeedPopup.js` (también solo `instagram.html`, después
del feed; prefijo `feedPop`), un `<dialog>` que se rellena con la fila de
Tabulator, recorre las tarjetas en pantalla (← →) y usa `updateSentiment` y
`confirmIgnore` tal como están; el feed le avisa los cambios de la lista con
`feedListListeners`; al cerrarse devuelve el foco a la tarjeta. La foto
llega en `image` del listado (ver "Fotos de los posteos") y el frontend la
lee solo en `feedImageUrl` (tarjeta, miniatura), `feedPopImageUrl` (pop-up,
imagen grande) y `feedImageFailed`: sin intento de descarga, "Sin foto" en
los dos; descarga fallida o copia que no carga, "Imagen no disponible" en
los dos. En la tarjeta el recuadro de la foto es siempre un cuadrado del
ancho de la tarjeta con fondo negro, y la foto va entera
(`object-fit: contain`), sin recorte. Debajo va solo el título: el texto del
posteo no se muestra en la tarjeta, se lee entero en el pop-up. Likes y
comentarios van en una franja propia, en grande; el selector de sentimiento
está en el pie. El hover
(sube, borde del color del sentimiento, foto que se acerca) va solo con
mouse (`hover: hover`) y el movimiento se apaga con
`prefers-reduced-motion`.
Maquetas aprobadas en `design/monitoreo-feed.html` y
`design/monitoreo-popup.html`; SDD en `openspec/changes/monitoreo-feed/` y
`openspec/changes/monitoreo-popup/`. La suite no cubre el frontend: se
prueba en el navegador con un servidor de prueba aparte (otro puerto, copia
de la base, sin scheduler ni Apify).

## Fotos de los posteos (solo Instagram)

Por posteo se guardan dos JPEG hechos de UNA descarga:
`data/media/<plataforma>/<id>_thumb.jpg` (360 px de ancho) y `<id>_full.jpg`
(900 px de lado largo). Reel = portada, carrusel = primera imagen, nunca
videos. SDD en `openspec/changes/monitoreo-fotos/`.

- **Cero pedidos nuevos a Apify.** El link (`imageUrl` del posteo
  normalizado de los dos adapters) sale de respuestas que ya se piden: el
  detalle al guardar un posteo NUEVO (`monitor.js`) y el refresco por URL
  (`metricsRefresh.js`), que completa los ya guardados. Sin link en la
  respuesta, el posteo queda sin foto; un posteo conocido que reaparece en
  la detección no baja nada. Con `REFRESH_MODE=perfil` el refresco NO baja
  fotos (solo posteos nuevos y reintentos).
- `src/postImages.js` baja y arma las copias con `sharp`; no conoce la base
  y NUNCA tira. Reglas: `https`, hosts de `IMAGE_HOSTS` por plataforma (sin
  lista no baja: no hay default), sin redirecciones, `image/*`, solo JPEG,
  PNG o WebP reconocidos por sus primeros bytes ANTES de pasárselos a
  `sharp` (que también abre SVG, GIF, TIFF, AVIF), hasta
  `MAX_INPUT_PIXELS` (12 MP), 15 MB, 15 s, `imageLimiter` propio (3 a la
  vez; nunca el `apifyLimiter`). Las copias van a un temporal y se renombran
  con las dos listas: un fallo no pisa lo guardado. En los logs va el host,
  nunca el link firmado.
- La tanda (`savePostImages`) se corta a las 5 fotos SEGUIDAS con fallo,
  del tipo que sea (red, servidor, disco, o que quien llama no pudo anotar:
  `onResult` devuelve false), contadas en el orden de la lista entre las que
  ya terminaron (no espera a una descarga colgada), y tiene un tope de 2
  minutos (`BATCH_TIMEOUT_MS`). Los resultados llevan `retry`: fallo
  pasajero (red, tope de tiempo, 5xx/429/408, disco) o propio del link o de
  la imagen.
- `src/postImageSync.js` es el enganche con el ciclo: baja solo lo que falta
  (marca en la base Y archivos en disco), anota CADA foto apenas termina
  (`db.markPostImageSaved` / `markPostImageFailed` / `markPostImagePending`,
  por id y plataforma), anuncia la fase "Guardando fotos" y junta el resumen
  que imprime el scheduler, una línea por ciclo. Una foto no frena un ciclo.
- **Pendientes.** Lo que no se llegó a intentar (corte, tope de tiempo) o
  falló con `retry` queda `pendiente` con su link. Al EMPEZAR cada ciclo,
  antes de la detección, `retryPendingPostImages` (lo llama el scheduler)
  las reintenta con el link guardado, sin Apify: hasta 150, las más
  recientes primero, y ahí un link vencido no cuenta para el corte
  (`cutOnExpired: false`). `vencido` y `error` no se reintentan con el mismo
  link: esperan el próximo refresco.
- Columnas de `detected_posts`: `image_source_url`, `image_status` (`ok` |
  `vencido` | `error` | `pendiente` | null), `image_saved_at` (lo ÚNICO que
  decide si hay foto; un fallo no lo toca), `image_width`, `image_height`
  (guardadas, sin uso en el frontend). Para el frontend `pendiente` es un
  posteo todavía sin foto, no una foto fallida.
- `src/postImageRoutes.js`: `GET /api/monitoring/posts/:id/image?plataforma=&size=thumb|full`
  (detrás del login; el archivo se arma con datos de la base, nunca con texto
  del pedido) y `withImage`, que pone `image: { thumbUrl, fullUrl, status,
  width, height }` en el listado y saca las columnas crudas: el link
  original no va al navegador. `image: null` en una plataforma sin fotos.
- `POST_IMAGES=0` apaga las descargas y los reintentos, y no anota nada;
  lo guardado se sigue sirviendo. Si
  `sharp` no carga, la app arranca igual, sin fotos.
- Tests (`test/postImages*.test.js`): `fetch` simulado, imágenes generadas
  con `sharp` y `MONITORING_MEDIA_DIR` (solo para tests) en una carpeta
  temporal, fijado antes de los `require`. Ninguno toca `data/media`.

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
  métricas cruzan por ahí (el refresco por URL, por id y de respaldo por el
  código de la URL). `post_type` es `reel` | `imagen` | `carrusel` |
  null, los mismos valores de `account_stats`.
- El módulo de X (`src/platforms/x.js`, `src/x/`) y el análisis de
  publicación quedaron fuera de la migración de actor. X está en stand by:
  el cron corre solo `MONITOR_PLATFORMS` (default `instagram`;
  `scheduler.cronPlatforms`, ids desconocidos se ignoran con aviso), y con
  `trigger: 'cron'` `runMonitoringCycle` nunca tira un error de plataforma
  aunque la lista tenga una sola (lo anota en `porPlataforma`). "Actualizar
  ahora" en la solapa X sigue corriendo X (`trigger` manual). No borrar el
  código de X.
