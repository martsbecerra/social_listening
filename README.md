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
│   ├── db.js                 # Base SQLite de posteos detectados (monitoreo).
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
│   └── monitoring.db         # Base SQLite (se crea sola, no se versiona).
├── public/
│   ├── index.html            # Login de fachada (sin auth real todavía).
│   ├── dashboard.html        # Selector de red social.
│   ├── instagram.html        # App Instagram: análisis + monitoreo (tabs).
│   ├── css/styles.css        # Estilos (paleta oscura corporativa).
│   └── js/
│       ├── main.js           # Tabs + dropdown de usuario (solo visual).
│       ├── analysis.js       # Lógica de "Análisis de publicación".
│       └── monitoring.js     # Lógica de "Monitoreo en vivo".
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
- **OpenRouter:** `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY` → https://openrouter.ai/settings/keys y `OPENROUTER_MODEL` (p. ej. `openai/gpt-4.1`)
- `SMTP_USER` / `SMTP_PASS` → tu Gmail y una
  ["contraseña de aplicación"](https://myaccount.google.com/apppasswords)
  (necesarias solo para las alertas del monitoreo)
- `ALERT_EMAIL_TO` → a quién avisar cuando aparezca un posteo relevante

### 4. Arrancar la app

```powershell
npm start
```

Vas a ver: `✅ Servidor listo en http://localhost:3000`

Abrí esa dirección en el navegador (login de fachada → dashboard → Instagram),
pegá el link de una publicación y hacé clic en **Analizar publicación**.

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

### ¿Qué modelo usa el análisis?

Depende de `LLM_PROVIDER` en `.env` (default **`anthropic`**).

**Anthropic:** por defecto **`claude-sonnet-5`** (`CLAUDE_MODEL`).

- Si querés priorizar costo: `CLAUDE_MODEL=claude-haiku-4-5`.
- Si querés máxima calidad: `CLAUDE_MODEL=claude-opus-4-8`.

**OpenRouter:** default **`openai/gpt-4.1`** (`OPENROUTER_MODEL`). Elegí un modelo que soporte `json_schema` (GPT-4.1, Gemini 2.5 Pro, etc.).

Al arrancar, el servidor imprime qué proveedor está activo.

El costo por análisis es bajo: son unos pocos miles de tokens de entrada
(comentarios) y ~2-3 mil de salida (el reporte).

---

## 🛟 Manejo de errores

La app muestra mensajes claros cuando:

- El link no es una publicación válida de Instagram.
- Falta o es inválida alguna clave (Apify o el proveedor LLM activo).
- Apify falla, se demora demasiado o alcanzó su límite de uso.
- La publicación no tiene comentarios extraíbles.
- El LLM falla o alcanzó su límite de uso.

---

## ⚠️ Nota sobre los nombres de campos de Apify

Los nombres de los campos que devuelve el actor `apify/instagram-scraper` pueden
variar según la versión. El código en `src/apify.js` intenta varias alternativas
(`ownerUsername`, `owner.is_verified`, `videoPlayCount`/`videoViewCount`, etc.).
Si algún dato aparece como `N/D`, revisá una corrida real en el panel de Apify
para ver el nombre exacto del campo y ajustá `normalizePost` / `normalizeComments`.
