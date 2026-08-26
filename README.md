# 🔍 Social Listening App

App web que:

1. Recibe el link de una publicación de Instagram, extrae los comentarios y
   los datos del posteo con **Apify**, y los analiza con un **LLM** (Anthropic
   Claude u **OpenRouter**) siguiendo una metodología de análisis político,
   mostrando un **reporte ejecutivo** listo para WhatsApp (solapa "Análisis de
   publicación").
2. Monitorea automáticamente, cada 4 horas, si aparece algún posteo nuevo de
   las cuentas trackeadas o que mencione las palabras clave/hashtags
   configurados, y avisa por email (solapa "Monitoreo en vivo").
3. Muestra la solapa "Mapa de reclamos" (Leaflet): círculos por dirección
   normalizada, con filtros combinables por categoría (lista cerrada de
   nueve), estado, barrio/comuna, rango de fechas y texto libre, más
   descarga de CSV. Se alimenta de dos fuentes: el análisis de una
   publicación (`/api/analyze` guarda reclamos con ubicación en
   `geo_status = 'pendiente'`; un worker los geocodifica con USIG después,
   sin bloquear la respuesta) y un import puntual de Excel
   (`scripts/import-reclamos-excel.js`) para cargar reclamos ya resueltos.

---

## 📁 Estructura del proyecto

```
social_listening_app/
├── server.js                 # Servidor web (Express). Punto de entrada.
├── src/
│   ├── apify.js              # Extrae comentarios y datos del posteo desde Apify.
│   ├── analyzeComments.js    # Orquestación del análisis (Apify → LLM → reporte).
│   ├── llm/                  # Proveedores: anthropicProvider, openrouterProvider.
│   ├── prompt.js             # La metodología de análisis (system prompt).
│   ├── db.js                 # SQLite: posteos detectados + reclamos del mapa.
│   ├── reclamosAddress.js    # Obsoleto (heurística del seed viejo); sin uso.
│   ├── tematica.js           # Normaliza etiquetas libres del CSV de reclamos (legacy).
│   ├── categoriaReclamo.js   # Categoría (9) y estado (4) cerrados del mapa.
│   ├── addressClean.js       # Limpieza de direcciones antes de geocodificar (USIG).
│   ├── geocode.js            # USIG + geocode_cache (lo usa geoWorker.js).
│   ├── territorios.js        # Comuna/barrio por punto-en-polígono (GeoJSON GCBA).
│   ├── geoWorker.js          # Geocodifica reclamos 'pendiente' (cron + post-análisis).
│   ├── reclamosFromAnalysis.js # reclamosGeo de Claude -> filas para la tabla reclamos.
│   ├── monitor.js            # Detección de posteos nuevos + config de cuentas/keywords.
│   ├── classifier.js         # Título + sentimiento de cada posteo (Claude Haiku).
│   ├── mailer.js             # Envío de emails de alerta (Nodemailer).
│   ├── notify.js             # Orquesta las notificaciones (email + WhatsApp a futuro).
│   ├── scheduler.js          # Agenda el monitoreo cada 4hs (node-cron).
│   └── notifiers/
│       └── whatsapp.js       # Placeholder para notificación por WhatsApp (no implementado).
├── config/
│   └── monitoring.json       # Cuentas y palabras clave/hashtags a trackear.
├── data/
│   ├── monitoring.db         # Base SQLite (se crea sola, no se versiona).
│   └── geo/                  # Cache en disco de comunas.geojson y barrios.geojson (GCBA).
├── public/
│   ├── index.html            # Login de fachada (sin auth real todavía).
│   ├── dashboard.html        # Selector de red social.
│   ├── instagram.html        # App Instagram: análisis + monitoreo + mapa de reclamos (tabs).
│   ├── css/styles.css        # Estilos (paleta oscura corporativa).
│   └── js/
│       ├── main.js           # Tabs + dropdown de usuario (solo visual).
│       ├── analysis.js       # Lógica de "Análisis de publicación".
│       ├── monitoring.js     # Lógica de "Monitoreo en vivo".
│       └── claimsMap.js      # Mapa de reclamos (Leaflet, agrega en el cliente).
├── scripts/
│   ├── import-reclamos-excel.js # Carga un Excel de reclamos ya resueltos (solo CLI).
│   └── stop-server.js           # Mata el proceso que ocupa el puerto (npm run stop).
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
  `runActorSync` para que `src/monitor.js` lo reuse.
- **`src/analyzeComments.js`**: muestra estable, prompt, llamada al proveedor LLM,
  validación y armado del reporte WhatsApp + CSV.
- **`src/prompt.js`**: contiene la metodología completa de análisis (el
  "system prompt"). Separado para que sea fácil de ajustar.
- **`public/index.html` + `dashboard.html` + `instagram.html` + `css/` + `js/`**: la
  interfaz (login → dashboard → app Instagram con tabs), separada en
  estructura/estilo/comportamiento.

### Monitoreo automático — archivos nuevos explicados

- **`config/monitoring.json`**: un archivo de texto plano con dos listas,
  `accounts` (usuarios de Instagram a trackear) y `keywords` (palabras clave o
  hashtags, estos últimos empezando con `#`). Se puede editar a mano, o desde
  la propia web (solapa "Monitoreo en vivo" → agregar/quitar). Cualquier
  posteo de una cuenta trackeada cuenta como relevante automáticamente; los
  posteos que vienen de un hashtag trackeado además se filtran por si el
  caption contiene alguna de las keywords configuradas.

  > **Limitación importante**: las keywords que NO son hashtag (ej. "Jorge
  > Macri" a secas) no hacen una búsqueda libre en todo Instagram — Apify no
  > ofrece eso de forma confiable. Solo se buscan dentro de lo que ya se
  > scrapea: posteos de las cuentas trackeadas y posteos de los hashtags
  > configurados.

- **`src/db.js`** — ¿qué es SQLite y por qué lo usamos así?: SQLite es una
  base de datos que vive en **un solo archivo** (`data/monitoring.db`), sin
  necesidad de instalar ni correr ningún servidor de base de datos aparte
  (a diferencia de Postgres/MySQL). Para este volumen (unos pocos posteos
  nuevos cada 4hs) es más que suficiente. En vez de la librería
  `better-sqlite3` usamos el módulo **`node:sqlite`**, que viene incluido en
  Node desde la versión 22.5 — esto evita tener que compilar código nativo
  (que en Windows requiere Visual Studio Build Tools, algo que esta PC no
  tenía instalado). Acá vive la tabla `detected_posts`, que guarda cada
  posteo relevante ya visto para no volver a notificarlo dos veces.

- **`src/monitor.js`**: el detector. Por cada cuenta trackeada, le pide a
  Apify sus posteos más recientes; por cada hashtag trackeado, scrapea esa
  página de hashtag. Compara todo contra `src/db.js` para no volver a
  evaluar ni guardar algo que ya se vio. Antes de guardar una cuenta o
  hashtag nuevo (al agregarlo desde la interfaz), valida contra Apify que
  exista de verdad — el actor no tira un error HTTP para esto, sino que
  devuelve un item con `"error": "not_found"` (cuentas) o `"no_items"`
  (hashtags), así que basta con revisar ese campo antes de guardarlo en
  `config/monitoring.json` (y también antes de tratar un resultado como
  posteo real: si no se filtra, queda guardado un "posteo" cuyo link en
  realidad es el del perfil).

  **Cómo decide si un posteo es relevante** (dos pasos, en `evaluateRelevance`):
  1. Si el caption/hashtags contienen alguna palabra clave configurada
     literalmente → relevante directo.
  2. Si no hay coincidencia literal → le pregunta a **Claude** si el
     contenido igual habla del Jefe de Gobierno porteño o de su gestión,
     sin necesidad de que lo nombre explícitamente (`classifyRelevance` en
     `src/classifier.js`). Así se detectan menciones indirectas (ej. un
     anuncio de una política de vivienda que no dice su nombre) que el
     matching de texto solo, se perdería.
     Un posteo sin caption (nada que evaluar) solo se acepta si viene de una
     cuenta trackeada — de un hashtag se descarta, porque no hay ninguna señal
     de que se relacione con el tema.

- **`src/classifier.js`**: acá vive el llamado a **Claude Haiku 4.5** (modelo
  barato, configurable con `CLASSIFIER_MODEL`) para dos cosas: `classifyPost`
  (título + sentimiento de un posteo que ya se sabe relevante) y
  `classifyRelevance` (título + sentimiento + si aplica o no, para posteos
  sin coincidencia literal — ver arriba). Todo a partir del caption, no de
  los comentarios de la gente (eso sigue siendo un análisis aparte, manual,
  en "Análisis de publicación"). Si Claude falla, `classifyPost` cae en
  `neutral` por defecto y `classifyRelevance` cae en "no relevante" (mejor
  perderse algo dudoso que llenar la tabla de ruido).

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

### 💸 Costo adicional en Apify del monitoreo

`apify/instagram-scraper` cobra **por resultado obtenido** (no por tiempo de
cómputo): ronda entre US$1,50 y US$2,70 por cada 1.000 resultados según tu
plan de Apify (verificado mayo 2026). El monitoreo agrega scraping de
**posts** cada 4hs, adicional a los análisis puntuales de siempre.

```
costo diario ≈ (nº de fuentes) × (resultsLimit) × (corridas por día) × tarifa/1000
```

Con la config por defecto (`MONITOR_RESULTS_LIMIT=15`, cron cada 4hs = 6
corridas/día) y un ejemplo de 5 cuentas + 3 hashtags: `8 × 15 × 6 = 720
resultados/día ≈ $1,66/día ≈ ~$50/mes` (plan Starter) **en el peor caso**.

En la práctica es bastante menos: las cuentas trackeadas usan
`onlyPostsNewerThan` + `skipPinnedPosts`, así que si no publicaron nada nuevo
esa corrida devuelve ~0 resultados (no se paga por posteos viejos ya vistos).
Los hashtags sí pagan siempre el `resultsLimit` completo. Para bajar el costo:
reducí `MONITOR_RESULTS_LIMIT`, sacá hashtags, o espaciá el cron
(`MONITOR_CRON` en el `.env`, ej. cada 6-8hs).

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
  (los modelos ya vienen con default equivalente al de Anthropic, no hace falta setearlos)
- `SMTP_USER` / `SMTP_PASS` → tu Gmail y una
  ["contraseña de aplicación"](https://myaccount.google.com/apppasswords)
  (necesarias solo para las alertas del monitoreo)
- `ALERT_EMAIL_TO` → a quién avisar cuando aparezca un posteo relevante

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

Abrí esa dirección en el navegador (login de fachada → dashboard → Instagram),
pegá el link de una publicación y hacé clic en **Analizar publicación**.

### 5. Reclamos del mapa

El mapa se alimenta solo: cada vez que analizás una publicación
("Análisis de publicación"), los comentarios con una dirección concreta
quedan guardados como reclamos en `geo_status = 'pendiente'`, y se
geocodifican con USIG poco después (sin bloquear la respuesta del análisis).
También corren cada 4hs junto con el cron de monitoreo, por si algo quedó
pendiente por una falla transitoria de USIG.

Para cargar de una vez un lote de reclamos ya resueltos (Excel con hoja
"Reclamos" y columnas `direccion`, `comuna`, `barrio`, `link`, `texto`,
`autor`, `fecha`, `X`, `Y`, entre otras):

```powershell
npm run import-reclamos-excel -- --dry-run "ruta\al\archivo.xlsx"
npm run import-reclamos-excel -- "ruta\al\archivo.xlsx"
```

`--dry-run` solo imprime un resumen y no toca la DB. El import real es
idempotente (usa el link de cada fila como id): correrlo dos veces no
duplica filas.

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
como respaldo por si la de `posts` no trajera datos.

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

**Las filas sin ubicación accionable NO se descartan**: entran con
`geo_status = 'sin_direccion'`. Sirven para estadística aunque no vayan al mapa.
La dirección original del archivo se guarda igual en `direccion_detectada`,
aunque el modelo la descarte, para poder auditar si el criterio está
descartando de más.

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

### Los estados de `geo_status`

Cada reclamo guarda en qué terminó su geocodificación:

| `geo_status` | Qué significa | ¿Aparece en el mapa? |
|---|---|---|
| `pendiente` | Detectado, todavía sin geocodificar | No (hasta que corra el worker) |
| `ok` | Resuelto dentro de CABA, con comuna y barrio | **Sí**, con pin |
| `sin_direccion` | No había dirección, o USIG no la encontró en ningún lado | No (queda en la lista, sin pin) |
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
- Apify falla, se demora demasiado o alcanzó su límite de uso.
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

### ⚠️ Verificar en la primera corrida real: ids del refresco de métricas

`src/metricsRefresh.js` (y el refresco "gratis" que hace `runMonitoringCycle`
contra posteos ya conocidos) cruzan lo que devuelve `scrapeAccount` contra
`detected_posts` **por id**. Ese id se arma en `normalizeMonitorPost`
(`src/monitor.js`) probando alternativas: `pick(raw.id, shortCode, raw.pk)` —
la primera que venga definida gana.

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
   `normalizeMonitorPost` contra la respuesta real del actor.
