# Design: analisis-v4

## Technical Approach

Backend: `POST /api/analyze` valida el link (`checkAnalyzeUrl`), lo
normaliza a `/p/<code>/` y le pide a `src/analysisJob.js` que arranque.
El trabajo crea la fila de `analisis` en "en curso", responde el id y
corre en el mismo proceso, fuera del pedido: trae la publicación y los
comentarios (dos corridas del actor oficial en paralelo, cada una avisa
al terminar), clasifica en tandas, arma la síntesis, guarda los reclamos,
arma el informe y deja todo en la fila. Cada paso queda en
`src/analysisProgress.js` (un estado en memoria por id) y
`GET /api/analyze/progress?id=` lo devuelve. Las lecturas van por
`src/analysisRoutes.js`, separado de `server.js` como `statsRoutes.js`.

Frontend sin build ni dependencias nuevas. La solapa toma el marcado de
la maqueta en `instagram.html`; `public/js/analysis.js` (prefijo `ana`)
pide, consulta el progreso cada segundo y dibuja el análisis guardado
con nodos y SVG (`createElementNS`). Usa `postView.js` (`formatCount`,
`accountColor`) y `TemasConversacion` de `temasEditor.js` para armar el
informe con los temas editados.

## Architecture Decisions

- **El análisis corre en el servidor.** El pedido no espera: responde el
  id (202). Cerrar la pestaña no pierde nada ni vuelve a gastar; el
  resultado queda en "Recientes". El mismo link (normalizado) con un
  análisis en curso devuelve ese id. Al arrancar el servidor, los "en
  curso" de un arranque anterior pasan a "interrumpido" (lo hace
  `server.js`, no la carga de `db.js`: otro proceso que abre la base, un
  script, no puede tocar un análisis vivo).
- **Pasos reales.** Esperar turno en Apify (solo si el limitador está
  lleno: lo avisa `concurrencyLimiter` al encolar), traer la publicación,
  traer los comentarios, clasificar el tono (con "N de M" real, tanda por
  tanda), detectar los temas y armar la lectura, ubicar los reclamos (o
  "sin reclamos") y armar el informe. Ninguno tiene un número inventado.
- **Tandas de 100.** La muestra (deduplicada, con el orden de siempre:
  verificadas, más likes, más recientes) se parte en tandas de 100; cada
  una va en su llamada con un schema que solo clasifica (tono, tipo de
  cuenta, reclamos), hasta 3 a la vez. Una llamada de síntesis recibe
  todos los comentarios numerados con su tono y su tipo y devuelve
  "posteo sobre", los insights, la postura, la lectura y hasta 8 temas
  con los números de sus comentarios. Una tanda que falla deja sus
  comentarios sin clasificar (no cuentan) y el análisis sigue; si fallan
  todas o la síntesis, el análisis termina en error.
- **El número real.** "Analizados" son los comentarios que el modelo
  clasificó de verdad: los índices que faltan ya no se completan como
  neutrales, quedan sin clasificar. La pantalla dice "analizados N de M"
  con M el total que informa Instagram.
- **Tonos.** La pantalla cuenta positivos, neutrales y negativos (el
  ruido aparte) sobre lo clasificado. El informe sigue con su porcentaje
  ponderado por tipo de cuenta, y la pantalla lo rotula así.
- **Temas con conteo.** El schema de síntesis de Instagram pide los
  números de los comentarios de cada tema; se validan contra la muestra
  y el conteo es de los válidos. El schema de los temas de X no cambia.
  Los temas editados se guardan en la fila (`PATCH`) y entran en el
  informe.
- **"Cuándo comentaron".** `src/commentTimeline.js`, sin dependencias:
  sobre todos los comentarios traídos (la muestra está ordenada por likes
  y quedaría sesgada), con la fecha de la publicación y al menos 10 con
  fecha; si no, null y el bloque no aparece. Ventana desde la
  publicación hasta el último comentario: por hora hasta 48 h, de a 6 h
  hasta 7 días, por día después.
- **La foto.** La corrida de la publicación ya trae `displayUrl`: si el
  posteo está en `detected_posts` con foto guardada se usa esa; si no, se
  baja con `postImages.savePostImage` (mismas reglas, mismo archivo
  `data/media/instagram/<id>_*.jpg`). La fila anota sus `image_*`; la
  ruta de la foto se arma con datos de la fila, nunca con el pedido.
- **Gasto.** `usageContext` lleva `analisisId` y `recordApifyCall` lo
  escribe en `apify_calls.analisis_id`; el usd de Apify del análisis es
  la suma de sus filas. El del modelo suma tandas, síntesis y
  subcategorías.
- **Reclamos.** `db.upsertReclamo(fila, { conservarGestion: true })`, que
  usan los análisis de Instagram y X: al chocar con un reclamo existente
  conserva su estado y, si la dirección detectada no cambió, su
  geocodificado. El importador sigue como siempre.

## Data Flow

    POST /api/analyze ─→ analysisJob.start ─→ fila "en curso" ─→ 202 { id }
                              │
                              ├─ publicación ┐ (en paralelo, runActorSync)
                              ├─ comentarios ┘
                              ├─ tandas de 100 ─→ síntesis
                              ├─ reclamos ─→ informe ─→ fila "ok"
                              └─ cada paso ─→ analysisProgress[id]
    GET /api/analyze/progress?id= ←─ analysisProgress (o la fila)
    GET /api/analisis/:id ←─ la fila

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/db.js` | Modify | Tabla, lecturas y escrituras por plataforma; `apify_calls.analisis_id`; `conservarGestion` |
| `src/apify.js` | Modify | `fetchAnalysisPost`, `fetchAnalysisComments`; normalización; topes |
| `src/concurrencyLimiter.js` | Modify | `run(fn, target, { onQueued })` |
| `src/commentSample.js` | Modify | Default 300; X sigue con 150 |
| `src/prompt.js`, `src/analysisSchema.js`, `src/userPrompt.js` | Modify | Prompts y schemas de tanda y síntesis |
| `src/validateAnalysis.js` | Modify | Sin relleno: lo no clasificado queda null |
| `src/analyzeComments.js` | Modify | Tandas, síntesis, conteos, reclamos, informe |
| `src/reportBuilder.js`, `src/sentimentAggregate.js` | Modify | Ignoran lo no clasificado; muestra parcial contra el total del posteo |
| `src/commentTimeline.js`, `src/analysisProgress.js`, `src/analysisJob.js`, `src/analysisRoutes.js` | Create | Ver arriba |
| `src/usageContext.js`, `src/apifyCost.js` | Modify | `analisisId` |
| `server.js` | Modify | Monta las rutas; interrumpidos al arrancar |
| `public/instagram.html`, `public/js/analysis.js` | Modify | La solapa |
| `public/dashboard.html`, `public/js/dashboard.js` | Modify | "Análisis recientes" |
| `public/js/monitoringFeedPopup.js`, `public/js/x-analysis.js` | Modify | Precarga; Enter doble |
| `public/css/styles.css` | Modify | Bloque "Análisis de publicación de Instagram (diseño v4, fase E)", todo bajo `.ana4` |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Base | Tabla, recientes, "¿ya se analizó?", temas, interrumpidos, `analisis_id`, `conservarGestion` | Base temporal |
| Modelo | Tandas (250 → 3), una tanda caída, índices omitidos, temas con conteo, tonos | `llm.requestStructuredAnalysis` stubeado por el objeto del módulo |
| Apify | Publicación (fecha, id, código, foto, likes ocultos), comentarios (likes sin dato) | Fixture anonimizado del análisis real |
| Trabajo y rutas | 202, mismo link en curso, 400, pasos, `GET`, `PATCH`, foto | `global.fetch` y el LLM stubeados; registro de cuentas y medios en temporales |
| "Cuándo comentaron" | Umbral, unidades, pico | Puro |
| Pantalla | La solapa y el inicio | Servidor de prueba aparte (copia de la base, análisis sembrados, `/api/analyze` simulado y rotulado) |

## Open Questions

- [x] Topes (decisión del dueño, 24/10/2026): 300 por defecto y tandas de 100
- [x] Lo demás: las diez recomendaciones aceptadas (proposal)
