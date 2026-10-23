# Design: monitoreo-v4

## Technical Approach

Frontend sin build ni dependencias nuevas. La solapa toma el marcado de la
maqueta en `instagram.html`; los ids de siempre se conservan donde había
lógica (`runNowBtn`, `monitoringStatusCard`, `newSearch`, `fSent`, `q`,
`fAccBtn`, `viewSeg`, `cards`, `monitoringTable`, `monitoringFeed`...). Los
scripts siguen siendo clásicos con prefijo por archivo: `panel` y `flow` para
los dos nuevos. Todo dato entra por `textContent` (el `<mark>` del flujo se
arma con nodos); los SVG (sparklines, anillo, pulso) se arman con
`createElementNS`.

## Architecture Decisions

- **Una sola fuente de datos.** Los posteos son los de Tabulator
  (`monitoringTable.getData()`); los filtros, `postMatchesFilters`. El
  período va dentro de ese predicado (`periodFrom`), así la tabla, el feed y
  el contador lo respetan sin código aparte; el panel, el flujo y "Se
  despegaron" usan `postInPeriod`.
- **Período en hora de Argentina.** "Hoy" arranca a las 00:00 de hoy; "7
  días", a las 00:00 de seis días antes. Argentina no tiene horario de
  verano: la medianoche se arma con `-03:00` y se restan días de 24 h. El
  período anterior para la variación tiene el mismo largo
  (`[inicio − largo, inicio)`), así "Hoy" a las 10 se compara con ayer hasta
  las 10.
- **Avisos.** `notifyMonitoringViews` suma `{ config }` (la config llegó o
  falló). La config y los posteos pueden llegar antes de que se cargue un
  script (la respuesta le gana a la descarga de los siguientes): cada script
  nuevo arranca con `monitoringConfig` y `monitoringTable` si ya están.
- **El panel no redibuja de más.** Calcula una firma (período, ids,
  sentimientos, likes, comentarios): con la misma firma no rehace los KPI
  (que suben de 0 con `countUp`); si solo cambió el filtro por fuente,
  rehace solo las fuentes.
- **Fuentes.** Una búsqueda cuenta los posteos cuyo `matched_reason` es
  "Búsqueda: <término>" (`postReasonParts`, que se movió de
  `monitoringFeed.js` a `monitoring.js`); una palabra o un hashtag, los que
  la tienen escrita en el título o el texto, sin mayúsculas ni acentos. Los
  hashtags son las palabras clave con "#" (misma lista y endpoint); la caja
  de hashtags le pone el "#". Clic = filtrar (no pausar: no hay pausa en el
  backend). Sacar pide "¿Sacar «x»? Sí / No" en el mismo lugar (decisión del
  dueño).
- **Flujo.** Ordena por `detected_at`, filtra por período, arma las líneas
  que entran según el alto (la tarjeta tiene el alto de la fila y su
  contenido es una capa absoluta) y saca las que sobran. Durante una
  corrida no se redibuja; con `{ run: 'end', newIds }` se rehace sin las
  nuevas y las nuevas entran de a una (900 ms), con "ahora". Con el mouse
  encima esperan en una cola.
- **Pipeline.** `src/lastRun.js` arma `lastRun` con la última corrida
  terminada de la plataforma: traídas = ítems de las llamadas de detección
  de esa red (`phase` monitoreo o busqueda, `query_type`
  search/user/hashtag; el detalle `post` no cuenta), nuevas =
  `new_candidates` (columna nueva, que el scheduler llena con la suma de
  `porPlataforma.*.newCandidates`), guardadas = `new_posts`, destacadas =
  posteos guardados en la ventana de la corrida con `top.level === 'alto'`
  (misma regla que el listado), duración y costo. El modelo es
  `getAnalysisModel()`; en pantalla, sin proveedor, fecha ni "claude-".
- **Alertas.** Reglas de hoy sobre lo cargado: volumen ≥ 1,5 × la mediana
  diaria de los 30 días anteriores (días con publicaciones, al menos 3); la
  publicación de hoy de mayor razón con alcance alto; un tema con 2 o más
  negativas hoy. El clic pone los filtros (período Hoy) y baja a la lista.
- **Textos de la razón.** Lleva colchón: nada dice "N veces lo habitual".
  KPI y alerta: "la mayor: 15,37× en comentarios, de @cuenta" (decisión del
  dueño). La alerta de volumen sí dice "Hoy hay 2,3× lo habitual": ahí es
  un cociente simple contra la mediana diaria, no la razón del alcance.
- **Feed en filas completas.** Las columnas reales salen de
  `grid-template-columns`; se muestran 3 filas y, si hay más, la última
  celda es "+N · Ver 12 más". Otro filtro u orden vuelve a 3 filas; otro
  ancho con otras columnas las completa de nuevo. Siguen
  `content-visibility` y el redibujo con espera.
- **Pop-up sobre una lista.** `openFeedPopList(ids, id, opener)`: la lista
  del feed entera (`feedVisibleIds`, no solo las filas a la vista), las
  líneas del flujo o las tiras. Los datos salen de la fila por id. Sale el
  modo "solo" de "Se despegaron" y el aviso de lista del feed. Al ignorar
  pasa al siguiente; al cerrar el foco vuelve a lo que lo abrió (o a la
  tarjeta del último visto, si se navegó desde el feed).
- **Selector de tono** (decisión del dueño): sigue el desplegable pastilla
  de siempre en tarjetas, tiras y pop-up; no los botones de la maqueta.
- **Orden en la Tabla** (decisión del dueño): deshabilitado, con el aviso en
  la etiqueta (un control deshabilitado no recibe el mouse).
- **Fila de la tabla** (decisión del dueño): sigue desplegando el detalle.
- **Progreso.** Mismas líneas del backend, con puntos en lugar de ✓ / ✕ y
  cada línea del ancho de su texto (flex-wrap): el término no se corta
  (hallazgo 10 de la fase A). El cierre agrega una línea "Resultado". Se va
  a los 9 s salvo con el mouse o el foco encima.

## Data Flow

    loadPosts ──→ Tabulator ──→ applyFilters ──→ notifyMonitoringViews()
                                     │                 ├─ feed (3 filas)
          periodo, Tema, fuente ─────┘                 ├─ panel (firma)
                                                       ├─ flujo (firma)
                                                       └─ pop-up (lista)
    loadConfig ──→ notifyMonitoringViews({ config }) ──→ panel, flujo
    runNow ──→ { run: 'start' } … loadPosts … { run: 'end', newIds }
                                                ├─ flujo: entran las nuevas
                                                ├─ panel: relee /status
                                                └─ topbar: relee /status

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/db.js` | Modify | Columna `new_candidates`; `getLastFinishedRun`, `listPostsDetectedBetween` |
| `src/scheduler.js` | Modify | Pasa `newCandidates` al cerrar la corrida |
| `src/lastRun.js` | Create | `buildLastRun(plataforma, { hasBenchmark })` |
| `server.js` | Modify | `/status` con `lastRun` y `model`; `/config` con `temas` |
| `public/instagram.html` | Modify | Marcado de la maqueta |
| `public/js/monitoring.js` | Modify | Período, filtros, combo, progreso, tiras, `.reach`, `temaColor` |
| `public/js/monitoringPanel.js` | Create | Panel |
| `public/js/monitoringFlow.js` | Create | Flujo |
| `public/js/monitoringFeed.js` | Modify | Filas completas |
| `public/js/monitoringFeedPopup.js` | Modify | Lista y look nuevo |
| `public/js/main.js` | Modify | `#fuentes-hashtags` va a su caja y abre el campo |
| `public/css/styles.css` | Modify | Bloque del Monitoreo |
| `test/resumenCorrida.test.js` | Create | Tests del resumen |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `new_candidates`, `getLastFinishedRun`, `buildLastRun` | `node:test` con base temporal |
| Browser | Toda la solapa, X, 1366 y 375 px, oscuro, movimiento reducido | Servidor de prueba (puerto 3111, copia de la base, sin scheduler ni Apify ni LLM) |

## Migration / Rollout

`ALTER TABLE monitoring_runs ADD COLUMN new_candidates INTEGER`, protegido,
al arrancar. Las corridas anteriores quedan en null ("—" en el Pipeline).
