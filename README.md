# 🔍 Social Listening App

App web que:

1. Recibe el link de una publicación de Instagram, extrae los comentarios y
   los datos del posteo con **Apify**, y los analiza con un **LLM** (Anthropic
   Claude u **OpenRouter**) siguiendo una metodología de análisis político,
   mostrando un **reporte ejecutivo** listo para WhatsApp. El reporte incluye
   **temas emergentes** (editables en pantalla; el resto no se toca) entre el
   KPI y los insights por tipo de cuenta.
2. Recibe el link de una publicación de **X**, trae el hilo y lo clasifica
   con **Grok** vía OpenRouter (`OPENROUTER_X_MODEL`, no Apify ni el Claude
   de Instagram) y arma el reporte con la plantilla de X (solapa Análisis
   en `x.html`). El mapa de X usa el mismo Leaflet, filtrado por plataforma.
3. Monitorea automáticamente, cada 4 horas, si aparece algún posteo nuevo de
   las cuentas trackeadas o que mencione las palabras clave/hashtags
   configurados, en todas las redes registradas en `src/platforms/`: cada
   red tiene su **adapter** (Instagram trae con Apify, X trae con Grok) y el
   resto — relevancia, título y sentimiento con el clasificador compartido,
   dedupe, guardado — es el mismo para todas. Cuentas y keywords de cada red
   viven en su sección de `config/monitoring.json`. Ya no se mandan mails de
   alerta del monitoreo.
4. Muestra la solapa "Mapa de reclamos" (Leaflet) **por plataforma**: cada
   página pide `GET /api/reclamos?plataforma=instagram|x`. Círculos por
   dirección normalizada, con filtros combinables por categoría y subcategoría
   (esquema de dos niveles del cliente, en `config/categorias-reclamos.json`),
   estado, barrio/comuna, rango de fechas y texto libre. Se alimenta de dos
   fuentes: el análisis de una publicación (`/api/analyze` e `/api/x/analyze`
   guardan reclamos con ubicación en `geo_status = 'pendiente'`; un worker los
   geocodifica con USIG después, sin bloquear la respuesta) y el importador
   genérico de Excel/CSV (`scripts/import-reclamos.js`).

---

## 📁 Estructura del proyecto

```
social_listening_app/
├── server.js                 # Servidor web (Express). Punto de entrada.
├── src/
│   ├── apify.js              # Extrae comentarios y datos del posteo desde Apify.
│   ├── analyzeComments.js    # Orquestación del análisis (Apify → LLM → reporte).
│   ├── x/                    # Análisis de publicación de X: Grok fetch, KPIs, reporte, padrón.
│   ├── platforms/            # Adapters del monitoreo por red (instagram.js con dos proveedores: instagramApidojo.js e instagramApify.js, elegidos por igActor.js; x.js) + registro y contrato.
│   ├── llm/                  # Proveedores: anthropicProvider, openrouterProvider.
│   ├── prompt.js             # La metodología de análisis (system prompt).
│   ├── temasConversacion.js  # Temas emergentes del reporte (IG y X).
│   ├── reclamosQuery.js      # Query del mapa: plataforma obligatoria + filtros.
│   ├── db.js                 # SQLite: posteos detectados + reclamos del mapa.
│   ├── reclamosAddress.js    # Obsoleto (heurística del seed viejo); sin uso.
│   ├── tematica.js           # Normaliza etiquetas libres del CSV de reclamos (legacy).
│   ├── categoriasConfig.js   # Carga y valida config/categorias-reclamos.json.
│   ├── categoriaReclamo.js   # Estado (4) cerrado del mapa; re-exporta categorías.
│   ├── clasificarReclamo.js  # Paso 2: subcategoría (1 llamada por análisis).
│   ├── importers/            # Lectura de tablas, fechas y extracción de ubicación.
│   ├── addressClean.js       # Limpieza de direcciones antes de geocodificar (USIG).
│   ├── geocode.js            # USIG + geocode_cache (lo usa geoWorker.js).
│   ├── territorios.js        # Comuna/barrio por punto-en-polígono (GeoJSON GCBA).
│   ├── geoWorker.js          # Geocodifica reclamos 'pendiente' (cron + post-análisis).
│   ├── reclamosFromAnalysis.js # reclamosGeo de Claude -> filas para la tabla reclamos.
│   ├── monitor.js            # Orquestador del monitoreo (todas las redes) + config.
│   ├── accountStats.js       # Benchmark por cuenta (solo redes con esa capability).
│   ├── metricsRefresh.js     # Refresco de métricas de posteos ya guardados (ídem).
│   ├── classifier.js         # Título + sentimiento de cada posteo (Claude Haiku), para todas las redes.
│   ├── mailer.js             # Envío de emails (alertas + magic link).
│   ├── auth/                 # Allowlist, magic link, sesión, rate limit, gate.
│   ├── notify.js             # Orquesta las notificaciones (email + WhatsApp a futuro).
│   ├── scheduler.js          # Agenda el monitoreo cada 4hs (node-cron).
│   ├── concurrencyLimiter.js # Cola FIFO para los runs simultáneos de Apify.
│   ├── usageContext.js       # En qué ciclo y fase estamos (AsyncLocalStorage), para medir Apify.
│   ├── apifyCost.js          # Tarifas de los dos actores, registro de cada llamada a Apify (estimado y real) y reporte de gasto.
│   └── notifiers/
│       └── whatsapp.js       # Placeholder para notificación por WhatsApp (no implementado).
├── config/
│   ├── monitoring.json       # Cuentas, palabras clave/hashtags y búsquedas por palabra clave, una sección por red (instagram, x).
│   ├── categorias-reclamos.json # Categorías y subcategorías del cliente (26/85).
│   ├── x-influencers/        # CSV ANTIK-PRO (padrón de actores de X).
│   └── allowed-emails.example.txt  # Plantilla de emails que pueden entrar.
├── data/
│   ├── monitoring.db         # Base SQLite (se crea sola, no se versiona).
│   └── geo/                  # Cache en disco de comunas.geojson y barrios.geojson (GCBA).
├── public/
│   ├── index.html            # Login (pide un magic link por email).
│   ├── login-verify.html     # Confirma el link (POST, un solo uso).
│   ├── dashboard.html        # Selector de red social.
│   ├── instagram.html        # App Instagram: análisis + monitoreo + mapa de reclamos (tabs).
│   ├── x.html                # App X: análisis (Grok) + monitoreo + mapa de reclamos.
│   ├── css/styles.css        # Estilos (paleta oscura corporativa).
│   └── js/
│       ├── main.js           # Tabs + dropdown de usuario (sesión / logout).
│       ├── login.js          # Pedido del magic link.
│       ├── analysis.js       # Lógica de "Análisis de publicación" (Instagram).
│       ├── x-analysis.js     # Análisis de publicación de X (`/api/x/analyze`).
│       ├── temasEditor.js    # Temas emergentes editables (antes de copiar/WhatsApp).
│       ├── monitoring.js     # Monitoreo en vivo (parametrizado por data-platform).
│       └── claimsMap.js      # Mapa de reclamos (Leaflet, filtrado por plataforma).
├── scripts/
│   ├── import-reclamos.js       # Importador genérico de Excel/CSV (solo CLI).
│   ├── migrate-categorias.js    # Migra categorías viejas al esquema de dos niveles.
│   ├── costo-apify.js           # Gasto en Apify por ventana, fase y actor (npm run costo).
│   └── stop-server.js           # Mata el proceso que ocupa el puerto (npm run stop).
├── CLAUDE.md                  # Guía corta del proyecto para trabajar con Claude Code.
├── .env.example               # Plantilla de las claves (copiala a .env).
├── .gitignore                 # Evita subir node_modules, .env y data/.
└── package.json                # Dependencias y scripts del proyecto.
```

### Qué hace cada archivo

- **`server.js`**: levanta el servidor, sirve la web y expone las rutas de la
  API (análisis puntual + monitoreo). Arranca el cron al iniciar.
- **`src/apify.js`**: habla con la API de Apify. Corre el actor
  `apify/instagram-scraper` (modo `comments` y modo `posts`) usando el
  endpoint **sincrónico** `run-sync-get-dataset-items`. También expone
  `runActorSync` para que el adapter de Instagram
  (`src/platforms/instagram.js`) lo reuse, y marca los errores de clave,
  rate limit y cuota con `code` (ver `src/platforms/errors.js`).
- **`src/analyzeComments.js`**: muestra estable, prompt, llamada al proveedor LLM,
  validación y armado del reporte WhatsApp + CSV.
- **`src/prompt.js`**: contiene la metodología completa de análisis (el
  "system prompt"). Separado para que sea fácil de ajustar.
- **`public/index.html` + `dashboard.html` + `instagram.html` + `css/` + `js/`**: la
  interfaz (login con magic link → dashboard → app Instagram con tabs), separada en
  estructura/estilo/comportamiento.

### Login (allowlist + magic link)

Solo entran emails de la allowlist. El archivo
`config/allowed-emails.txt` (no se versiona; copiá el `.example.txt`) se puede
editar a mano, un email por línea. En producción (Railway) usá también
`ALLOWED_EMAILS` en las variables de entorno: un email entra si está en el
archivo **o** en el env. Los cambios al archivo aplican en el próximo intento,
sin reiniciar.

Flujo: la persona pone su email → si está autorizado se manda un link (15 min,
un solo uso) → abre el mail y hace clic en **Entrar**. La respuesta de la API
es la misma aunque el email no esté en la lista (no se enumeran los autorizados).

Hace falta `SESSION_SECRET` (string largo aleatorio) y `APP_BASE_URL` (p. ej.
`http://localhost:3000`). El SMTP es el mismo de las alertas (`SMTP_*`).

### Monitoreo automático — archivos nuevos explicados

- **`config/monitoring.json`**: qué se monitorea, con una sección por red
  registrada en `src/platforms/` (`instagram`, `x`), cada una con sus
  `accounts` (usuarios de esa red a trackear), `keywords` (palabras clave o
  hashtags, estos últimos empezando con `#`) y, en Instagram, `searches`
  (búsquedas por palabra clave). Se puede editar a mano, o desde la propia
  web (solapa "Monitoreo en vivo" → agregar/quitar; cada solapa escribe su
  sección). Formato y semántica de cada campo en `config/README.md`. La
  relevancia de lo que traen esas fuentes se decide igual para todas las
  redes (ver `src/monitor.js` más abajo).

  **Las cuatro fuentes de detección de Instagram** y qué cuesta cada una:
  1. **Cuentas trackeadas** (`accounts`): el perfil de cada una, una
     consulta por cuenta y por ciclo.
  2. **Hashtags** (`keywords` que empiezan con `#`): la página del hashtag,
     una consulta por hashtag y por ciclo. Trae todo lo que lo usa: se filtra.
  3. **Búsquedas por palabra clave** (`searches`, actor apidojo): la búsqueda
     nativa de Instagram para ese término, una consulta por término y por
     ciclo. También se filtra. Pocos términos, elegidos a mano. La búsqueda
     devuelve los posteos recortados (sin caption ni contadores): a los
     resultados nuevos se les pide el detalle en una sola consulta por ciclo
     antes de filtrarlos (ver "Detalle de los resultados de búsqueda").
  4. **Keywords sin `#`** (`keywords`): NO son una fuente, son el **filtro de
     texto gratuito** que decide si lo que trajeron las otras tres habla del
     tema (más la detección semántica del clasificador cuando no hay
     coincidencia literal). Son 60 y pico; buscarlas todas sería carísimo.

  En X es distinto: cada keyword, con `#` o sin él, es una búsqueda de Grok
  con costo por corrida, y no hay lista `searches`.

- **`src/db.js`** — ¿qué es SQLite y por qué lo usamos así?: SQLite es una
  base de datos que vive en **un solo archivo** (`data/monitoring.db`), sin
  necesidad de instalar ni correr ningún servidor de base de datos aparte
  (a diferencia de Postgres/MySQL). Para este volumen (unos pocos posteos
  nuevos cada 4hs) es más que suficiente. En vez de la librería
  `better-sqlite3` usamos el módulo **`node:sqlite`**, que viene incluido en
  Node desde la versión 22.5 — esto evita tener que compilar código nativo
  (que en Windows requiere Visual Studio Build Tools, algo que esta PC no
  tenía instalado). Acá vive la tabla `detected_posts`, que guarda cada
  posteo relevante ya visto para no volver a notificarlo dos veces. La cruz
  de cada fila **ignora** el posteo (la fila queda con `ignored = 1`): deja
  de verse en la tabla, pero sigue bloqueando una re-detección de la misma
  URL.

- **`src/monitor.js`**: el orquestador del monitoreo, agnóstico de red. Por
  cada plataforma registrada en `src/platforms/` lee su sección de
  `config/monitoring.json` y le pide a su adapter los posteos recientes de
  cada cuenta trackeada, de cada hashtag, de cada búsqueda por palabra clave
  (`searches`, solo si el adapter sabe buscar) y — solo si el adapter sabe
  buscarlas — de cada keyword suelta. Compara todo contra `src/db.js` para
  no volver a evaluar ni guardar algo que ya se vio. Antes de guardar una
  cuenta o hashtag nuevo (al agregarlo desde la interfaz) el adapter valida
  lo que puede: Instagram consulta a Apify que exista (el actor no tira un
  error HTTP, devuelve un item con `"error": "not_found"` o `"no_items"`);
  X solo chequea el formato del handle, porque un modelo no puede afirmar
  que una cuenta no existe.

  **Cómo decide si un posteo es relevante** (en `evaluateRelevance`, igual
  para todas las redes):
  1. Si llegó por una **búsqueda por término** (hoy solo X: sus keywords y
     también sus hashtags, porque en X un hashtag es una búsqueda más, no una
     página de descubrimiento como en Instagram) → relevante directo: la
     búsqueda ya lo encontró para ese término, descartarlo después sería
     perder lo que la búsqueda validó. Solo se le ponen título y sentimiento.
  2. Si el caption/hashtags contienen alguna palabra clave configurada
     literalmente → relevante directo.
  3. Si no hay coincidencia literal → le pregunta a **Claude** si el
     contenido igual habla del Jefe de Gobierno porteño o de su gestión,
     sin necesidad de que lo nombre explícitamente (`classifyRelevance` en
     `src/classifier.js`). Así se detectan menciones indirectas (ej. un
     anuncio de una política de vivienda que no dice su nombre) que el
     matching de texto solo, se perdería.
     Un posteo sin caption (nada que evaluar) solo se acepta si viene de una
     cuenta trackeada — de un hashtag o una búsqueda se descarta, porque no
     hay ninguna señal de que se relacione con el tema.
     **Detalle de los resultados de búsqueda**: la búsqueda por palabra clave
     de apidojo devuelve objetos recortados, con `caption`, likes y
     comentarios en null aunque el posteo los tenga (verificado con el mismo
     reel pedido por URL). Antes de evaluar relevancia,
     `enrichSearchResults` junta los resultados de búsqueda sin texto que
     son NUEVOS (no están en `detected_posts` ni en la tabla `search_seen`)
     y pide su detalle en **un solo run por ciclo** de
     `apify/instagram-scraper` con todas las URLs (`fetchPostDetails`, fase
     `busqueda`), porque cobra por resultado (0,0023 por posteo en Starter)
     contra 0,005 de la consulta de posteo suelto de apidojo. El caption,
     los hashtags y los contadores del detalle se vuelcan sobre el mismo
     posteo, que sigue siendo de la búsqueda (`Búsqueda: <término>`), y
     recién ahí corre el filtro de siempre. `SEARCH_ENRICH_LIMIT` (default
     20, `0` lo apaga) es el tope por ciclo: van los más nuevos y el resto
     entra en el ciclo siguiente. Cada posteo se paga una sola vez:
     `search_seen` anota lo consultado con su resultado (`guardado`,
     `descartado`, `sin_caption`, `sin_detalle`) y un descartado no se vuelve
     a consultar ni a evaluar; la tabla se purga a los 30 días. Si el run de
     detalle falla entero no se anota nada y se reintenta en el próximo
     ciclo.
     La búsqueda por palabra clave de Instagram (`searches`) NO entra por el
     camino 1: Instagram asocia al término mucho contenido ajeno, así que sus
     resultados pasan por el 2 y el 3 como los de un hashtag, con el motivo
     `Búsqueda: <término>`. Si el mismo posteo llega por una cuenta trackeada
     y por una búsqueda en el mismo ciclo, queda como de la cuenta trackeada.

- **`src/platforms/`**: un adapter por red, con el contrato documentado en
  `index.js` (`id`, `label`, `capabilities`, `isConfigured`, `scrapeAccount`,
  `scrapeHashtag`, `scrapeKeyword` opcional, `normalizePost`, `metrics`,
  errores con `code`). Sumar una red es escribir su adapter y registrarlo.
  - **`instagram.js`**: fachada sobre dos proveedores con la misma interfaz,
    elegidos por `IG_ACTOR` (`src/platforms/igActor.js`): `instagramApidojo.js`
    (default, actor `apidojo/instagram-scraper-api`: cobra por consulta, trae
    los seguidores en cada posteo de perfil y busca por palabra clave con
    `scrapeSearch`) e `instagramApify.js` (actor `apify/instagram-scraper`, el
    de siempre: cobra por resultado, seguidores por consulta aparte, sin
    búsqueda). Tiene todas las capabilities: benchmark por cuenta, seguidores
    y refresco de métricas. Ver "Septiembre 2026: cambio de actor de
    monitoreo" en las decisiones técnicas.
  - **`x.js`**: trae con **Grok** (búsqueda en X vía OpenRouter o xAI):
    `from:handle` por cuenta, `#hashtag` y el texto literal de cada keyword;
    hashtags y keywords son búsquedas por término, así que lo que traen es
    relevante directo (ver arriba). Tope `X_MONITOR_RESULTS_LIMIT` (default
    30, máximo 50) por fuente. No usa Apify. Grok **solo extrae**: título y
    sentimiento van por el mismo `src/classifier.js` que Instagram (y por lo
    tanto por `LLM_PROVIDER`). Métricas propias: respuestas (en el lugar de
    comentarios), RTs y vistas. Sin seguidores ni refresco de métricas por
    ahora.

  El cron recorre todas las redes; "Actualizar ahora" en una solapa corre
  solo esa red, y el benchmark y el refresco de métricas corren solo para las
  redes cuyo adapter declara esa capability (hoy Instagram).

  Si una red falla entera —clave inválida, rate limit o cuota agotada, que
  los adapters marcan con `code` (ver `src/platforms/errors.js`)— "Actualizar
  ahora" en esa solapa muestra ese error en vez de un "0 nuevos" engañoso;
  lo que las otras fuentes sí trajeron queda guardado igual y el mensaje lo
  aclara. En el cron la red se anota como incompleta y se sigue con las
  demás. Un fallo puntual de una sola fuente (cuenta privada, etc.) solo se
  loguea, como siempre.

  **Pendiente — benchmark de X.** El adapter de X declara
  `capabilities.benchmark: false`: la tabla de X muestra sus métricas pero
  sin la referencia "alto/normal/bajo" contra la mediana de la cuenta. Los
  datos están (likes, respuestas, RTs y vistas por posteo, y `account_stats`
  acepta filas de X sin tipo de posteo); falta decidir la fuente de la
  mediana (una búsqueda de Grok por cuenta) y sumar medianas de RTs/vistas.
  Cuando se haga, alcanza con activar la capability en `src/platforms/x.js`.

- **`src/accountStats.js`**: el **benchmark por cuenta** (solo en redes cuyo
  adapter declara `capabilities.benchmark`, hoy Instagram): la mediana de
  likes y comentarios de los últimos 3 meses de ESA cuenta, por tipo de
  posteo más una global de fallback, contra la que cada posteo de la tabla
  se clasifica como alto/normal/bajo. Se guarda en `account_stats`.

  **Cuándo se calcula.** Una cuenta se (re)calcula SOLO cuando aparece con
  un posteo nuevo en el monitoreo (`detected_posts`) y, además, nunca se
  calculó o ese posteo se detectó `BENCHMARK_RECALC_DAYS` (default 90) o
  más días después del último cálculo. Vale igual para trackeadas y para
  cuentas llegadas por hashtag: scrapear una trackeada sin guardar ningún
  posteo relevante no dispara nada; agregar una cuenta trackeada tampoco
  (queda sin referencia hasta su primera publicación relevante, y ahí se
  calcula en ese mismo ciclo); una cuenta que no vuelve a aparecer conserva
  su mediana sin volver a pagarla. La condición sale de la base (fecha de
  detección del posteo contra fecha del último cálculo), no de estado en
  memoria. El benchmark corre después de guardar los posteos del ciclo, así
  el posteo de una cuenta nueva ya sale con referencia en la tabla.

  Tope `MAX_ACCOUNTS_PER_CYCLE` (default 10) por ciclo: si aparecen muchas
  cuentas pendientes de golpe, las que quedan afuera siguen pendientes y
  salen en los ciclos siguientes, en orden de llegada. Un intento que no
  trae 5 posteos recientes (cuenta privada, publica poco, la fuente
  devolvió vacío) no borra la referencia anterior: la conserva y solo
  anota la fecha, para no reintentar en cada ciclo. La misma pasada trae
  los seguidores de la cuenta y actualiza métricas de sus posteos ya
  guardados, así que `BENCHMARK_RECALC_DAYS` es también la cadencia máxima
  de seguidores; una cuenta que no reaparece no los actualiza.

  Carga manual o recálculo forzado, sin este criterio:
  `node scripts/recalc-account-stats.js <cuenta>`, `--todas` o
  `--pendientes` (ver el encabezado del script).

- **`src/classifier.js`**: acá vive el llamado a **Claude Haiku 4.5** (modelo
  barato, configurable con `CLASSIFIER_MODEL`) para dos cosas: `classifyPost`
  (título + sentimiento de un posteo que ya se sabe relevante) y
  `classifyRelevance` (título + sentimiento + si aplica o no, para posteos
  sin coincidencia literal — ver arriba). Todo a partir del caption, no de
  los comentarios de la gente (eso sigue siendo un análisis aparte, manual,
  en "Análisis de publicación"). Si el clasificador falla, el posteo no se
  descarta: se guarda marcado como "sin clasificar" para revisarlo a mano
  (ver "Cuando falla el clasificador del monitoreo", más abajo).

- **`src/scheduler.js`** — ¿qué es un "cron" y por qué `node-cron`?: un cron
  es simplemente "una tarea que se repite sola cada tanto tiempo", sin que
  nadie tenga que apretar un botón. Usamos la librería **node-cron** porque
  es chica, no necesita base de datos propia ni configuración compleja: solo
  le decís un horario (acá, `0 */4 * * *` = cada 4 horas) y una función para
  correr. Vive dentro del mismo proceso de `server.js`.

  > ⚠️ **Esto SOLO funciona mientras el servidor esté corriendo sin cortes.**
  > Hoy la app corre con `npm start` en esta PC — si cerrás la terminal o la
  > PC se suspende, esa corrida del monitoreo se saltea en silencio. El día
  > que se despliegue a un hosting siempre encendido (Render, Railway, un
  > VPS, etc.), no hace falta cambiar nada de este código.
  >
  > **¿Por qué no usar los "Schedules" de Apify en vez de esto?** Apify puede
  > disparar el actor en su propia nube aunque tu PC esté apagada, pero el
  > resultado solo te lo puede avisar vía un **webhook HTTPS público** —
  > `localhost` no puede recibir eso. Es decir, en la práctica igual
  > necesitarías un servidor accesible desde internet, así que no evita el
  > problema del hosting, solo lo movería. El costo de scraping (por
  > resultado) es el mismo en ambos casos.

- **`src/mailer.js`**: manda el email con **Nodemailer + Gmail SMTP**
  (recomendado para arrancar: gratis, confiable, solo requiere generar una
  ["contraseña de aplicación"](https://myaccount.google.com/apppasswords) en
  tu cuenta de Google — la contraseña normal no funciona para SMTP). Límite
  ~500 emails/día, de sobra para este uso.

- **`src/notifiers/whatsapp.js`** y **`src/notify.js`**: `notify.js` orquesta
  el envío (hoy: email, mañana: también WhatsApp); `whatsapp.js` es un
  placeholder sin implementar todavía, a la espera de definir el proveedor
  (WhatsApp Business API, Twilio, etc.).

### 💸 Costo en Apify del monitoreo

El monitoreo de Instagram corre con el actor que elija `IG_ACTOR`
(`apidojo/instagram-scraper-api` por defecto; `apify/instagram-scraper` con
`IG_ACTOR=apify`). Cobran distinto:

- **apify/instagram-scraper** cobra **por resultado devuelto** (item del
  dataset, incluidos los items de error `no_items` / `not_found`): entre
  US$ 1,90 y 2,70 por cada 1.000 según el plan (`APIFY_RATE_*`).
- **apidojo/instagram-scraper-api** cobra **por consulta**, con posteos
  incluidos, más US$ 0,0005 por cada posteo de más (`APIDOJO_*` en el
  `.env`): perfil 0,005 con 10 incluidos, hashtag 0,015 con 30, búsqueda por
  palabra clave 0,015 con 20, posteo suelto 0,005. Uso de plataforma incluido.

Con los topes por defecto (`MONITOR_ACCOUNT_LIMIT=10`,
`MONITOR_HASHTAG_LIMIT=30`, `SEARCH_RESULTS_LIMIT=50`,
`BENCHMARK_POST_LIMIT=15`), una llamada por fuente y el oficial en plan
Starter (2,30 por 1.000):

| Operación | apify/instagram-scraper | apidojo/instagram-scraper-api |
|---|---|---|
| Cuenta trackeada por ciclo, con posteos nuevos | hasta 0,0345 (15 res.) | 0,005 (10 incl.) |
| Cuenta trackeada por ciclo, sin novedades | 0,0023 (1 item de error) | 0,005 |
| Hashtag por ciclo | 0,0345 | 0,015 (30 incl.) |
| Búsqueda por palabra clave, 50 resultados | no existe | 0,030 |
| Detalle de un resultado de búsqueda nuevo (una sola vez por posteo) | 0,0023, siempre con este actor | — (0,005 si se pidiera acá) |
| Benchmark de una cuenta (15 posteos + seguidores) | 0,0368 (+1 consulta de perfil) | 0,0075 |
| Refresco de métricas de una cuenta (15 posteos) | 0,0345 | 0,0075 |
| Validar una cuenta / un hashtag al agregarlos | 0,0023 / 0,0023 | 0,005 / 0,015 |

Con 12 cuentas y 1 hashtag, la detección de un ciclo cuesta 0,075 con
apidojo contra 0,06 típico (0,45 en el peor caso) con el oficial: el ahorro
grande está en hashtags, benchmark y refresco, y la búsqueda por palabra
clave solo existe en apidojo. El detalle de los resultados de búsqueda suma
como mucho `SEARCH_ENRICH_LIMIT` × 0,0023 por ciclo (0,046 con el default
de 20) y en régimen mucho menos: solo se paga por posteos que la búsqueda
trae por primera vez. Para bajar el costo: menos hashtags y búsquedas, topes
más chicos, o espaciar el cron (`MONITOR_CRON`).

El benchmark por cuenta (`src/accountStats.js`) solo gasta cuando una cuenta
aparece con un posteo nuevo y nunca se calculó o pasaron
`BENCHMARK_RECALC_DAYS` desde el último cálculo, como mucho
`MAX_ACCOUNTS_PER_CYCLE` cuentas por ciclo. Con apidojo los seguidores
vienen en esa misma consulta; con el oficial es una consulta de perfil
aparte. Una cuenta que no vuelve a aparecer no cuesta nada.

#### Medir lo que se gasta de verdad

Lo de arriba es la estimación; la app además **registra cada llamada a
Apify** (`src/apifyCost.js`, todas pasan por `runActorSync`):

- `apify_calls`: una fila por llamada, con la fase, el ciclo (`run_id`), el
  `actor`, el tipo de consulta (`query_type`: `user`, `hashtag`, `search`,
  `post`, `details`), qué se pidió (`target`), cuántos items devolvió Apify,
  si salió bien, el error si no (`QUOTA_EXCEEDED` cuando fue la cuota), la
  duración, el `usd` estimado y, para el actor apidojo, `usd_real` (lo que
  Apify cobró por ese run, `usageTotalUsd`) y `apify_run_id`.
- `monitoring_runs`: una fila por ciclo (cron o "Actualizar ahora"), con
  posteos nuevos, llamadas, resultados, usd y si alguna llamada cortó por
  cuota. Al cerrar cada ciclo el server imprime
  `[costo] ciclo #N: X llamadas, Y resultados ≈ US$ Z (monitoreo A · busqueda B · benchmark C · refresco D)`,
  con el total ESTIMADO en dólares (el real se concilia después, ver abajo)
  y el desglose en resultados por fase.

Las fases son `monitoreo`, `busqueda`, `benchmark` y `refresco` dentro del
ciclo (`src/scheduler.js` y `src/monitor.js` las marcan con
`src/usageContext.js`), y fuera de él `validacion` (agregar cuenta o
hashtag), `recalc-script` (`scripts/recalc-account-stats.js`) y `analisis`
(análisis de una publicación). Una llamada sin fase conocida queda como
`desconocida`.

**Costo real.** El endpoint sincrónico de Apify no devuelve el id del run,
y lo que Apify cobró de verdad solo se lee del objeto del run. Por eso las
llamadas al actor apidojo van por el flujo asincrónico (arrancar el run,
esperar y bajar sus items: dos o tres requests en vez de una, sin costo
extra) y la fila guarda el `apify_run_id`. El cobro NO está asentado cuando
el run termina: en el primer ciclo real, leído en ese momento, 10 de 29
llamadas daban 0 y a las demás les faltaban los posteos extra; minutos
después el total era 0,1945 usd y no 0,125. Por eso `usd_real` se
**concilia después**: al cerrar cada ciclo el scheduler relee los runs de
las llamadas de más de 10 minutos (`apifyCost.reconcileRealCosts`, lecturas
gratis de la API, no son runs), guarda `usageTotalUsd` y corrige el usd del
ciclo en `monitoring_runs`. `node scripts/costo-apify.js --conciliar` hace
lo mismo a mano. `APIFY_REAL_COST=0` lo apaga (vuelve al endpoint
sincrónico, sin run id). El actor oficial sigue con el sincrónico y sus
filas no tienen `usd_real`. Dato del ciclo real: la consulta de perfil
cobró posteos extra recién a partir del 13 (15 posteos = 0,0065), y la
búsqueda se cobra como consulta de hashtag (`tag-query`).

Tarifas en el `.env`: `APIFY_RATE_FREE` (2.70), `APIFY_RATE_STARTER`
(2.30), `APIFY_RATE_SCALE` (1.90) y `APIFY_PLAN` (default `starter`) para el
oficial; `APIDOJO_RATE_USER` (0.005), `APIDOJO_RATE_HASHTAG` (0.015),
`APIDOJO_RATE_SEARCH` (0.015), `APIDOJO_RATE_POST` (0.005),
`APIDOJO_RATE_ITEM` (0.0005) y `APIDOJO_INCLUDED_USER` (10), `_HASHTAG`
(30), `_SEARCH` (20) para apidojo. El reporte recalcula las filas del
oficial desde los resultados con las tres tarifas a la vez (cambiar de plan
no invalida el histórico) y para apidojo usa `usd_real` cuando existe:

```bash
npm run costo
```

```bash
node scripts/costo-apify.js --dias 90
```

Muestra hoy, últimos 7 días y últimos N días (30 por defecto) con llamadas,
resultados y usd, desglosado por actor (las tres columnas por plan solo
aplican al oficial; apidojo muestra estimado y real) y por fase, más la
proyección mensual (promedio diario de los últimos 7 días × 30).
`GET /api/monitoring/costs?days=30` devuelve lo mismo en JSON. Nada de esto
llama a Apify.

---

## ⚙️ Instalación y uso (paso a paso)

### 1. Instalar Node.js

Necesitás **Node.js 22.5 o superior** (trae `fetch` y el módulo `node:sqlite`
incorporados, usado por el monitoreo). Verificá con:

```powershell
node --version
```

### 2. Instalar las dependencias

Parada en la carpeta del proyecto:

```powershell
npm install
```

### 3. Configurar las claves

Copiá `.env.example` a `.env` y completá tus claves:

```powershell
Copy-Item .env.example .env
```

Abrí `.env` y pegá:

- `APIFY_API_TOKEN` → https://console.apify.com/account/integrations
- **Anthropic (default):** `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` → https://console.anthropic.com/settings/keys
- **OpenRouter:** `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY` → https://openrouter.ai/settings/keys
  (los modelos ya vienen con default equivalente al de Anthropic, no hace falta setearlos).
  La misma clave sirve para **traer posteos e hilos de X con Grok** (`OPENROUTER_X_MODEL`,
  default `x-ai/grok-4.3`). Instagram no usa ese modelo. La clasificación del
  monitoreo (título y sentimiento) va por `LLM_PROVIDER` para todas las redes,
  así que monitorear X necesita, además de la clave de Grok, el proveedor de
  `LLM_PROVIDER` configurado.
- `XAI_API_KEY` → opcional; solo si no usás OpenRouter y querés pegarle directo a https://console.x.ai/
- `SMTP_USER` / `SMTP_PASS` → tu Gmail y una
  ["contraseña de aplicación"](https://myaccount.google.com/apppasswords)
  (alertas del monitoreo y magic link de login)
- `ALERT_EMAIL_TO` → a quién avisar cuando aparezca un posteo relevante
- `SESSION_SECRET` → firma de la cookie de sesión (obligatorio para entrar)
- `APP_BASE_URL` → URL pública de la app, sin barra final (el link del mail
  se arma con esto, no con el header Host)
- `ALLOWED_EMAILS` → opcional; emails extra separados por coma

El geocoding del mapa de reclamos usa USIG (servicio del GCBA) y no necesita
ninguna clave.

### 4. Arrancar la app

```powershell
npm start
```

Vas a ver: `✅ Servidor listo en http://localhost:3000`

Para cortar el proceso (también si quedó huérfano y el puerto 3000 no se libera):

```powershell
npm run stop
```

Abrí esa dirección en el navegador, pedí un magic link con un email de la
allowlist, entrá, y en Instagram pegá el link de una publicación y hacé clic
en **Analizar publicación**. En el dashboard, **X** abre el mismo flujo para
un posteo de x.com (hace falta `OPENROUTER_API_KEY`, la misma de siempre).

El padrón ANTIK-PRO se carga solo al arrancar si la tabla está vacía, desde
`config/x-influencers/`. Para forzar un reimport:

```powershell
npm run import-x-influencers
```

### 5. Reclamos del mapa

El mapa se alimenta solo: cada vez que analizás una publicación
("Análisis de publicación"), los comentarios con una dirección concreta
quedan guardados como reclamos en `geo_status = 'pendiente'`, y se
geocodifican con USIG poco después (sin bloquear la respuesta del análisis).
También corren cada 4hs junto con el cron de monitoreo, por si algo quedó
pendiente por una falla transitoria de USIG.

Para cargar un lote desde un Excel o CSV está el **importador genérico**, que
detecta las columnas solo y no depende del formato de un archivo puntual:

```powershell
npm run import-reclamos -- data/import/archivo.xlsx --dry-run --muestra 20
npm run import-reclamos -- data/import/archivo.xlsx --muestra 20
```

Ver **"Importar reclamos desde Excel o CSV"** más abajo para las opciones,
qué hace con cada fila y cómo revertir una importación.

---

## 🧠 Decisiones técnicas (para tener en cuenta)

### ¿Por qué el endpoint sincrónico de Apify?

Usamos `run-sync-get-dataset-items`: una sola llamada HTTP que espera el
resultado. Es **mucho más simple** que el flujo asincrónico (arrancar el run →
consultar el estado en un bucle → pedir el dataset). Para los comentarios de un
posteo suele terminar en 1-2 minutos, debajo del límite (~5 min) que Apify
mantiene la conexión abierta.

> Si algún posteo tuviera tantísimos comentarios que el scraping superara ese
> límite, la corrida se cortaría. Para ese caso extremo convendría el flujo
> asincrónico. Para este uso, el sincrónico es la opción correcta.

### ¿Por qué dos corridas de Apify?

Una en modo `comments` (los comentarios) y otra en modo `posts` (caption, likes,
comentarios totales, reproducciones, autor). Corren **en paralelo**, así que casi
no suma tiempo. Además, en la corrida de comentarios activamos `addParentData`
como respaldo por si la de `posts` no trajera datos. Las dos pasan por la cola
de runs simultáneos (abajo) y siguen corriendo a la vez mientras haya lugar.

### Runs simultáneos de Apify (cola global)

El plan Free de Apify permite **5 Actor runs a la vez**. La detección del
monitoreo lanza todas las fuentes de Instagram juntas (12 cuentas más
hashtags), así que sin control varias fallaban con `402
concurrent-runs-limit-exceeded` y esas fuentes se perdían ese ciclo. Todas las
llamadas a Apify de la app (detección, benchmark, refresco de métricas,
análisis a demanda, validación de cuentas y hashtags) pasan por una cola
única en `src/apify.js` (`runActorSync`, con `src/concurrencyLimiter.js`):
como mucho `APIFY_MAX_CONCURRENT` corridas en vuelo (default 3, que deja
margen para que dos cosas corran a la vez sin llegar a 5), el resto espera su
turno en orden de llegada. El lugar se retiene mientras dura el run, porque
el endpoint sincrónico mantiene la conexión abierta hasta que el actor
termina.

Si igual llega un 402 por runs simultáneos (otro proceso con el mismo token,
o el tope del `.env` demasiado alto), esa llamada espera
`APIFY_RETRY_DELAY_MS` (default 5 s) y reintenta **una sola vez** sin soltar
su lugar; si vuelve a fallar, sale como error `RATE_LIMITED`: en "Actualizar
ahora" se muestra, después de guardar lo que sí llegó, y en el cron se anota
y se sigue.

Efecto en el tiempo: con 13 fuentes y tope 3, un ciclo de Instagram pasa de
un minuto a unos 3-5 (cada corrida de 15 posteos tarda 30-60 s). El botón
"Actualizar ahora" espera esa respuesta, como siempre.

### Progreso real de "Actualizar ahora"

Mientras el ciclo corre, `src/monitoringProgress.js` guarda en memoria la
fase actual (detectando posteos nuevos, detalle de búsquedas, clasificando
relevancia, benchmark de cuentas, refrescando métricas), cuánto de esa fase
se completó y un porcentaje global = trabajo completado / trabajo conocido
hasta ese momento (se recalcula cada vez que una fase arranca y suma su
propio total). `GET /api/monitoring/progress` (mismo control de acceso que
el resto de `/api/monitoring`) devuelve `{ phase, done, total, percent }` o
`null` si no hay ningún ciclo corriendo. El frontend (`public/js/monitoring.js`)
lo consulta cada 1,5 s mientras espera la respuesta de "Actualizar ahora" y
pinta la fase y el porcentaje reales en la misma tarjeta de siempre — ya no
hay frases fijas rotando ni una barra que avanza sola.

Cuentas, hashtags, búsquedas por palabra clave y keywords (X) se lanzan
todas juntas (`Promise.allSettled`), no son fases secuenciales de verdad:
se muestran combinadas en una sola fase visible, "Detectando posteos
nuevos", con un tick por cada llamada que termina. Una fase sin trabajo
(ej. benchmark en un ciclo de solo X, que no tiene esa capability) nunca se
anuncia — no hace falta ningún caso especial por plataforma: la solapa de X
muestra progreso real en "Detectando posteos nuevos" y "Clasificando
relevancia" igual que Instagram, y simplemente no pasa por las fases que su
adapter no tiene.

### Benchmark y refresco de métricas en paralelo

`refreshStaleAccountStats` (`src/accountStats.js`) y `refreshPostMetrics`
(`src/metricsRefresh.js`) lanzan todas sus cuentas juntas con
`Promise.allSettled`, igual que la detección con sus fuentes, en vez de un
`for` secuencial. Cada uno regula cuántas llamadas van a la vez con SU
PROPIO limitador (`benchmarkLimiter`, `refreshLimiter`; mismo valor de
`APIFY_MAX_CONCURRENT`, instancia separada del `apifyLimiter` de
`src/apify.js` — ver más abajo "Cuelgue real (~30 min)..." para por qué
NUNCA tiene que ser la misma instancia). Los topes por ciclo
(`MAX_ACCOUNTS_PER_CYCLE`, `MAX_ACCOUNTS_PER_REFRESH`),
la prioridad de posteos recientes del refresco, `rememberFollowers`, el
registro de costos, las escrituras a la base y el detector de saltos
siguen igual; solo cambia que las cuentas se piden en paralelo. Corte por
cuota: apenas una llamada devuelve `QUOTA_EXCEEDED`, un flag compartido
hace que ninguna cuenta todavía no arrancada llegue a llamar a la fuente
(las que ya estaban en vuelo terminan). El benchmark automático (antes solo
lo tenía el refresco) ahora también corta así, en vez de reintentar cada
cuenta igual hasta agotar la lista.

### Cuelgue real (~30 min) y diagnóstico: dos limitadores nunca deben ser el mismo

Un ciclo real quedó colgado ~30 minutos y hubo que matar el proceso a mano.
Causa: la primera versión de "benchmark y refresco en paralelo" (arriba)
envolvía cada cuenta en el MISMO `apifyLimiter` que usa `runActorSync` más
adentro. Con `APIFY_MAX_CONCURRENT` cuentas en vuelo ocupando **todos** los
cupos de ese limitador, cuando cada una intenta su propia llamada real a
Apify, esa llamada pide OTRO cupo del mismo limitador — que ya está
agotado por las propias cuentas que están esperando esa llamada. Ninguna
termina nunca: un deadlock real, no un cuelgue de red.

**Arreglo**: `accountStats.js` y `metricsRefresh.js` tienen su propio
limitador (`benchmarkLimiter`, `refreshLimiter`; mismo valor de
`APIFY_MAX_CONCURRENT`, instancia **separada** de `apifyLimiter`). Compartir
el número entre capas está bien; compartir la cola no. `src/concurrencyLimiter.js`
documenta esto en su encabezado, y `test/concurrencyLimiter.test.js`
reproduce el deadlock con capas iguales y confirma que capas separadas no
cuelgan.

**Diagnóstico agregado** (siempre activo, sin flag de `DEBUG`):
- `[ciclo] inicio`/`[ciclo] fin` (trigger, plataforma, duración, resultado) en `src/scheduler.js`.
- `[fase] arranca`/`[fase] termina` (duración, N ok, N error) en `src/monitoringProgress.js`, cada vez que una fase empieza o cede lugar a la siguiente.
- `[apify] →`/`[apify] ←` por cada llamada real (fase, target, actor; al resolver, ok/error, duración, items) en `src/apify.js`.
- `[limiter:<nombre>]` cuando una tarea espera cupo, lo adquiere o lo libera (activos/cola), en cualquier `createLimiter`.
- `[heartbeat]`: si pasan 15s sin que termine ninguna llamada mientras un ciclo está en curso, un snapshot de la fase actual y qué target tiene cada tarea activa en `apifyLimiter`, `benchmarkLimiter` y `refreshLimiter` — se repite cada 15s mientras siga sin actividad.
- `APIFY_CALL_TIMEOUT_MS` (default 120000, piso 1000): cada llamada a Apify se corta a los ms configurados si no respondió, libera su cupo y queda en `apify_calls` con `error='TIMEOUT'`, sin tirar abajo el resto del ciclo.

### Ventana de detección dinámica (cuentas y hashtags)

`MONITOR_LOOKBACK` era fijo ("1 day"): si el server estuvo apagado, lo
publicado en el medio no se detectaba. `monitor.detectionWindowFor(platformId)`
calcula, para cuentas y hashtags de cada corrida, una ventana real =
`max(ahora − MONITOR_LOOKBACK_MAX, fin de la última detección exitosa de esa
plataforma)`; sin ninguna corrida previa registrada (o con una de más de
`MONITOR_LOOKBACK_MAX`, default 7 días), se usa directamente ese techo, para
que una caída larga no dispare una recuperación gigante (y su costo). En el
caso normal (cron cada 4hs) la ventana redondea a "1 day", igual que el fijo
de antes — el techo solo se nota después de una caída real. El fin de la
última detección exitosa se guarda en `refresh_state`
(`detection_last_success:<plataforma>`) apenas esa fase termina sin error,
aunque el ciclo completo falle después en benchmark o refresco.

Si la ventana calculada supera 1 día, `MONITOR_ACCOUNT_LIMIT` y
`MONITOR_HASHTAG_LIMIT` de esa corrida suben proporcionalmente
(`raiseLimitForWindow`: factor = días de ventana, nunca más de 5x el tope
configurado) para no perderse posteos por el tope de cantidad en vez de por
fecha — pasado ese factor, seguir subiendo el tope es más costo que señal
real. La consola lo registra cuando no fue la ventana default. Búsquedas
por palabra clave, keywords de X y el benchmark (90 días fijos) NO cambian:
siguen con su propia lógica de siempre.

### Separación por plataforma: la url manda

Regla del producto: una publicación de X nunca se muestra ni se procesa en
la solapa de Instagram, ni al revés. Toda la app ya filtra por la columna
`plataforma` de `detected_posts` (cada solapa manda `?plataforma=` y cada
consulta la usa), pero eso protege la lectura; lo que garantiza que la
etiqueta sea correcta es el guard al **escribir**:
`src/platforms/urlPlatform.js` (`platformForUrl(url)` → `'instagram'` |
`'x'` | `null` por el dominio, subdominios incluidos) y `db.saveDetectedPost`,
que rechaza con `code: 'PLATAFORMA_INCONSISTENTE'` un posteo cuya url es de
otra red que su `plataforma`. Un dominio desconocido no se valida (no es
"Instagram por defecto"). El ciclo (`runMonitoringCycle`) atrapa ese error,
loguea `descartado` y sigue con los demás posteos: un adapter que devolviera
un link ajeno no tira abajo la corrida ni contamina la otra solapa. El
módulo no tiene dependencias porque lo requiere `db.js` (el registro de
adapters lo re-exporta).

**Análisis de publicación**: el mismo módulo tiene `checkAnalyzeUrl(url,
plataforma)`, que `POST /api/analyze` corre con `'instagram'` y
`POST /api/x/analyze` con `'x'` **antes** de pedirle nada a Apify o a Grok.
Un link de otra red responde 400 con "Esta sección solo analiza
publicaciones de Instagram." (o "…de X."), más "Usá la solapa de X/Instagram"
si el dominio es de la otra red conocida; un link de la red pero que no es
una publicación (perfil, story) recibe el mensaje de formato con ejemplo, y
lo que no es una url también. El cliente (`analysis.js`, `x-analysis.js`)
repite solo el chequeo de dominio para avisar al instante sin request; el
server es quien manda.

### Septiembre 2026: cambio de actor de monitoreo

El monitoreo de Instagram pasó de `apify/instagram-scraper` a
`apidojo/instagram-scraper-api` (rama `actor_apidojo`). **Por qué**: el actor
oficial cobra por resultado (2,30 usd por 1.000 en plan Starter, y un
hashtag paga siempre el tope completo) y no tiene búsqueda por palabra
clave, que es la fuente que faltaba para ver menciones fuera de las cuentas
y hashtags que ya conocíamos. apidojo cobra por consulta con posteos
incluidos (una cuenta o un hashtag cuestan lo mismo traigan lo que traigan),
no necesita login ni cookies, trae los seguidores del autor en cada posteo
de perfil y tiene la búsqueda nativa de Instagram.

**Qué se conservó**:

- El análisis de una publicación (comentarios, `src/apify.js`) sigue con
  `apify/instagram-scraper`: apidojo no devuelve comentarios.
- La forma de los datos: `detected_posts.id` (id numérico de Instagram) y
  `url` (`/p/{code}/`) son los mismos en los dos actores, verificado contra
  una corrida real; el dedupe y el refresco de métricas siguen matcheando y
  `post_type` usa los mismos valores (`reel`, `imagen`, `carrusel`). No se
  migró ningún dato.
- El contrato del adapter: el orquestador, el benchmark, el refresco, la
  base y el frontend no saben qué actor hay abajo. `IG_ACTOR=apify` vuelve
  al actor anterior con el comportamiento exacto de antes
  (`src/platforms/instagramApify.js` es el código viejo movido sin cambios).
- La cola de runs simultáneos, el reintento del 402 y el registro de costo,
  que ahora distingue actor y tipo de consulta y guarda el costo real.

**Qué cambió al pasar**: `until` (fecha) en vez de `onlyPostsNewerThan`, con
descarte del lado nuestro de lo anterior a la ventana real y de los fijados
viejos; topes por tipo de fuente (`MONITOR_ACCOUNT_LIMIT`,
`MONITOR_HASHTAG_LIMIT`, `SEARCH_RESULTS_LIMIT`) en vez de
`MONITOR_RESULTS_LIMIT`; seguidores desde los posteos en cualquier fase en
vez de una consulta de perfil aparte; la lista `searches` y la fase
`busqueda`. Validar una cuenta o un hashtag al agregarlos cuesta 0,005 y
0,015 usd respectivamente (antes, un resultado cada uno).

**Lo que quedó en el actor oficial además del análisis**: el detalle de los
resultados de búsqueda. La búsqueda de apidojo devuelve los posteos sin
caption ni contadores; se probó pedir el mismo reel por URL a los dos
actores y los dos traen el texto, pero el oficial cobra 0,0023 por posteo y
acepta varias URLs en un run, contra 0,005 por posteo de apidojo. Por eso
`fetchPostDetails` va siempre por `apify/instagram-scraper`, con cualquier
`IG_ACTOR` (`SEARCH_ENRICH_LIMIT`, tabla `search_seen`).

**Para volver al actor anterior**: `IG_ACTOR=apify` en el `.env` y reiniciar
el server. Las búsquedas por palabra clave configuradas quedan guardadas
pero se ignoran (con un aviso por ciclo) hasta volver a apidojo.

### ¿Qué modelo usa cada tarea?

Hay **dos** tareas con LLM, y cada una tiene su modelo:

| Tarea | Dónde | `anthropic` | `openrouter` |
|---|---|---|---|
| Análisis de publicación | `src/llm/` | `claude-sonnet-5` | `anthropic/claude-sonnet-5` |
| Relevancia + sentimiento del monitoreo | `src/classifier.js` | `claude-haiku-4-5` | `anthropic/claude-haiku-4.5` |

Son **los mismos dos modelos** en ambos proveedores: OpenRouter sólo cambia el
formato del id (prefijo del proveedor y punto en la versión). Cambiar
`LLM_PROVIDER` no cambia qué modelo se usa en cada tarea.

Para pisarlos: `CLAUDE_MODEL` / `CLASSIFIER_MODEL` con `anthropic`, y
`OPENROUTER_MODEL` / `OPENROUTER_CLASSIFIER_MODEL` con `openrouter`. Si elegís
otro modelo para el análisis, tiene que soportar structured outputs —
verificalo en https://openrouter.ai/models (debe listar `structured_outputs`).

`LLM_PROVIDER` sólo acepta `anthropic` u `openrouter`: cualquier otro valor
aborta el arranque en vez de caer en un default silencioso. Lo mismo si falta
la clave del proveedor elegido. Al arrancar, el servidor imprime el proveedor
activo y los dos modelos.

`OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`) permite apuntar
a cualquier gateway compatible con OpenAI, no sólo a OpenRouter.

El costo por análisis es bajo: son unos pocos miles de tokens de entrada
(comentarios) y ~2-3 mil de salida (el reporte).

> **Pendiente — costo estimado en la UI con OpenRouter.**
> `finalizeLlmUsage` (`src/llm/estimateCost.js`) sólo aplica la tabla de
> tarifas cuando el proveedor es `anthropic`. Con `openrouter` el costo sale
> del campo `cost` que devuelve la API; si esa respuesta no lo trae, la UI
> muestra el costo vacío en vez de estimarlo. Workaround: setear
> `LLM_INPUT_USD_PER_MTOK` / `LLM_OUTPUT_USD_PER_MTOK` en `.env`, que tienen
> prioridad sobre todo lo demás. Queda para resolver aparte.

> **Pendiente — la `tematica` de los reclamos no se persiste.**
> `RECLAMO_GEO_SCHEMA` (`src/analysisSchema.js`) obliga al LLM a devolver una
> `tematica` por reclamo: una etiqueta libre y corta ("bache profundo", "luz
> quemada"), más específica que la `categoria`, que es un enum cerrado. Pero la
> tabla `reclamos` no tiene columna para ella: se usa para armar el reporte y
> se descarta al guardar. Si se quisiera filtrar o agrupar por temática fina en
> el mapa, hay que agregar la columna con el mismo patrón incremental que ya
> usa `src/db.js` y pasarla en `buildReclamosFromAnalysis`. Queda para resolver
> aparte.
>
> Distinto es el caso de las columnas del Excel de X (`visualizacion`,
> `c_likes`, `c_retweets`, `c_replies`, `reclamo_reiterado`, `sentimiento`):
> ésas **se descartan a propósito** al importar y no hay intención de guardarlas.

### Categorías y subcategorías de reclamos

El esquema es de **dos niveles**: categoría (26) + subcategoría (85). Vive en
**`config/categorias-reclamos.json`**, no en el código — lo define el cliente y
va a cambiar. El archivo fuente es [`design/CATEGORIAS.pdf`](design/CATEGORIAS.pdf).

Para agregar, sacar o renombrar una categoría **alcanza con editar ese JSON**.
No hay que tocar código ni migrar la base, porque:

- `categoria` y `subcategoria` **no tienen `CHECK`** en la tabla. SQLite no sabe
  alterar un `CHECK`: si la lista estuviera en el esquema, cada cambio del
  cliente obligaría a reconstruir la tabla.
- La validación vive en `src/categoriasConfig.js`, y todo lo que se guarda pasa
  por `normalizeClasificacion()`, llamada desde `db.upsertReclamo()`.

`estado`, `plataforma` y `geo_status` **sí** conservan su `CHECK`: son listas
cortas, estables y definidas por el equipo, no por el cliente.

Reglas de validación, en orden:

| Caso | Resultado |
|---|---|
| Par (categoría, subcategoría) válido | Se guarda tal cual |
| Difiere en mayúsculas o acentos | Se resuelve al texto canónico |
| Categoría del esquema viejo | Se traduce por alias (tabla en `categoriasConfig.js`) |
| Subcategoría que no pertenece a esa categoría | Categoría + **subcategoría vacía** |
| Categoría inexistente | **`Coyuntura / Otros`** |

Todo ajuste se loguea con el id de la fila, para poder rastrearlo.

> **Por qué los alias son una tabla explícita y no una normalización.** El
> archivo histórico trae `"Recuperción de Propiedes "` — dos typos y un espacio
> final — que plegado da `recupercion de propiedes`, distinto de
> `recuperacion de propiedades`. Trim + minúsculas + sin acentos **no** las une:
> el error está en las letras. Por eso los dos textos crudos están mapeados a
> mano a `Seguridad`.

#### Migrar reclamos del esquema viejo

`scripts/migrate-categorias.js` traduce las filas que quedaron con las 9
categorías viejas. Guarda el estado anterior en la tabla `categorias_backup`,
así el revert no depende de acordarse del mapeo:

- `node scripts/migrate-categorias.js --dry-run` — muestra qué haría
- `node scripts/migrate-categorias.js` — migra
- `node scripts/migrate-categorias.js --revert` — vuelve atrás

Es idempotente: correrlo dos veces no duplica ni rompe nada.

### Importar reclamos desde Excel o CSV

```
node scripts/import-reclamos.js data/import/<archivo> [--dry-run] [--muestra N] [--limit N] [--si]
```

- `--dry-run` procesa todo y muestra el resultado **sin escribir en la base**
  (tampoco en la caché de geocoding).
- `--muestra N` toma **N filas válidas por categoría** en vez de importar todo.
  "Válida" = el LLM le encontró una dirección accionable. Si una fila no la
  tiene, sigue buscando hasta juntar las N o llegar al tope de **5N filas
  evaluadas** por categoría; si no llegó, avisa cuántas consiguió.
- `--limit N` procesa sólo las primeras N filas (para probar barato).
- `--si` saltea la confirmación (para correr desatendido).
- `--map campo=Columna` fuerza el mapeo de una columna.

Antes de llamar al LLM muestra el **costo estimado** y pide confirmación.

**El resumen distingue por qué cada fila llega o no al mapa**, que es lo que
permite ver si el pipeline anda bien o si hay algo roto:

| Motivo | Qué significa |
|---|---|
| con pin | Geocodificada ok, aparece en el mapa |
| sin dirección accionable en el texto | El texto no menciona un lugar al que mandar una cuadrilla |
| con dirección detectada, USIG no la resolvió | Había dirección, pero USIG no le pudo dar un punto |
| con dirección detectada, USIG no la resolvió | Había dirección, pero USIG no le pudo dar un punto (`no_encontrada`) |
| fuera de CABA | Dirección real, de otro partido |
| geocoding pendiente | Falla transitoria de USIG; lo reintenta el worker |

Que **la mayoría de las filas no termine en pin es lo esperable** con este tipo
de dato: las direcciones vienen incompletas, ambiguas o directamente no hay. Un
20–30% de pines sobre el total es normal. El importador geocodifica durante la
corrida (no deja todo en `pendiente`) justamente para poder informar el motivo
de cada fila en el momento, y muestra ejemplos de cada uno.

En modo `--muestra`, las filas evaluadas que quedaron afuera se reportan aparte
con ejemplos: son las que dicen si el criterio de "ubicación accionable" está
bien calibrado o si está descartando de más.

**Detección de columnas.** Busca por nombre tolerando variantes
(`texto|comentario|contenido|mensaje|hit_sentence`, `fecha|date|mes`,
`autor|usuario|cuenta`, `link|url|enlace`, más `direccion`, `categoria`,
`x`, `y`, `comuna`). Si falta alguna obligatoria, **lista las que encontró y
pide el mapeo**, sin escribir nada.

**Qué hace con cada fila:**

| Problema del archivo | Qué hace el importador |
|---|---|
| Texto en mojibake (`QuÃ©`) | Lo repara. Si más del 10% no es reparable, **aborta**: texto corrupto clasifica mal y queda mal para siempre |
| Coordenadas sin punto decimal | Prueba el valor tal cual; si no cae en CABA, inserta el decimal; si tampoco, descarta y manda a USIG |
| Categorías viejas o con typos | Las traduce por la tabla de alias de `categoriasConfig` |
| Fecha con sólo el mes (`ABRIL`) | Guarda el día 1 y marca `precision_fecha = 'mes'` |
| Fecha completa | `precision_fecha = 'exacta'` |
| Columna `direccion` poco confiable | La usa como **pista**; manda el texto y deja que el LLM decida |

**Ninguna fila se pierde.** Las que no llegan al mapa se guardan igual, con el
`geo_status` que explica por qué — incluidas las que en modo `--muestra` quedaron
fuera de la muestra. Saber qué proporción de reclamos **no** es geolocalizable
es un dato en sí mismo, y si algún día mejora la extracción hay contra qué medir
sin volver al archivo.

Se distinguen dos motivos que antes colapsaban en uno:

- `sin_direccion` — el texto no menciona un lugar accionable.
- `no_encontrada` — había una dirección, pero USIG no le pudo dar un punto.

La dirección original del archivo se guarda igual en `direccion_detectada`,
aunque el modelo la descarte, para poder auditar si el criterio está
descartando de más.

**Deshacer una importación.** `--revert` borra las filas que vinieron de ese
archivo, sin tocar el resto de la base:

```
node scripts/import-reclamos.js data/import/<archivo> --revert [--dry-run]
```

Cada fila importada guarda su archivo de origen en `import_origen`. Lo detectado
por el monitoreo o por el análisis de publicaciones tiene ese campo en `NULL` y
nunca se ve afectado, así que revertir una importación que salió mal no exige
restaurar un backup entero.

> **Por qué la columna `direccion` es una pista y no la verdad.** En el
> histórico de X, esa columna salió de un extractor ingenuo: "hasta las **18h**"
> produjo *"Carreras, Santiago de las 18"*, "antes de las **7am**" produjo
> *"...de las 7"*, y "mi hijo vive en **España**" produjo *"España Av."*. En el
> 28% de las filas el nombre de calle **no aparece en ningún lado del texto**, y
> 178 filas comparten la misma calle inventada por la frase "las N". Importarla
> tal cual llenaría el mapa de pines precisos en lugares equivocados.

**Idempotencia y dedupe.** La clave es **link + dirección + categoría**, no sólo
el link: un mismo tuit puede citar varias direcciones, y también aparecer dos
veces con categorías distintas (un texto puede tocar higiene y seguridad a la
vez). Correr el importador dos veces hace upsert, no duplica.

### Qué ubicación es "accionable"

Un reclamo entra al mapa sólo si el comentario menciona un lugar al que se
podría mandar una cuadrilla. El LLM devuelve el tipo en `tipoUbicacion`, y de
ahí sale la `precision` con la que se guarda:

| `tipoUbicacion` | Ejemplo | `precision` |
|---|---|---|
| `calle_altura` | "Juramento 3109" | `exacta` |
| `cruce` | "Nazca y Rivadavia" | `exacta` |
| `tramo` | "Cabildo entre Juramento y Mendoza" | `exacta` |
| `lugar_nombrado` | "Plaza Italia", "Hospital Durand" | **`aproximada`** |

**No** son accionables y no generan reclamo: un barrio solo ("vivo en
Palermo"), una comuna, la ciudad, una provincia o un país, referencias vagas
("por mi casa", "toda la zona") y números que no son altura (horarios, precios,
cantidades). Las reglas están en el system prompt con ejemplos de cada caso.

Un `tramo` se geocodifica por su **primera esquina** (`addressClean.js` lo
convierte a un cruce): un tramo de cuadra no tiene punto propio, y su esquina
inicial cae dentro del tramo mencionado.

> **Pendiente — los lugares con nombre propio no llegan al mapa.**
> `precision: 'aproximada'` ya se asigna bien, pero el servicio de USIG que
> usamos (`/normalizar/`) es un normalizador de **direcciones**, no un
> buscador de lugares: "Plaza Italia" devuelve la calle *Calzada Circular Plaza
> Italia* sin coordenadas, y "Hospital Durand" o "Parque Centenario" no
> devuelven nada. Esos reclamos quedan en `sin_direccion`: se guardan y se ven
> en la lista, pero sin pin.
>
> Para resolverlo harían falta dos piezas: una fuente de coordenadas de lugares
> (los GeoJSON públicos de Buenos Aires Data — espacios verdes, hospitales,
> escuelas — cargados igual que los polígonos de `data/geo`), y después el
> reverse geocoding de USIG
> (`ws.usig.buenosaires.gob.ar/geocoder/2.2/reversegeocoding`), que dado un
> punto devuelve la puerta y la esquina más cercanas con calle y altura.

### Colores del mapa

**Doce colores, no veintiséis.** Con 26 categorías no existen 26 tonos que el
ojo separe de un vistazo: pasando los diez, comparar dos pines se vuelve
adivinanza. Entonces:

- Las **12 categorías más frecuentes de toda la base** se llevan un color fijo.
  Que salga del total y no de lo filtrado es deliberado: si el ranking se
  recalculara con cada filtro, los pines cambiarían de color solos y no se
  podría comparar nada entre dos vistas.
- El resto va al **gris**, que además comunica "cola larga" mejor que un color
  casi repetido. La leyenda lo aclara.
- **Excepción:** si el filtro deja 12 o menos categorías seleccionadas, cada una
  toma color propio — ya no hay ambigüedad posible.

Los colores salen de la paleta del sistema (jade, barro, coral, ámbar) más
análogos en la misma saturación, alternando claros y oscuros para que dos
vecinos en la leyenda no se parezcan. Están en `:root` como `--cat-1` … `--cat-12`
y `--cat-otras`.

**La leyenda muestra sólo las categorías presentes en la vista actual**, con su
conteo. Listar las 26 sería ruido; ocultar alguna dejaría pines sin explicar.

**Un pin agrupa reclamos de una misma dirección**, que pueden ser de categorías
distintas. Se pinta con la **más frecuente de ese punto**, y el popup muestra el
desglose completo — si no, un punto con tres categorías se leería como si fuera
de una sola.

**Pin de borde punteado**: todos los reclamos de ese punto tienen
`precision = 'aproximada'` (un lugar con nombre, no una altura). Con uno solo
exacto el pin va sólido, porque ahí sí hay una ubicación precisa.

El filtro de **subcategoría depende del de categoría**: se puebla sólo con las
subcategorías de las categorías seleccionadas. Con las 26 marcadas serían 85
opciones, una lista imposible de usar.

### Los estados de `geo_status`

Cada reclamo guarda en qué terminó su geocodificación:

| `geo_status` | Qué significa | ¿Aparece en el mapa? |
|---|---|---|
| `pendiente` | Detectado, todavía sin geocodificar | No (hasta que corra el worker) |
| `ok` | Resuelto dentro de CABA, con comuna y barrio | **Sí**, con pin |
| `sin_direccion` | El texto no menciona un lugar accionable | No (queda en la lista, sin pin) |
| `no_encontrada` | Había dirección, pero USIG no le pudo dar un punto | No (queda en la lista, sin pin) |
| `fuera_caba` | Dirección real, pero de otro partido | No — se excluye siempre |
| `invalida` | El texto no parece una dirección (`addressClean.js`) | No |

`fuera_caba` **nunca se muestra ni se exporta**, pase el filtro que pase
(`listReclamosFiltered`). Queda guardado sólo para poder auditar de dónde
vienen las direcciones de afuera, con la dirección normalizada del partido que
la reconoció.

Cómo se distingue `fuera_caba` de `sin_direccion`: USIG es un servicio
exclusivo de CABA y `geocode.js` le agrega `, CABA` a la consulta para evitar
ambigüedades entre partidos. Con ese sufijo, una dirección de Avellaneda y una
dirección inventada devuelven lo mismo — cero resultados. Por eso, cuando CABA
no la reconoce, se hace una **segunda consulta sin el sufijo**: si USIG la
ubica en otro `cod_partido`, es `fuera_caba`; si no la ubica en ningún lado, es
`sin_direccion`. Esa segunda consulta corre sólo en el camino de fallo y queda
cacheada, así que no agrega tráfico al caso normal.

> **Nota si venís de una versión anterior.** Hasta este cambio, las direcciones
> de otros partidos se guardaban como `sin_direccion` y la señal se perdía. Las
> entradas `not_found` que ya estuvieran en `geocode_cache` seguirían
> devolviendo el estado viejo, así que hay que borrarlas una vez para que se
> reevalúen:
>
> ```sql
> DELETE FROM geocode_cache WHERE status = 'not_found';
> ```
>
> Ya se corrió sobre `data/monitoring.db`. Sólo hace falta repetirlo en otra
> copia de la base que venga de antes del cambio.

---

## 🛟 Manejo de errores

La app muestra mensajes claros cuando:

- El link no es una publicación válida de Instagram.
- Falta o es inválida alguna clave (Apify o el proveedor LLM activo).
- Apify falla, se demora demasiado o alcanzó su límite de uso (incluido el
  402 por runs simultáneos, que primero se reintenta una vez; ver "Runs
  simultáneos de Apify" más arriba).
- La publicación no tiene comentarios extraíbles.
- El LLM falla o alcanzó su límite de uso.

Si faltan credenciales, el servidor **no levanta**: aborta con el detalle de
qué variable falta. Antes era un `console.warn` y el problema aparecía a mitad
de un análisis.

### Cuando falla el clasificador del monitoreo

Antes, cualquier error del clasificador devolvía un resultado inventado
(`neutral`, o `relevant: false`). Eso hacía que una API caída se viera igual
que "no hay nada relevante": el monitoreo **descartaba posteos válidos en
silencio**, y sólo quedaba rastro en la consola.

Ahora un fallo no descarta nada. El posteo se guarda con `title` y `sentiment`
en `NULL`, y eso significa "sin clasificar":

- En la tabla aparece con la píldora gris **Sin clasificar** (borde punteado) y
  título `(sin clasificar)`. Hay un filtro `Sin clasificar` para encontrarlos.
- El sentimiento se puede corregir a mano desde el desplegable de siempre.
- `backfillClassification()` los reintenta solo: su criterio es `title IS NULL`.

La contrapartida es ruido: un posteo que llegó por hashtag y no se pudo
evaluar entra igual, con `matched_reason` avisando que la relevancia quedó sin
verificar. Es a propósito — un falso positivo se ve y se borra, uno descartado
en silencio no vuelve nunca. Un `relevant: false` legítimo del modelo sí sigue
descartando: eso es una respuesta, no un fallo.

---

## ⚠️ Nota sobre los nombres de campos de Apify

Los nombres de los campos que devuelve el actor `apify/instagram-scraper` pueden
variar según la versión. El código en `src/apify.js` intenta varias alternativas
(`ownerUsername`, `owner.is_verified`, `videoPlayCount`/`videoViewCount`, etc.).
Si algún dato aparece como `N/D`, revisá una corrida real en el panel de Apify
para ver el nombre exacto del campo y ajustá `normalizePost` / `normalizeComments`.

Para el actor `apidojo/instagram-scraper-api` (monitoreo) los nombres están
verificados contra una corrida real del 2026-09-18 y guardados como fixtures
en `test/fixtures/apidojo/` (ver su README): `id`, `code`, `url`,
`createdAt`, `caption`, `likeCount`, `commentCount`, `isVideo`,
`video.playCount`, `isCarousel` + `carouselMedia`, `isPinned`,
`owner.username` y `owner.followerCount`. Este último viene solo en
consultas de perfil y es el del PERFIL CONSULTADO: en un posteo en
colaboración (owner distinto) el actor repite ese número, así que solo se
toma cuando el owner del item es la cuenta consultada. En la búsqueda por
palabra clave los items llegan con `caption`, `likeCount` y `commentCount`
en null. Si el actor cambia algo, esas fixtures y
`src/platforms/instagramApidojo.js` son el lugar a mirar.

### ⚠️ Verificar en la primera corrida real: ids del refresco de métricas

`src/metricsRefresh.js` (y el refresco "gratis" que hace `runMonitoringCycle`
contra posteos ya conocidos) cruzan lo que devuelve `scrapeAccount` contra
`detected_posts` **por id**. Ese id se arma en `normalizePost`
(`src/platforms/instagram.js`) probando alternativas:
`pick(raw.id, shortCode, raw.pk)` — la primera que venga definida gana.

El riesgo: si en algún momento cambia CUÁL de esas alternativas trae Apify
para un mismo posteo (por ejemplo, hoy no manda `raw.id` y usa `shortCode`,
pero en el futuro empieza a mandar `raw.id` también), el id que se arma para
ese posteo cambia de string — y el cruce por id deja de matchear. No tira
ningún error: simplemente actualiza 0 filas, en silencio. Es el modo de
falla más difícil de notar que tiene todo este mecanismo.

Qué revisar en la primera corrida real:

1. Tomá una cuenta trackeada con posteos ya guardados. Compará a mano un
   `id` que devuelva `scrapeAccount('esa_cuenta', {...})` contra el `id`
   guardado en `detected_posts` para ese mismo posteo (mismo `shortCode`/URL).
   Tienen que ser el mismo string exacto.
2. Mirá la consola durante/después del ciclo: si aparece
   `[metricsRefresh] ATENCIÓN: N cuentas consultadas, 0 filas actualizadas`,
   es la señal de que el cruce por id dejó de funcionar — hay que revisar
   `normalizePost` (`src/platforms/instagram.js`) contra la respuesta real
   del actor.
