# 🔍 Análisis de sentimiento de comentarios de Instagram

App web simple que:

1. Recibe el link de una publicación de Instagram.
2. Extrae los comentarios y los datos del posteo con **Apify**.
3. Analiza el sentimiento con un **LLM** (Anthropic Claude u **OpenRouter**) siguiendo una metodología
   de análisis político.
4. Muestra un **reporte ejecutivo** listo para copiar y pegar en WhatsApp.

---

## 📁 Estructura del proyecto

```
social_listening_app/
├── server.js            # Servidor web (Express). Punto de entrada.
├── src/
│   ├── apify.js         # Extrae comentarios y datos del posteo desde Apify.
│   ├── analyzeComments.js  # Orquestación del análisis (Apify → LLM → reporte).
│   ├── llm/                # Proveedores: anthropicProvider, openrouterProvider.
│   └── prompt.js        # La metodología de análisis (system prompt de Claude).
├── public/
│   └── index.html       # La página web (formulario + resultado).
├── .env.example         # Plantilla de las claves (copiala a .env).
├── .gitignore           # Evita subir node_modules y el .env con secretos.
└── package.json         # Dependencias y scripts del proyecto.
```

### Qué hace cada archivo

- **`server.js`**: levanta el servidor, sirve la web y expone `POST /api/analyze`.
  Valida el link, orquesta las llamadas a Apify y al LLM, y maneja los errores.
- **`src/apify.js`**: habla con la API de Apify. Corre el actor
  `apify/instagram-scraper` dos veces en paralelo (modo `comments` y modo
  `posts`) usando el endpoint **sincrónico** `run-sync-get-dataset-items`.
- **`src/analyzeComments.js`**: muestra estable, prompt, llamada al proveedor LLM,
  validación y armado del reporte WhatsApp + CSV.
- **`src/prompt.js`**: contiene la metodología completa de análisis (el
  "system prompt"). Separado para que sea fácil de ajustar.
- **`public/index.html`**: la interfaz: un input para el link, un botón
  "Analizar publicación", un área de resultado y un botón "Copiar".

---

## ⚙️ Instalación y uso (paso a paso)

### 1. Instalar Node.js

Necesitás **Node.js 18 o superior** (viene con `fetch` incorporado).
Verificá con:

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

### 4. Arrancar la app

```powershell
npm start
```

Vas a ver: `✅ Servidor listo en http://localhost:3000`

Abrí esa dirección en el navegador, pegá el link de una publicación y hacé clic
en **Analizar publicación**.

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
