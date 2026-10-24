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
- **Análisis de publicación** (`src/apify.js` → `fetchAnalysisPost` y
  `fetchAnalysisComments`, que llama `src/analysisJob.js` desde
  `POST /api/analyze`): SIEMPRE `apify/instagram-scraper`, porque apidojo no
  devuelve comentarios. No migrarlo. Ver "Análisis de publicación de
  Instagram".
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
purga a los 100 días (`SEARCH_SEEN_TTL_DAYS`; era 30: Estadísticas cuenta
los descartados por término en períodos de hasta 90 días). Si el run falla
entero no se anota nada.

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
  `usd_real`, `apify_run_id` y, en un análisis de publicación,
  `analisis_id` (del contexto de `usageContext`). `monitoring_runs`, una fila por ciclo. Fases:
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
`detected_posts.tema` (TEXT, anulable, sin CHECK); null es "sin dato":
Estadísticas lo cuenta como "Coyuntura / Otros", y elegir ese tema en el
filtro del Monitoreo también lo trae (ver "Diseño v4").

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

## Estadísticas (`src/stats.js`)

`GET /api/monitoring/stats?plataforma=&desde=AAAA-MM-DD&hasta=AAAA-MM-DD`
(`src/statsRoutes.js`, montada desde `server.js` bajo `/api/monitoring`:
mismo login y plataforma obligatoria) devuelve en UNA respuesta todos los
bloques del período, así la pantalla muestra el mismo recorte en todos.
Sin fechas, los últimos 30 días hasta hoy; van las dos o ninguna, hasta 366
días (si no, 400 con `userMessage`). Con la base real tarda unos 50 ms con
30 días y 80 con 90: no hay caché. Lee la base con lecturas propias de
`db.js` (`listPostsForStats`, `listIgnoredPostsForStats`,
`countDiscardedSearchesForStats`, `getFirstPostedAt`,
`listFollowersForStats`). SDD en `openspec/changes/estadisticas/`; tests en
`test/stats.test.js`.

- **Período** en hora de Argentina (`resolverPeriodo`) y el anterior, del
  mismo largo y pegado antes. Los días antes del primer posteo de la base no
  son días sin publicaciones: no hay datos. El período efectivo
  (`rangoEfectivo`) arranca en el primer día con datos y termina hoy (la
  mediana de lo habitual sale de esos días). `periodo.primerDia` es el
  primer día con datos de la plataforma (null sin posteos).
- **Comparación con el anterior** (regla del dueño, 23/10/2026): se compara
  siempre que el anterior empiece en o después del primer día con datos (y
  termine antes de hoy): un día sin publicaciones vale cero, es un dato. Si
  empieza antes, `anterior.comparable` es false y sus `*Anterior` y
  `temas[].anterior` van en null (la pantalla dice "sin datos del período
  anterior" y los temas van sin badge). `anterior.diasConCorridas`: en
  cuántos de sus días hubo corridas (`db.listRunTracesForStats`: corridas
  terminadas de la plataforma y, como `monitoring_runs` existe desde el
  23/9/2026, también días en que se detectó un posteo o se vio un resultado
  de búsqueda). Con menos de la mitad, la pantalla avisa "Período anterior
  con pocas corridas" sin dejar de comparar.
- Cuentan los posteos visibles (`ignored = 0`) por `posted_at`.
  Sentimiento null = neutral; tema null = "Coyuntura / Otros"
  (`CATEGORIA_FALLBACK`).
- **"Se despegó"** = `top.level === 'alto'` con
  `accountStats.classifyPostAgainstBenchmark`, calculado al armar la
  respuesta como en el listado: el KPI del Monitoreo y el de Estadísticas
  dan lo mismo para el mismo período (con la base real, 55 de 296 en 30
  días, los mismos posteos). Las razones van sin redondear (la pantalla las
  corta con `formatBenchmarkRatio`). La de un pico (`picos`, días con el
  doble de lo habitual o más) es publicaciones del día / la mediana diaria,
  sin colchón: esa sí puede decir "× lo habitual".
- **Bloques**: `resumen` (relevantes, se despegaron, % negativo y positivo,
  conversación, cada uno con su `*Anterior` y 12 cubetas en `tendencias`;
  un % de una cubeta vacía es null), `porDia`, `habitual`, `picos`,
  `porHora` (7 × 24, lunes primero), `palabras`, `menciones`, `semanas`
  (los tramos: por día hasta 14 días; más, de a 7 contados hacia atrás desde
  `hasta`, así el último son los últimos 7 días y el corto queda primero),
  `temas`, `cuentas` y `ranking`.
- **`palabras`**: las 60 más usadas en título y texto. Primero las frases de
  las palabras clave y búsquedas de la plataforma y `FRASES_FIJAS` ("Buenos
  Aires"), enteras; después palabras de 3 letras o más que no estén en
  `src/stopwords.js` (hashtags, menciones, links y números no, salvo que
  estén en la lista). `n` es la cantidad de posteos; además `positivas`,
  `negativas` e `ids` (los posteos contados: un clic en la palabra los
  muestra en el Monitoreo; buscar el texto traería otros).
- **`menciones`**: una fila por término de búsqueda con algo en el período
  (el de "Búsqueda: <término>" del motivo, leído como `postReasonParts`).
  `detectadas` suma también los ignorados y los descartados por el
  clasificador (`search_seen`, por `first_seen_at`: no guarda
  `posted_at`); `relevantes`, lo guardado y visible; `positivas`, de esas.
  Lo que no llegó por una búsqueda (cuentas y hashtags, antes de septiembre
  de 2026) no entra. El share of voice de la pantalla sale de acá.
- **`temas`**: por tramo, con `anterior` (null si el período anterior no
  tiene datos) y `destacada` (la de mayor razón; a igual razón, la más
  nueva; con su `nivel`, que puede no ser alto). **`cuentas`**: impacto
  (likes + comentarios), seguidores (el último conocido o null), cuántas se
  despegaron y la mejor razón. **`ranking`**: las 10 de mayor razón, con la
  métrica que decidió, su valor, la mediana y su `nivel`.
- Sin benchmark (X, `conAlcance` falso) no hay alcance: 0 se despegaron y
  ranking vacío.

## Datos sin sesión: `GET /api/public/resumen`

La única ruta de datos que pasa el gate sin sesión (`src/auth/gate.js`,
`PUBLIC_API`, escrita EXACTA: nunca un prefijo `/api/public/`, que dejaría
pasar cualquier ruta futura; POST, HEAD, mayúsculas, barra final o doble
dan 401, `test/authGate.test.js`). La arma `src/publicResumen.js` campo
por campo, con lecturas de `db.js` que solo cuentan
(`countPostedSinceAllPlatforms`, `countTemasSinceAllPlatforms`,
`getFirstDetectedAtAny`, `countReclamosEnMapa`): `publicacionesHoy` y
`publicaciones30Dias` (todas las redes), `reclamosEnMapa` (los que tienen
pin, con la regla del mapa, `hasMapLocation`: no de fuera de CABA, con x, y
y dirección normalizada, y no en el (0,0) que deja una respuesta de USIG sin
coordenadas; los sin dirección, no encontrados o pendientes no cuentan),
`primerDia` y `diasEscuchando` (desde la primera DETECCIÓN, contando los dos
extremos: la primera fecha de publicación puede ser de días antes),
`runHours`, `corridasPorDia` y `temas` (los 8 de 7 días, con `n` y
`orden`; un tema que no está en la config cuenta como "Coyuntura / Otros").
Nunca un título, un texto, una cuenta, una URL, un término de búsqueda ni un
correo: no reusa `armarEstadisticas`, `contarTemas` ni `buildLastRun`. No
lee nada del pedido ni pone cookies; 60 s de caché en memoria
(`Cache-Control: public, max-age=60`), también para un fallo: con una
respuesta buena anterior DEL MISMO DÍA de Argentina sirve esa (la de ayer
diría "publicaciones hoy" de ayer); si no, 503 genérico.
Test: `test/resumenPublico.test.js`. Un campo nuevo acá tiene que ser una
cantidad o un nombre de tema, y su test lo tiene que fijar.

## Diseño v4

Desde octubre 2026 el frontend se rehace sobre UNA maqueta,
`design/social-listening-v4.html` (login, inicio y las cuatro solapas; la
barrita "maqueta" de abajo a la derecha no va en la app). Cinco fases, una
rama y un PR por fase: A `sistema-visual-v4` (el marco en todas las
páginas), B `monitoreo-v4`, C `estadisticas`, D `inicio-y-login`, E
`analisis-v4`. El estado anterior (riel, radar y las maquetas viejas) quedó
en el tag `v3-riel-radar`. SDD de la fase A en
`openspec/changes/sistema-visual-v4/`; de la B, en
`openspec/changes/monitoreo-v4/`; de la C, en `openspec/changes/estadisticas/`.
La D va sin SDD (decisión del dueño). De la E, en
`openspec/changes/analisis-v4/` (ver "Análisis de publicación de Instagram").

- **Sistema visual** (`public/css/styles.css`, en tres partes comentadas):
  1) los tokens y componentes de la maqueta tal cual (`--bg`, `--surface`,
  `--accent`, `--glow`, `--pos`/`--neu`/`--neg`, `--c1`…`--c5`; `.card`,
  `.chip`, `.kpi`, `.seg`, `.btn`, `.field`, `.tip`; `rise` escalonado por
  `.rv`, `fadeIn`, `pop`, `slideIn`, `ping`, `draw`), con Sora, IBM Plex
  Sans e IBM Plex Mono de Google Fonts. Una excepción: `--muted` no es el
  de la maqueta, para pasar 4,5:1 sobre `--surface` y `--surface2` con el
  mismo tono: en claro `#626d8c`, más oscuro que `#7c87a4` (5,14 y 4,55);
  en oscuro `#808aa5`, más claro que `#6f7b99` (5,03 y 4,51). **Tintas para
  texto** (decisión del dueño, 23/10/2026): `--accent-text`, `--pos-text`,
  `--neg-text` y `--neu-text` van en TODO texto que antes iba en `--accent`
  / `--pos` / `--neg` / `--neu` (enlaces, deltas de los KPI, razones,
  positivas, la nube, errores, ✕ al pasar el mouse…); rellenos, barras,
  puntos, bordes e íconos SVG siguen con la base. En claro son más oscuras,
  mismo tono, y pasan 4,5:1 sobre `--surface` y `--surface2` (y sobre el
  centro del degradé de la nube): `#0a6fac`, `#14794f`, `#c63333`,
  `#5365b8`. En oscuro las bases ya pasaban (la más justa, `--neg`, 4,80
  sobre `--surface2`): la tinta es la misma base, en su token. Un color de
  texto nuevo usa la tinta, nunca la base; 2) el marco;
  3) los componentes de
  la app: el Monitoreo de la maqueta (`.mon`, `.srcbox`, `.flowcard`/`.fl`,
  `.pipe`, `.al`, `.fbar`, `.combo`, `.fstatus`, `.ups`/`.up`, `.reach`),
  las Estadísticas (`.cloud`, `.rows`, `.donut`, `.topic`, `.heat`,
  `.acc-row`, `.rk`; los badges de los temas llevan la tinta oscura donde
  el blanco de la maqueta no pasaba 4,5:1), el Análisis de publicación
  (todo bajo `.ana4`: `.step`, `.ana-notice`, `.posts`, `.post`,
  `.ai`, `.stackbar`, `.theme`, `.tl`, `.cmt`), el inicio (`.hero`,
  `.plats`/`.pl`, `.nextcard` con `.nring` y `.tl24`, `.homefeed` con
  `.fl.big`, `.homeana` con `.recent`), el login (`.lg-vis` con `.ticker`/`.tk` y `.lg-stats`;
  `.lg-card` con `.lg-state`, `.lg-err`, `.lg-mail`, `.lg-foot`,
  `.lg-trust`) y,
  con los mismos tokens, lo que la maqueta no dibuja o que todavía no se
  rehizo (progreso, Tabulator, feed, pop-up, modales, mapa, el Monitoreo y
  el análisis de X). La visual del login es SIEMPRE oscura: el bloque de los
  tokens oscuros vale también para ella (`:root[data-theme="dark"],
  .lg-vis`), más `--vis-1` / `--vis-2`, las manchas de color. Todo color sale de los tokens: los únicos sueltos son los de marca de cada
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
  clara). El login no tiene botón: su tarjeta respeta lo elegido y la
  visual de la izquierda es siempre oscura. Los valores
  oscuros son los de la maqueta, salvo `--muted` (`:root[data-theme="dark"]`); no hay
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
  pop-up o modal abierto) y ← → con el foco en la píldora. Estadísticas es
  la 4 (solo Instagram): al abrirla, `openTab` llama a `openStats`, como al
  Mapa con `refreshClaimsMap`; un botón con `aria-disabled` no abre nada. X: Monitoreo, Mapa y
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
  Facebook y TikTok van "· pronto", sin enlace.
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
    Un clic en una palabra o un tema de Estadísticas trae ese período como
    rango temporal (`monitorPeriodRange`, lo pone `showInMonitoring`):
    "24/9 → 23/10" con ✕ en `periodSeg`, Hoy / 7 / 30 apagados, sin
    guardarse. `monitorPeriodEnd` es su fin (null con Hoy / 7 / 30) y
    `postInPeriod` lo respeta, así lo siguen los KPI (su anterior son los
    días enteros, el mismo de Estadísticas), las fuentes, el flujo, "Se
    despegaron" y la lista. La ✕ o elegir Hoy / 7 / 30 lo saca.
  - **Panel** (`public/js/monitoringPanel.js`, prefijo `panel`): los
    cuatro KPI (publicaciones con sparkline y variación contra el período
    anterior del mismo largo; tono neto, con anillo, con la regla de
    Estadísticas y del inicio: sin clasificar = neutral (decisión del dueño,
    24/10/2026; antes iba sobre los clasificados; vale también para la
    barrita de tono de los chips);
    "Se despegaron" con "la mayor: 15,37× en comentarios, de @cuenta";
    conversación), con las tarjetas de `public/js/kpi.js` (prefijo `kpi`,
    compartidas con Estadísticas: `kpiCard`, `kpiDelta`, el trazo, el
    anillo y `kpiCountUp`), los chips de búsquedas / palabras clave /
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
    con nodos (`postFindTerm` de `postView.js`, sin mayúsculas ni acentos). Durante una
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
    (`tablePlaceholderEl`) que `applyFilters` tiene al día. El filtro por
    fuente suma `palabra` (un clic en la nube de Estadísticas): los posteos
    que la nube contó (los `ids` de esa palabra), con la pastilla "palabra
    de la nube «x»". Elegir "Coyuntura / Otros" en Tema trae también los
    posteos sin tema (`temaSinDato` de `/api/monitoring/config`), como los
    cuenta Estadísticas.
  - **Avisos y carga**: `notifyMonitoringViews({ config })` cuando llega
    la config (null si falló). La config y los posteos pueden llegar antes
    de que se cargue un script de los de abajo: cada uno arranca con
    `monitoringConfig` (undefined: todavía no) y `monitoringTable` si ya
    están.
  - Los colores de los temas (`temaColor`, `buildTemaTag`) son los
    `--cat-N` por el lugar del tema en la config.
- **Estadísticas de Instagram** (fase C, `public/js/stats.js`, prefijo
  `stats`; solo `instagram.html`, después del flujo): la solapa de la
  maqueta con los números de `GET /api/monitoring/stats` (ver
  "Estadísticas"); el frontend no cuenta nada.
  - **Carga**: la primera vez que se abre la solapa (`openStats`) y al
    cambiar el período: 7 / 30 / 90 días hasta hoy o Desde → Hasta (si
    termina hoy y tiene 7, 30 o 90 días, es ese botón), en
    `sl.stats.periodo` (`"30"` o `"AAAA-MM-DD/AAAA-MM-DD"`; sin nada, 30).
    Mientras llega, lo anterior queda tenue (`.stats-body.loading`) y una
    respuesta de otro período se descarta (`statsRequest`); un error deja el
    aviso con "Reintentar". Si cambian los posteos de la tabla (ids, tono o
    tema, `statsPostsKey`: una corrida, ignorar, otro tono) se vuelve a
    pedir: ya, si la solapa está a la vista y el pop-up cerrado (si no, al
    cerrarlo o al volver).
  - **Comparación**: si el backend dice que el anterior no es comparable
    (`statsHasPrevious` = `anterior.comparable`: empieza antes del primer
    día con datos), KPI "sin datos del período anterior" (Negativo y
    Positivo, sin el "antes N %") y temas sin badge ni variación. Si es
    comparable pero tuvo corridas en menos de la mitad de sus días, el aviso
    "Período anterior con pocas corridas: hubo en N de sus M días." y se
    compara igual. Un período entero
    antes de la primera publicación (`diasEfectivos` 0) muestra "—" (también
    en el centro de la dona), "Sin datos de esas fechas." y "No hay datos de esas fechas: las publicaciones
    guardadas empiezan el 29/7." (`periodo.primerDia`). El aviso sale de los
    datos a la vista (`statsPeriodNoteText`), también al volver a la solapa.
  - **Bloques**: cinco KPI (`kpi.js`; "sin datos" si el anterior no tiene);
    la nube en espiral medida con canvas (Volumen / Positivos reales; las de
    dos publicaciones o más; color = el tono que predomina); menciones por
    búsqueda y la dona; los 9 temas con su badge (sin datos del anterior,
    ninguno; Nuevo: 0 antes y 3 o más; Pico: 5 o más y al menos el doble;
    En alza: más de +20 %; Baja: menos de −20 %; si no, Estable), su
    evolución y la cita "N,NN× en <métrica>" ("La que más se despegó" si su
    `nivel` es alto; si no, "La de mayor alcance"); el mapa de día y hora;
    el tono neto por tramo (por día o por semana, también en el título; sin
    punto en un tramo sin publicaciones); las 10 cuentas (Impacto /
    Publicaciones / Seguidores) y las 6 que más se despegaron (solo las de
    nivel alto; sin ninguna, "Ninguna publicación del período se despegó de
    lo habitual de su cuenta"). Con cinco KPI, entre 981 y 1200 px van de a
    tres.
  - **Clics**: una palabra o un tema llaman a `showInMonitoring`
    (`monitoring.js`): el Monitoreo con este período como rango y la
    palabra (por sus `ids`; con "Positivos reales", además Tono positivo) o
    el tema, los demás filtros en blanco, y baja a la lista, que muestra el
    mismo número que la tarjeta; el foco pasa al título de la lista
    (`focusMonitoringList`, `#pubsTitle` con tabindex -1: no a un control,
    así una tecla no saca el filtro ni cambia el tema), igual que al sacar
    la pastilla de la fuente o al aplicar una alerta. La ✕ del rango (`leaveMonitorRange`) lo deja en el botón
    del período que queda prendido, y una alerta del Monitoreo saca el rango
    (va a Hoy). Con un rango cuyo anterior arranca antes del primer posteo
    cargado, el KPI del Monitoreo dice "sin datos del período anterior",
    como Estadísticas. El ranking abre el pop-up (`openFeedPopList`)
    recorriendo esos 6, con la foto y el tema de la fila de la tabla; si se
    rehace con el foco en una fila, el foco pasa a la misma fila nueva (sin
    filas, al título de la tarjeta). Desde → Hasta no acepta un "Hasta"
    posterior a hoy.
- **Cómo se ve un posteo** (`public/js/postView.js`, fase D): las piezas
  que dibujan un posteo, compartidas por el Monitoreo, Estadísticas y el
  inicio, movidas TAL CUAL de `monitoring.js`, `monitoringFeed.js` y
  `monitoringFlow.js` con sus nombres (`formatCount`, `accountColor`,
  `temaColor`, `buildTemaTag`, `postReasonParts`, `formatBenchmarkRatio`,
  `benchmarkRatioBasis`, `formatFullDateTime`, `postReach`,
  `buildReachMeter`, `normalizeSearch`, `feedAgo`, `feedImageUrl`); las del
  flujo pasaron a llamarse `postFindTerm`, `postTitleLine` (con
  `{ wrap: true }`, el del inicio: la cuenta en su renglón y el título
  entero, sin " · " ni recorte adelante), `postThumb` y `POST_TONES`. Los
  temas para los colores son `postViewTemas`, que fija `setPostViewTemas`
  (`monitoring.js` al llegar la config; el inicio, con la suya). Va antes
  que todos en `instagram.html`, `x.html` y `dashboard.html`. Una pieza de
  dibujo nueva que sirva a más de una página va acá.
- **Mapa**: mosaicos de OpenStreetMap claros también en oscuro; controles,
  leyenda, popups y tooltips de Leaflet con los tokens. Los colores de
  categoría (`--cat-1` … `--cat-12`) salen de la paleta de la maqueta, en su
  tono oscuro (el número del pin va en blanco). La tarjeta de filtros lleva
  `z-index: 3`: las dos tarjetas tienen `.rv`, cuya animación les da su
  propia capa, y sin eso el mapa tapaba los desplegables.
- **Login** (fase D; `index.html`, que es el de `/`, y `login-verify.html`):
  la pantalla partida de la maqueta, sin pie. Antes de entrar no se muestra
  ninguna publicación.
  - **La visual** (`public/js/loginScene.js`, prefijo `lg`): todo sale de
    `GET /api/public/resumen` (ver "Datos sin sesión"). La constelación es
    un canvas: los 8 temas de los últimos 7 días (radio de 5 a 18 px por
    cantidad, color `--cat-N` por su lugar en la config, como `temaColor`)
    en el hueco más alto que dejan los textos (en escritorio, entre el
    subtítulo y los contadores; en celular, debajo de los contadores) y 18
    puntitos sin nombre unidos a dos temas, con una chispa que viaja por
    cada hilo; al azar pero siempre igual (semilla fija). Van los temas que
    entran en filas de `LG_ROW_MIN_PX` (56 px; en una franja baja quedan
    afuera los de menos publicaciones), con el vaivén y el desvío a la
    medida de la fila: no se enciman nombres (probado de 375 a 1920 px). Se
    mide con `offset*` (sin las animaciones de entrada) y se rearma cuando
    cambia de tamaño la visual o alguno de sus textos (un `ResizeObserver`
    sobre el título, el subtítulo y los contadores: con la fuente en frío,
    el subtítulo cambia DESPUÉS de `fonts.ready`). Con movimiento reducido, un cuadro quieto; con la
    pestaña oculta o la visual fuera de la pantalla, el
    `requestAnimationFrame` se frena. El ticker "tema · N publicaciones · 7
    días" va donde de verdad queda lugar, entre los textos y los contadores
    (`lgPlaceTicker`; con menos de 150 px de alto o 230 de ancho, `.no-room`
    y no va: entre 981 y unos 1200 px no entra), y repite la lista hasta
    llenar el alto; la pista es `flow-root` para que sus dos mitades midan
    lo mismo, y el ticker va sin transiciones (con movimiento reducido la
    regla global les da 0,01 ms y se leería el top viejo). El subtítulo y
    los rótulos chicos (contadores, ticker, la marca) van en `--fg`: debajo
    están las manchas, que aclaran el fondo; en ventanas bajas la celeste
    sube hasta el subtítulo (medido de 1000x620 a 1920x1080 con las manchas
    en tres puntos de su recorrido, el mínimo queda en 5,11:1). Los contadores
    (publicaciones hoy de todas las redes, reclamos en el mapa, días
    escuchando, publicaciones · 30 días) usan `kpiCountUp` de `kpi.js`, y el subtítulo
    suma "La escucha corre cuatro veces por día: 8, 12, 16 y 20 h." Sin
    respuesta: contadores en "—", sin ticker, solo los puntitos. Los nombres
    del canvas van por `fillText`; el resto, por `textContent`.
  - **La tarjeta** (`public/js/login.js`, prefijo `login`): el link mágico
    de siempre (sin código de 6 dígitos; `/api/auth/*` no cambió) en dos
    pasos. 1) "Entrá con tu correo" y "Mandarme el link →" (Enviando el
    link… / Link enviado ✓); 2) "Revisá tu correo": a qué dirección,
    "Mandar otro link" (con `aria-disabled`, no `disabled`, que le sacaría
    el foco, y la cuenta regresiva de `retryAfterSeconds`) y "Cambiar el
    correo". El envío y el reenvío llevan su propia bandera (con un reenvío
    en vuelo se puede volver y pedir para otra dirección; para la MISMA no:
    un segundo link anularía el primero, el backend borra los no usados) y
    el aviso de "Te mandamos otro link" va fuera de los pasos. Un reenvío que
    vuelve cuando ya se está en otra dirección solo se anuncia. La espera es POR
    DIRECCIÓN: otra no queda trabada; lo mandado queda en `sessionStorage`
    (`sl.login.enviados`, esa pestaña) y, si se pide otra vez la misma
    dentro de la espera, va directo al paso 2 ("Ya te mandamos un link hace
    instantes"), sin pedir (el backend tampoco mandaría otro). Nunca en
    `localStorage` (la clave vieja `sl-login-cooldown-until` se borra). La
    respuesta es la misma esté o no habilitado el correo: la pantalla nunca
    dice "no autorizado". Errores, solo los reales, con textos propios:
    correo mal escrito (se mira acá), 429, 503 (no muestra el del backend,
    que nombra variables del `.env`) y sin conexión. Abajo: "Sin
    contraseña · La sesión dura 7 días · Solo correos habilitados".
  - **login-verify** (`public/js/loginVerify.js`, prefijo `verify`; sin
    script en línea): "Último paso"; entra recién con el clic en "Entrar"
    (un filtro de correo que abre el link no lo usa). Guarda el token en
    memoria y lo saca de la dirección (`history.replaceState`), con `<meta
    name="referrer" content="no-referrer">`. Manda el mismo cuerpo de
    siempre a `POST /api/auth/verify` por `fetch`: si la redirección
    terminó en `/dashboard.html`, entró y va ahí; si terminó en otro lado
    (el gate la mandó al login: la cookie no quedó), "No se guardó la
    sesión"; un 400 muestra "El link venció o
    ya se usó" con "Pedir otro link →"; sin token (abierta sola o
    recargada), "Falta el link"; con la red o el servidor caídos, se puede
    volver a probar.
  - En celular (≤ 980 px): la marca y la tarjeta primero, la visual debajo,
    sin ticker y con 340 px abajo para la constelación. Los errores son `.lg-card .lg-err`: sin `.lg-card` adelante
    les gana `.lg-card p`.
- **Inicio** (fase D, `dashboard.html` + `public/js/dashboard.js`, prefijo
  `home`): la pantalla de la maqueta con datos reales, sin el selector
  Hoy / 7 días, sin reloj y sin "datos de ejemplo". "Análisis recientes"
  (fase E) es la tercera columna de `.home3` (1fr 1.25fr 1fr; entre 861 y
  1200 px va abajo, a todo el ancho: más angosta, la "Próxima corrida"
  cortaba sus rótulos): los 4 últimos de
  `GET /api/analisis?plataforma=instagram&limit=4` (`homeLoadAnalisis`, con
  el resto del inicio; redibuja solo si cambiaron), cada uno a
  `instagram.html#analisis-<id>`, con estado vacío. Cada fila: la foto,
  "@cuenta · fecha de la publicación" (con el año si no es este; sin ella,
  "analizado <fecha>"), el texto recortado a 90 caracteres en el DOM, "N %
  pos" y "N analizados" (no es el total de la publicación); un
  `aria-label` corto (cuenta, fechas, % y "N de M comentarios
  analizados") y el `data-tip` con la fecha y hora del análisis, que
  distingue dos análisis de la misma publicación.
  - `GET /api/inicio` (`src/inicioRoutes.js`, con sesión) arma una entrada
    por red: `enCron` (las de `MONITOR_PLATFORMS`), `nextRunAt` (null
    fuera del cron), `hoy` (publicadas desde las 00:00 de Argentina),
    `sieteDias` (publicaciones, se despegaron —null sin benchmark—, % pos,
    % neg y `porDia`, de `stats.armarEstadisticas` de los últimos 7 días:
    los números de Estadísticas, sin clasificar = neutral), `lastRunAt`,
    `lastRun` (`buildLastRun`, el del Pipeline) y `corridasHoy`
    (`db.listRunsBetween`: las de hoy de esa red o de "todas", con su
    estado `ok` | `cortada` (cuota) | `en curso` | `interrumpida`). Una
    fila sin `finished_at` está "en curso" solo si es la del ciclo que corre
    AHORA (`scheduler.getCurrentRunId`, que `server.js` pasa como
    `runIdEnCurso`); si no, quedó sin cerrar porque el proceso se cayó en el
    medio, y nada la cierra al arrancar: "interrumpida". Nuevas y guardadas
    van en null en una fila abierta (`new_posts` es 0 por defecto) y en una
    de varias redes ("todas", "instagram,x": son las de todo el ciclo; el
    Pipeline, `lastRun.js`, todavía no lo distingue). Test:
    `test/inicio.test.js`.
  - Tarjetas: Instagram (hoy, se despegaron · 7 días, % positivo y %
    negativo · 7 días y el trazo de esos días) y X (hoy y su última corrida
    real; fuera del cron, "La detección automática de X está en pausa. Lo
    guardado sigue disponible."). El estado, con la regla de la barra
    superior: "escuchando" con una corrida terminada hace menos de 5 h,
    "última dd/mm" si es más vieja, "en pausa" fuera del cron. Facebook y
    TikTok: "pronto", sin enlace. Una red en pausa (X, con su "Ver lo
    guardado" a `x.html#tab-monitoring`, que dice "En pausa · sin corridas
    automáticas" en vez de "Escuchando": `/api/monitoring/status` trae
    `enCron` por red, de `CRON_PLATFORMS` en `server.js`) o que no se escucha lleva
    `.pl.off`: no baja la opacidad, hunde el fondo y el texto se sigue
    leyendo; "en pausa" lleva el ámbar solo en el punto (contraste).
  - Próxima corrida: la primera `nextRunAt` de las redes en el cron, con
    cuenta regresiva, anillo (lo que pasó desde la corrida programada
    anterior) y "hoy" / "hoy, la primera del día" / "mañana"; llegada la
    hora, se vuelve a pedir a los 20 s. La línea de 24 h pone las horas de
    `runHours` con el estado real de su corrida (una corrida es la de su
    hora si arrancó en esa media hora; la del cron primero): terminada con
    "N nuevas", cortada (sin la tilde de terminada), en curso,
    interrumpida (`.stop`, "se cayó" debajo del punto), "siguiente" o,
    pasado un cuarto de hora sin corrida, "no corrió". Los rótulos no se
    enciman: con menos de 60 px entre dos horas (celular, dos columnas)
    van más chicos (`.tight`) y cada uno con un ancho máximo hasta la hora
    vecina (`homeFitTrackLabels`; lo que no entra se corta con "…"). Las
    demás (a mano, fuera de hora) son puntitos;
    todas con `data-tip` y un resumen en el `aria-label`. "ahora" va en
    `--fg2` (el `--glow` de la maqueta no llegaba a 4,5:1 en oscuro). Última
    corrida: traídas, nuevas, relevantes y US$, con los tooltips del
    Pipeline. La nota dice la verdad: en Instagram solo detectan las
    búsquedas.
  - Últimas publicaciones: `GET /api/monitoring/posts?plataforma=instagram&pageSize=12`
    con las piezas de `postView.js` en `.fl.big` (la foto con la marca de
    la red, la cuenta, el título en dos renglones, el tono con su nombre,
    el tema, el alcance y "hace N h"). La tarjeta tiene el alto de la fila y
    van las que entran enteras (`homeFitFeed`, con `offset*`); en una
    columna, seis. Cada una es un enlace a `instagram.html#publicacion-<id>`:
    `monitoringFeedPopup.js` lo cambia por `#tab-monitoring`, abre el
    Monitoreo y, al llegar los posteos, el pop-up (recorre el feed si el
    posteo está en él; si no está en la tabla, no abre nada); al cerrar, el
    foco va a su tarjeta o, si no tiene, a la solapa. Sin `aria-label`: el
    lector lee lo que se ve y, al final (`.sr`), adónde lleva (el alcance
    sin referencia de `buildReachMeter` lleva la raya con `aria-hidden` y
    "Alcance sin referencia" en `.sr`). Se vuelven a
    pedir cuando cambia la última corrida de Instagram (la marca avanza
    recién cuando llegaron: si el pedido falla, se reintenta con la recarga
    siguiente), y las nuevas entran con la animación.
  - `/api/inicio` se pide cada minuto con la pestaña a la vista y al volver
    a ella; si la primera vez no responde, "sin respuesta del servidor" en
    las dos tarjetas. Horas de Argentina, UTC-3 fija. Las fechas "dd/mm" se arman a
    mano (`homeDayMonth`): con `Intl` es-AR, Chrome da "25/9".
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
`{ run }`, para la barra superior, el panel y el flujo; Estadísticas
escucha los demás —todos salvo `{ config }` y `{ run: 'start' }`— para
saber si sus datos quedaron viejos). El alcance de la
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

## Análisis de publicación de Instagram (fase E)

`POST /api/analyze` (`src/analysisRoutes.js`) valida el link
(`checkAnalyzeUrl`) y responde 202 `{ id, yaEnCurso }` ANTES de gastar; el
trabajo (`src/analysisJob.js`) sigue en el mismo proceso, fuera del pedido,
con el contexto `{ phase: 'analisis', analisisId }`: cerrar la pestaña no
pierde nada ni vuelve a gastar. El link se normaliza a
`https://www.instagram.com/p/<code>/` (también los reels,
`normalizeAnalysisUrl`); el mismo link en curso devuelve el mismo id. Todo
queda en la tabla `analisis` (`db.startAnalisis`, `saveAnalisisPost`,
`finishAnalisis`, `failAnalisis`…, todas por plataforma, sin default; las
dos que no la reciben son por id o para todas: `markInterruptedAnalisis` y
`sumApifyUsdForAnalisis`):
`en curso` | `ok` | `sin comentarios` | `error` | `interrumpido`. Los "en
curso" de un arranque anterior los pasa a "interrumpido" SOLO `server.js`
al arrancar (`db.markInterruptedAnalisis`, con el `usd_apify` que ya
gastaron), nunca la carga de `db.js`: un script que abre la base no puede
tocar un análisis vivo. SDD en
`openspec/changes/analisis-v4/`.

- **Apify**: dos corridas del actor oficial en paralelo (la publicación y
  los comentarios con `addParentData`), por `runActorSync` con los avisos
  `onQueued` (el limitador lleno, `concurrencyLimiter.run(fn, target, {
  onQueued })`) y `onAcquired`. Cada llamada queda en
  `apify_calls.analisis_id`; `usd_apify` de la fila es su suma
  (`db.sumApifyUsdForAnalisis`). `COMMENTS_LIMIT` (lo que se pide a Apify)
  y `COMMENTS_ANALYSIS_LIMIT` (lo que va al modelo) valen 300 por defecto
  (decisión del dueño, 24/10/2026; tope 500); el `.env` los pisa. Los dos
  son solo de Instagram: X sigue con 150 y su propia variable,
  `X_COMMENTS_ANALYSIS_LIMIT` (`resolveXMaxItems`, src/x/sample.js), porque
  manda todo el hilo en una sola llamada (subir el de Instagram no puede
  subir el de X). La línea de arranque muestra los tres. `normalizePost` suma id, código, `postedAt`, tipo e `imageUrl`
  (las funciones del monitoreo); likes -1 o ausentes → null, también en
  los comentarios.
- **Modelo** (`src/analyzeComments.js`): la muestra (`commentSample.js`)
  va en tandas de `BATCH_SIZE` 100 por llamada (`TANDA_SYSTEM_PROMPT`,
  `TANDA_JSON_SCHEMA`, cada tanda numerada desde 1; hasta 3 a la vez) y
  después una síntesis (`SINTESIS_SYSTEM_PROMPT`, `SINTESIS_JSON_SCHEMA`)
  con todo lo clasificado: posteo sobre, insights, postura, lectura
  estratégica y hasta 8 temas con los números de sus comentarios
  (`normalizeTemasConComentarios`: solo comentarios clasificados de la
  muestra, sin repetidos). Una tanda que falla deja sus comentarios en null
  y el análisis sigue (el contador del paso suma solo lo clasificado); si
  fallan todas, error con el `userMessage` del proveedor (sin crédito,
  clave inválida: reintentar no lo arregla), y si falla la síntesis, con el
  suyo. El error lleva lo ya gastado (`err.tokenUsage`): la fila guarda
  `usd_modelo` y `tokens` también al fallar. La subcategoría de los
  reclamos (`llm.requestText`) sale con su costo estimado, como el resto.
  El registro de cuentas se actualiza de a uno (`updateAccountRegistry`:
  relee el archivo, suma lo suyo y lo guarda con un temporal y un rename),
  así dos análisis a la vez no se pisan.
  **"Analizados" son los clasificados de verdad**:
  `normalizeBatchClassifications` ya no completa con neutral lo que el
  modelo no devolvió; la pantalla dice "analizados N de M" con M el total
  que informa Instagram, nunca un número fijo. Los tonos de la pantalla son
  cantidades simples (`countTones`, el ruido aparte); el informe
  (`reportBuilder.js`) conserva su porcentaje ponderado por tipo de cuenta
  (la pantalla lo rotula así) y dice "Análisis realizado sobre N de M
  comentarios", con "(priorizadas…)" solo si la app recortó la muestra. El
  prompt, el schema y la validación de X no cambiaron. Los tests stubean
  `llm.requestStructuredAnalysis` y `clasificarReclamo.asignarSubcategorias`
  por el objeto del módulo.
- **Reclamos**: `db.upsertReclamo(r, { conservarGestion: true })` en
  Instagram y X: re-analizar conserva el estado y, si la dirección detectada
  no cambió, el geocodificado; con la misma categoría, una subcategoría
  vacía (la llamada falló) no borra la que había. El importador sigue como
  antes.
- **Progreso** (`src/analysisProgress.js`,
  `GET /api/analyze/progress?plataforma=&id=`): turno (solo si alguna
  corrida esperó cupo), publicación, comentarios, tono (los clasificados de
  las tandas que van terminando, en el orden en que terminan: "87 de 287"
  si termina primero la corta), temas, reclamos e informe, cada uno `pendiente` | `en curso` |
  `ok` | `omitido` | `error` con un detalle que escribe el trabajo. Queda
  en memoria 10 min después de terminar; después la ruta devuelve la fila
  (`pasos: null`).
- **"Cuándo comentaron"** (`src/commentTimeline.js`, sin dependencias):
  sobre TODOS los comentarios traídos (la muestra está ordenada por likes),
  solo con la fecha de la publicación y 10 o más con fecha; por hora hasta
  48 h, de a 6 h hasta 7 días, por día después; un comentario anterior a la
  publicación cuenta en el primer tramo; pico = el de más (el primero si
  empatan). Si no, `cuando` es null y la pantalla no muestra el bloque.
- **Foto**: la del Monitoreo si la publicación ya la tiene guardada; si no,
  `postImages.savePostImage` con el link de la corrida de la publicación
  (mismo archivo `data/media/instagram/<id>_*.jpg`; si el posteo está en
  `detected_posts` sin foto, se le anota). Ningún pedido nuevo a Apify. La
  fila guarda sus `image_*`; `GET /api/analisis/:id/image` arma el archivo
  con el `post_id` de la fila.
- **Lecturas**: `GET /api/analisis?plataforma=&limit=` (`recientes`
  terminados bien y `enCurso`, cada uno con `propio`: lo arrancó esta
  sesión; el correo no sale), `?url=` (`ultimo` y `enCurso`: el aviso de
  "ya se analizó"), `GET /api/analisis/:id`, `PATCH /api/analisis/:id/temas`
  (hasta 8, cada uno con título; los números de comentarios se limpian
  contra la fila). Al navegador no va el link original de la foto ni quién
  lo corrió (`paraNavegador`).
- **Pantalla** (`public/js/analysis.js`, prefijo `ana`; solo
  `instagram.html`, después de `postView.js`; CSS bajo `.ana4`, así X no
  cambia): "Analizar" pregunta primero `?url=` (si hay uno terminado,
  "ya se analizó el …" con "Ver ese análisis" / "Analizar de nuevo"; si hay
  uno en curso, lo sigue), después POST, y consulta los pasos cada 1 s.
  Enter con uno en curso no dispara otro (también en `x-analysis.js`). Al
  cargar la página sigue solo uno en curso PROPIO (el de otra persona le
  bloquearía "Analizar"). Al terminar el que se sigue, el campo se vacía y
  se muestra solo si la persona no eligió otra cosa mientras tanto (otro
  link en el campo, un reciente, un `#analisis-<id>`); si no, "Terminó el
  análisis de @cuenta" con "Ver ese análisis", sin tocarle el campo. Los
  pasos se actualizan en el lugar (la lista es una región viva: se anuncia
  lo que cambió); el sondeo corta con un 401 (sesión cerrada) o a los ~3 min
  sin respuesta, y sin conexión dice "No hay conexión con el servidor". La
  vista sale entera de
  la fila: la foto entera sobre negro, "analizados N de M", el resumen (la
  lectura estratégica, escrita en ~1,5 s; quieta con movimiento reducido),
  el tono, los temas (tamaño por conteo; clic filtra los comentarios con
  una pastilla ✕; ✎ edita título y texto o quita; "+ tema"; sin texto el
  tema no entra en el informe), "Cuándo comentaron" (SVG al ancho real, una
  franja por tramo con `data-tip`; tres marcas en el eje bajo 480 px; con
  la solapa oculta no se dibuja y se arma al aparecer; el rótulo del pico
  se mide y queda adentro), los
  comentarios (Destacados = los 5 con más likes, Negativos, Neutrales,
  Positivos, Todos de a 50) y compartir: el informe con los temas editados
  (`TemasConversacion.assemble`), aviso pasados los 4.000 caracteres
  (WhatsApp lo corta ahí), Copiar, WhatsApp y el CSV (deshabilitado sin
  reclamos; `reclamos-<cuenta>-<AAAA-MM-DD>.csv` con la fecha del análisis en
  Argentina). La primera vez que se abre la solapa (`openAnalysis`, desde
  `openTab`) muestra el más reciente, salvo que haya un link en el campo.
  `#analisis-<id>` abre ese análisis; con uno a la vista, el hash es el
  suyo. `anaPreload(url)` ("Analizar comentarios" del pop-up) deja el link
  sin analizar, saca de la vista el análisis de otra publicación y avisa si
  ese link ya se analizó. El campo sigue siendo `#url`.
- Tests: `test/analisisBase.test.js` (tabla, recientes, interrumpidos,
  `analisis_id`, `conservarGestion`), `test/analisisApify.test.js`
  (normalización contra el fixture, topes, las dos corridas),
  `test/analisisModelo.test.js` (tandas, una caída, índices omitidos, temas,
  tonos, informe) y `test/analisisTrabajo.test.js` (línea de tiempo,
  progreso, el trabajo y las rutas con el gate de login). La pantalla se
  prueba con el servidor de prueba aparte (análisis sembrados y
  `/api/analyze` simulado con el progreso real).

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
