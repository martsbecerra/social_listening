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
  `validacion`, `recalc-script`, `analisis`, `fotos` (la carga única de
  `scripts/cargar-fotos.js`).
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
`/api/monitoring`) expone `getView()`: con un ciclo en curso, `{ phase,
done, total, suffix, percent, lines }`; terminado, `{ finished: true, lines
}` hasta que arranque otro (la última fase cierra su resumen recién en
`endCycle`); `null` si nunca corrió ninguno. `getProgress()` no cambió
(estado del ciclo en curso, `null` sin ciclo): lo usa el aviso de ciclo
trabado. El frontend lo consulta cada 1,5s mientras espera "Actualizar
ahora" — ya no hay frases fijas ni barra simulada. Cuentas, hashtags,
búsquedas y keywords se lanzan juntas (`Promise.allSettled`) y se muestran
como una sola fase combinada ("Buscando posteos nuevos", contador "N de 8
listas": van en paralelo, no hay "la actual"); una fase sin trabajo para
esa plataforma (ej. benchmark en X) nunca se anuncia, sin casos especiales
por plataforma.

`lines` son las líneas de la lista del recuadro, ya escritas para una
persona y ya elegidas (hasta `VIEW_MAX_LINES` 6; lo que está en curso ocupa
como mucho `VIEW_MAX_RUNNING` 3: las primeras y "y N más"): el frontend
solo las dibuja, por `textContent`. Las arma el ciclo: `startItem` /
`finishItem` por cada fuente de la detección (`monitor.js`, `trackSource`:
"«macri» · 50 encontrados, 6 nuevos" o "· falló") y `setPhaseSummary` por
cada fase al terminar su trabajo y ANTES de que arranque la siguiente
(relevancia, detalle, benchmark, métricas, fotos); sin resumen propio sale
uno genérico con el contador, y `startPhase(..., { summary: false })` no
deja ninguno. Una fase nueva tiene que dejar el suyo. "Nuevo" es una sola
cosa en toda la pantalla (`monitor.isNewPost`: ni en `detected_posts` ni en
`search_seen`); el ciclo lo cuenta sin repetidos, antes del detalle, en
`porPlataforma.<red>.newCandidates` (el scheduler guarda la suma en
`monitoring_runs.new_candidates`, ver "Diseño v4"), y el recuadro cierra con
"✓ Corrida terminada · HH:MM · duración" y la línea "Resultado · N
relevantes guardados de M nuevos"; se va solo a los 9 s (con un error queda
hasta "Ocultar"). SDD en `openspec/changes/monitoreo-progreso-lista/`.
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
  comentarios (ver "Alcance: la regla del colchón"). Test:
  `test/likesNull.test.js`.
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

## Alcance: la regla del colchón (`src/reachRule.js`)

Desde octubre 2026 el nivel de likes y de comentarios de un posteo contra
la mediana de su cuenta (`accountStats.classifyValue`) sale de
`src/reachRule.js`, un módulo sin dependencias (no carga la base). SDD en
`openspec/changes/alcance-colchon/`.

- `ratio` = (valor + colchón) / (mediana de la cuenta + colchón). **No es
  valor / mediana**: nada que lo muestre puede decir "N veces lo habitual".
  `alto`: ratio >= `REACH_HIGH_RATIO` (1.5) Y valor >= piso. `normal` (en
  pantalla "medio"): ratio >= `REACH_MID_RATIO` (1.1). `bajo`: el resto, y
  quiere decir "no se despega de lo normal de su cuenta", no "le fue mal"
  (es la mayoría de los posteos).
- Likes: `REACH_LIKES_CUSHION` 2000 y `REACH_LIKES_FLOOR` 1000.
  Comentarios: `REACH_COMMENTS_CUSHION` 300 y `REACH_COMMENTS_FLOOR` 150.
  Los seis números salen del `.env` con esos valores por defecto y se leen
  una vez, al cargar `accountStats.js` (`REACH_RULE`). Colchones y pisos:
  enteros sin separador de miles (`2.000` se rechaza: se leería como 2);
  los cortes aceptan coma decimal y el de medio tiene que ser menor que el
  de alto. Un valor mal escrito tira con `userMessage` y `server.js` lo
  valida al arrancar, como `IG_ACTOR` y `REFRESH_MODE`; una línea del
  arranque muestra los números en uso.
- Cada métrica del `benchmark` lleva `ratio`, `cushion` y `floor` además de
  `value` y `median`, para que la pantalla diga con qué se calculó.
  `benchmark.top` (`highlightOf`) es la métrica que decide: la de mejor
  nivel y, a igual nivel, la de mayor razón (empate: comentarios), con su
  `level`. "Se despegaron" muestra los `top.level === 'alto'`: el frontend
  no conoce ningún corte. No alcanza con mirar la razón: una métrica puede
  pasar el corte de alto sin llegar a su piso.
- El alcance se calcula al armar el listado (`server.js`), no se guarda:
  cambiar un número del `.env` vale desde el próximo arranque, sin
  recalcular nada. Las medianas (`account_stats`) no cambian.
- En pantalla (`public/js/monitoring.js`): `formatBenchmarkRatio` muestra
  dos decimales CORTADOS, no redondeados (un 1,096 diría "1,10" al lado de
  "Alcance bajo"); `benchmarkRatioBasis` arma el "229 contra una mediana de
  21 en la cuenta, con colchón de 2.000" que acompaña a la razón.
- Tests: `test/reachRule.test.js` (puro: colchón, piso, mediana 0, bordes
  1,09 / 1,10 / 1,50 y lectura del `.env`), `test/accountStats.test.js` y
  `test/likesNull.test.js`, que borran las `REACH_*` del entorno antes de
  los `require` para correr con los valores por defecto.

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
devuelve `relevant`, `title`, `sentiment`, `tema` y `motivo`, con el modelo
de análisis. En `openrouterProvider.js` toda request lleva timeout (default
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
`relevant` ignorado, sin motivo). Los tests stubean
`llm.requestStructuredAnalysis` (por el objeto del módulo) o
`classifier.clasificarPosteo`; nunca el modelo real.

**Tema** (para Estadísticas, desde octubre 2026): es una categoría de
primer nivel del mapa de reclamos, `config/categorias-reclamos.json` vía
`src/categoriasConfig.js` (26 hoy), el mismo texto que `reclamos.categoria`:
el tema de un posteo y la categoría de un reclamo hablan el mismo idioma.
NO hay enum ni mapa de nombres propio: el enum del schema (`TEMAS`) y la
sección TEMA del system prompt (una línea por categoría con sus
subcategorías, tal cual del JSON) se arman al cargar, como en
`analysisSchema.js` / `prompt.js`; Estadísticas muestra los nombres del
JSON. Esa sección suma unos 5.700 caracteres (~1.500 tokens) de entrada por
clasificación. Se pide siempre, también con `relevant: false`. Lo que
devuelve el modelo pasa por `normalizeClasificacion` (acentos, mayúsculas y
alias; lo que no existe o falta → "Coyuntura / Otros", con aviso
`[categorias]`); caption vacío → "Coyuntura / Otros" sin llamar al modelo.
Fallo o schema roto → `tema` null, como `title` y `sentiment`. Se guarda en
`detected_posts.tema` (TEXT, anulable, sin CHECK); null es "sin dato" (la
sección Estadísticas, cuando exista, lo va a contar como "Coyuntura /
Otros").

**Backfill** (`POST /api/monitoring/backfill-classification`,
`monitor.backfillClassification`): levanta los posteos no ignorados de la
plataforma sin título O sin tema (`db.listUnclassified`). A los sin título
les completa título, sentimiento, tema y motivo y no borra: si el modelo
dice no relevante, deja `no relevante según el modelo: <motivo>`. A los ya
clasificados sin tema les completa SOLO el tema (`db.updateTema`, que no
pisa uno guardado), sin tocar título, sentimiento ni `matched_reason`. Una
llamada al LLM por posteo, de a una (avance por consola cada 50); devuelve
`{ classified, temasCompletados, stillPending }`. Lo corre el dueño, nunca
un agente: cuesta una clasificación por posteo pendiente.

## Diseño v4

Desde octubre 2026 el frontend se rehace sobre UNA maqueta,
`design/social-listening-v4.html` (login, inicio y las cuatro solapas; la
barrita "maqueta" de abajo a la derecha no va en la app). Cinco fases, una
rama y un PR por fase: A `sistema-visual-v4` (el marco en todas las
páginas), B `monitoreo-v4`, C `estadisticas`, D `inicio-y-login`, E
`analisis-v4`. El estado anterior (riel, radar y las maquetas viejas) quedó
en el tag `v3-riel-radar`. SDD de la fase A en
`openspec/changes/sistema-visual-v4/`; de la B, en
`openspec/changes/monitoreo-v4/`.

- **Sistema visual** (`public/css/styles.css`, en tres partes comentadas):
  1) los tokens y componentes de la maqueta tal cual (`--bg`, `--surface`,
  `--accent`, `--glow`, `--pos`/`--neu`/`--neg`, `--c1`…`--c5`; `.card`,
  `.chip`, `.kpi`, `.seg`, `.btn`, `.field`, `.tip`; `rise` escalonado por
  `.rv`, `fadeIn`, `pop`, `slideIn`, `ping`, `draw`), con Sora, IBM Plex
  Sans e IBM Plex Mono de Google Fonts; 2) el marco; 3) los componentes de
  la app: el Monitoreo de la maqueta (`.mon`, `.srcbox`, `.flowcard`/`.fl`,
  `.pipe`, `.al`, `.fbar`, `.combo`, `.fstatus`, `.ups`/`.up`, `.reach`) y,
  con los mismos tokens, lo que la maqueta no dibuja o que todavía no se
  rehizo (progreso, Tabulator, feed, pop-up, modales, análisis, mapa,
  inicio, login, el Monitoreo de X). Todo color sale de los tokens: los únicos sueltos son los de marca de cada
  red, los de las categorías del mapa y el negro de las fotos. Los tokens
  viejos (`--jade-*`, `--clay-*`, `--coral-*`) ya no existen. No hay estilo
  global de `<button>`: cada botón lleva su clase (`.btn`, `.btn.primary`,
  `.btn-small`, `.btn-ghost`…). `--warn-ink` es el ámbar legible del tono
  neutral; `--top`, el alto real de la barra superior.
- **Tema** (`public/js/theme.js`, en el `<head>` de las cinco páginas,
  antes de pintar): la app arranca SIEMPRE clara, aunque el sistema esté en
  oscuro (decisión del dueño; la maqueta lo tomaba del sistema). El botón
  `[data-theme-toggle]` de la barra superior (luna / sol) la pasa a oscura;
  `theme.js` marca SIEMPRE `data-theme="light"` o `"dark"` en `<html>`
  (nunca lo deja vacío) y la elección queda en `localStorage`
  (`sl.tema`: `oscuro` | `claro`, con try/catch; sin almacenamiento vale la
  clara). El login no tiene botón pero respeta lo elegido. Los valores
  oscuros son los de la maqueta (`:root[data-theme="dark"]`); no hay
  `prefers-color-scheme` en styles.css.
- **Barra superior** (`header.top`, igual en `instagram.html`, `x.html` y,
  sin solapas, `dashboard.html`): marca (vuelve al inicio), la píldora de
  solapas, el selector de plataforma (va al inicio), el estado de la
  escucha, el botón de tema y el usuario (iniciales solas por debajo de
  980 px). Queda fija arriba solo en escritorio: por debajo de 900 px (dos
  o tres renglones) va en su lugar, como la barra de filtros; por debajo de
  560 px la plataforma muestra solo su cuadradito de color y la píldora,
  que se desplaza de costado, deja a la vista la solapa elegida. `main.js`:
  `openTab` marca `aria-selected` y corre la pastilla (`.pill`), muestra el
  `.tab-panel` (`#tab-<nombre>`, con `hidden`) y repite las `.rv`; el hash
  sigue siendo `#tab-monitoring` / `#tab-claims-map` / `#tab-analysis`.
  Teclas 1-4 (el número de la solapa; no mientras se escribe ni con un
  pop-up o modal abierto) y ← → con el foco en la píldora. Estadísticas va
  con `aria-disabled` y "pronto" hasta la fase C. X: Monitoreo, Mapa y
  Análisis, sin Estadísticas, y abre en Análisis. `main.js` también mide
  `--top` y atiende `#fuentes-busquedas` / `-cuentas` / `-palabras` /
  `-hashtags` (abre el Monitoreo, baja a esa caja, abre su campo de agregar
  con `panelOpenAdd` y lo enfoca; al cargar la página, recién en `load` y
  sin animación, y durante 8 s `holdSourceBox` la vuelve a poner arriba si
  se movió, porque el panel se dibuja después del `load`; lo suelta la
  rueda, un toque, un clic o una tecla fuera de la caja).
- **Estado de la escucha** (`public/js/topbar.js`): la hora de la última
  corrida TERMINADA (`GET /api/monitoring/status`, `lastRunAt`): de esa
  plataforma en `instagram.html` y `x.html` (`db.getLastFinishedRunAt`); en
  el inicio, de cualquiera (`db.getLastFinishedRunAtAny`). Hace menos de 5 h:
  verde, "escuchando · 16:02"; más vieja: gris, "última corrida · 21/10
  08:03"; ninguna: "todavía no corrió"; sin respuesta, "—" (nunca una hora
  inventada). Hora de Argentina por `Intl`. Se pide cada 5 min y con
  `{ run: 'end' }` de `notifyMonitoringViews`; el color se recalcula cada
  minuto.
- **Tooltip** (`public/js/tip.js`): cualquier elemento con `data-tip` (y
  `data-tip-title`) lo muestra al pasar el mouse o al enfocarlo; "\n" corta
  renglones. Todo por `textContent`, nunca HTML.
- **Pie** (`public/js/footer.js`, en `#siteFooter` de las tres páginas con
  sesión): marca, texto de la Dirección General de Análisis y Datos (DGAYD,
  nunca "DGAND"), "4 corridas por día · 8, 12, 16 y 20 h" desde `runHours`
  y `corridasPorDia` de `/api/footer-stats` (sin dato, la línea no sale),
  columnas Secciones / Fuentes / Plataformas / Cuenta y la línea final.
  Estadísticas, Facebook y TikTok van "· pronto", sin enlace.
- **Monitoreo de Instagram** (fase B): la solapa de la maqueta, con datos
  reales y casi todo del lado del cliente sobre los posteos de la tabla
  (`monitoringTable.getData()`). X conserva su layout (solo comparte el
  recuadro de progreso).
  - **Período** (`periodSeg`): Hoy / 7 días / 30 días por `posted_at` en
    hora de Argentina ("Hoy" desde las 00:00; "7 días" desde las 00:00 de
    seis días antes; `argentinaDayStart` resta días de 24 h: Argentina no
    tiene horario de verano). En `localStorage` `sl.monitoreo.periodo`;
    sin nada, Hoy. Va dentro de `postMatchesFilters` (`periodFrom`) y
    filtra todo; el resto usa `postInPeriod` / `monitorPeriodPosts`. Sin
    publicaciones del período, `buildEmptyListLine` dice "Todavía no hay
    publicaciones de hoy · ver 7 días" (con el enlace). `monitorPeriodDays`
    es 0 en X: ahí no se filtra nada por período.
  - **Panel** (`public/js/monitoringPanel.js`, prefijo `panel`): los
    cuatro KPI con `countUp` (publicaciones con sparkline y variación contra
    el período anterior del mismo largo; tono neto sobre los clasificados,
    con anillo; "Se despegaron" con "la mayor: 15,37× en comentarios, de
    @cuenta"; conversación), los chips de búsquedas / palabras clave /
    hashtags (conteo del período y barrita de tono; búsqueda = su
    `matched_reason`, palabra o hashtag = escrita en título o texto; clic =
    filtrar la lista con `setSourceFilter`, que se ve como pastilla con ✕;
    la ✕ del chip pide "¿Sacar «x»? Sí / No" en el mismo chip; "+" abre
    `.kw-add`; 8 y 6 a la vista con "Ver las N →"), las cuentas seguidas
    (4, mismas reglas; clic elige la cuenta en el filtro), el pulso de 7
    días por hora (SVG con `createElementNS`, al ancho real, una franja por
    hora con `data-tip`), el Pipeline y las alertas de hoy (volumen ≥ 1,5 ×
    la mediana diaria de los 30 días anteriores; la que más se despegó; un
    tema con 2 o más negativas; clic = filtros + período Hoy + bajar a la
    lista). Redibuja solo si cambia la firma (período, ids, sentimiento,
    likes, comentarios); si cambia solo la fuente, solo las fuentes. Los
    hashtags son keywords con "#" (misma lista y endpoint; `addHashtag` le
    pone el "#"). Ya no hay modales "Ver todas" en Instagram.
  - **Pipeline**: `GET /api/monitoring/status?plataforma=` suma `lastRun`
    (`src/lastRun.js`: `finishedAt`, `durationSec`, `fetched` = ítems de
    las consultas de detección de esa red en la corrida, `newCandidates` =
    `monitoring_runs.new_candidates`, `saved` = `new_posts`, `highlighted` =
    guardados en la ventana de la corrida con `top.level === 'alto'`, `usd`;
    null sin corridas) y `model` (`getAnalysisModel`). La columna es
    anulable: las corridas anteriores muestran "—".
  - **Flujo en vivo** (`public/js/monitoringFlow.js`, prefijo `flow`): las
    publicaciones del período por `detected_at`, tantas como entran (la
    tarjeta `.flowcard` tiene el alto de la fila y su contenido es una capa
    absoluta: nunca crece); el término de la búsqueda va en `<mark>` armado
    con nodos (`flowFindTerm`, sin mayúsculas ni acentos). Durante una
    corrida no se redibuja; con `{ run: 'end', newIds }` las nuevas entran
    de a una con "ahora" (el primer minuto; las horas se rehacen solas cada
    30 s); con el mouse encima esperan en una cola, y un redibujo mientras
    tanto las saltea (si no, quedaban repetidas). Un término lejos del
    principio recorta el título adelante ("…de octubre GCBA").
  - **Filtros**: ocho controles con nombre en `.fbar` (Buscar, Tono,
    Alcance, Tema con `temas` de `/api/monitoring/config`, el combo de
    Cuenta `HAS_ACC_COMBO` con buscador y conteo del período, Desde, Hasta,
    Orden con "Más comentarios"). En la vista Tabla, Orden queda
    deshabilitado con el aviso en la etiqueta (un control deshabilitado no
    recibe el mouse). "Mostrando N de M publicaciones del período";
    "Limpiar filtros" (`.f-clear.on`) solo con algo puesto, y no toca el
    período. La placa vacía de Tabulator es un nodo propio
    (`tablePlaceholderEl`) que `applyFilters` tiene al día.
  - **Avisos y carga**: `notifyMonitoringViews({ config })` cuando llega
    la config (null si falló). La config y los posteos pueden llegar antes
    de que se cargue un script de los de abajo: cada uno arranca con
    `monitoringConfig` (undefined: todavía no) y `monitoringTable` si ya
    están.
  - Los colores de los temas (`temaColor`, `buildTemaTag`) son los
    `--cat-N` por el lugar del tema en la config.
- **Mapa**: mosaicos de OpenStreetMap claros también en oscuro; controles,
  leyenda, popups y tooltips de Leaflet con los tokens. Los colores de
  categoría (`--cat-1` … `--cat-12`) salen de la paleta de la maqueta, en su
  tono oscuro (el número del pin va en blanco). La tarjeta de filtros lleva
  `z-index: 3`: las dos tarjetas tienen `.rv`, cuya animación les da su
  propia capa, y sin eso el mapa tapaba los desplegables.
- **Login** (`index.html`, que es el de `/`, y `login-verify.html`):
  pantalla partida estática (marca y título sobre fondo oscuro, la tarjeta
  con el formulario del link mágico de siempre). Sin pie. La fase D suma la
  parte animada; el login SIGUE por link mágico (sin código de 6 dígitos) y
  `/api/auth/*` no cambia.
- **Favicon**: el ◎ sobre el degradé (`favicon.svg`); los PNG y el `.ico`
  salen de él con `sharp`.
- Pruebas de pantalla: servidor de prueba aparte (otro puerto, copia de la
  base, sin scheduler, sin Apify ni LLM), con capturas a 1366 y 375 px, en
  oscuro y con movimiento reducido.

## Vista Feed del Monitoreo (solo Instagram)

El Monitoreo de Instagram tiene dos vistas, Feed (tarjetas, la de por
defecto) y Tabla, con un interruptor que recuerda la última en
`localStorage` (`sl.monitoreo.vista`, con try/catch). El feed es
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
`{ ignoredId }`; `{ goToId }`, que quedó como respaldo de X; `{ config }`;
`{ run }`, para la barra superior, el panel y el flujo). El alcance de la
tarjeta y del filtro "Alcance" es `postReach`: combina los niveles que ya
manda el backend en `benchmark.likes` y `benchmark.comments` (vale el
mejor de los dos; "normal" se muestra "medio"; sin ninguna métrica con
referencia el medidor muestra "—") y no recalcula nada ni conoce ningún corte (ver
"Alcance: la regla del colchón"). El orden "Mayor alcance" va primero por
la etiqueta y, dentro de cada una, por la razón. Todo dato del posteo entra
por `textContent`, nunca como HTML. El alcance se ve con el `.reach` de la
maqueta (`buildReachMeter`: cinco barras; alto en el acento, latiendo, con
la razón; medio en ámbar; bajo gris; "—" sin referencia) en la tabla, el
feed, el flujo y "Se despegaron"; con alcance alto la foto lleva "N,NN× se
despegó". Filas completas: se dibujan 3 filas según las columnas reales de
la grilla (`feedColumns`) y, si hay más, la última celda es "+N · Ver 12
más" (`feedRows` suma otra tanda); otro filtro u orden vuelve a 3, otro
ancho con otras columnas las completa. El redibujo es completo, con espera
de 150 ms y `content-visibility: auto`; `feedVisibleIds` guarda la lista
entera (filtrada y ordenada) para el pop-up.
Toda la tarjeta abre un pop-up con el posteo completo: un clic en cualquier
parte, o Enter / Espacio con el foco en ella (`tabindex="0"`, aro de foco
visible). No lo abren sus controles (`FEED_CARD_CONTROLS`: la ✕ de ignorar,
el selector de sentimiento, "Abrir ↗") ni soltar el mouse después de marcar
texto (`feedSelectingIn`); un control nuevo en la tarjeta tiene que entrar
en esa lista. El pop-up es `public/js/monitoringFeedPopup.js` (también
solo `instagram.html`, después del feed; prefijo `feedPop`), un `<dialog>`
que recorre una LISTA de ids (`openFeedPopList(ids, id, opener)`): desde
una tarjeta, toda la del feed (`feedVisibleIds`, no solo las filas a la
vista); desde una línea del flujo, el flujo; desde una tira de "Se
despegaron" (`openHighlight`, `highlightIds`), solo las tiras. Los datos
salen siempre de la fila de Tabulator por id (`feedPopRowOf`): todo lo que
el pop-up haga con el posteo abierto tiene que andar sin tarjeta. Contador
"3 / 40", flechas y ← →; usa `updateSentiment` y `confirmIgnore` tal como
están; al ignorar pasa al siguiente de la lista; al cerrarse el foco vuelve
a lo que lo abrió (o a la tarjeta del último visto si se navegó desde el
feed y está dibujada). Alto fijo `min(720px, 92vh)`, la foto a todo lo
alto, solo el texto se desplaza (`.feed-pop-scrollwrap.more` pone el
degradé de abajo; la rueda sobre la foto mueve el texto), chips `.chip-r`
(alcance), `.chip-t` (tipo) y `.tema`, likes y comentarios en recuadros
contra la mediana de la cuenta, pie fijo con el tono, "Ignorar",
"Analizar comentarios" (cierra, abre Análisis con el link en `#url`, sin
analizar) y "Abrir en Instagram ↗". Donde no hay pop-up (`x.html`) queda
lo anterior, ir a la fila (`highlightGoToRow`). La foto
llega en `image` del listado (ver "Fotos de los posteos") y el frontend la
lee solo en `feedImageUrl` (tarjeta, miniatura), `feedPopImageUrl` (pop-up,
imagen grande) y `feedImageFailed`: sin intento de descarga, "Sin foto" en
los dos; descarga fallida o copia que no carga, "Imagen no disponible" en
los dos. En la tarjeta el recuadro de la foto es siempre un cuadrado del
ancho de la tarjeta con fondo negro, y la foto va entera
(`object-fit: contain`), sin recorte. Debajo va solo el título: el texto del
posteo no se muestra en la tarjeta, se lee entero en el pop-up. Likes y
comentarios van en una franja propia, en grande, con la fecha de esos
números a la derecha ("al 08/10"; en el pop-up, "Métricas al 08/10/2026 ·
23:48" debajo de las métricas). La fecha sale de `postMetricsDate`
(`monitoring.js`): `metrics_updated_at` o, si nunca se refrescó,
`detected_at`; con más de `METRICS_STALE_DAYS` (3) va en ámbar. La franja
es una grilla de UN renglón con dos espacios que ceden: lo que se le sume
no puede agregarle alto a la tarjeta (medir en la de 240 px). El pie tiene
dos renglones: el motivo y "Abrir ↗"; debajo, el selector de sentimiento y
el medidor de alcance (`buildFeedFoot`). El hover
(sube, borde del color del sentimiento, foto que se acerca) va solo con
mouse (`hover: hover`) y el movimiento se apaga con
`prefers-reduced-motion`.
"Se despegaron" muestra hasta cuatro tiras del período (`.up`), con la
línea "Ninguna publicación del período se despegó de lo habitual de su
cuenta" si no hay. El selector de sentimiento de tarjetas, tiras y pop-up
sigue siendo el desplegable pastilla (no los botones de la maqueta), y la
fila de la tabla sigue desplegando el detalle (decisiones del dueño).
Las maquetas originales (`design/monitoreo-feed.html` y
`design/monitoreo-popup.html`) quedaron en el tag `v3-riel-radar`; la
vigente es `design/social-listening-v4.html`. SDD en
`openspec/changes/monitoreo-feed/`, `openspec/changes/monitoreo-popup/` y
`openspec/changes/monitoreo-v4/`. La suite no cubre el frontend: se
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
- `scripts/cargar-fotos.js`: carga única de las fotos de los posteos ya
  guardados (incluidos los de más de 60 días). Sin `--si` SOLO INFORMA y
  abre la base en solo lectura (no carga `src/db.js`: no migra). Con `--si`
  GASTA EN APIFY: `fetchPostDetails` por URL en lotes de 50, de a uno, fase
  `fotos`, y `syncPostImages` con cada respuesta; no toca métricas ni
  cadencias; exige la app apagada y frena ante el primer problema. Como todo
  gasto real, se corre solo con autorización del dueño y el costo a la vista.
  Test: `test/cargarFotos.test.js`.
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
