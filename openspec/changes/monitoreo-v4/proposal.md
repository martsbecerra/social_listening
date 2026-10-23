# Proposal: monitoreo-v4

## Intent

Fase B del rediseño v4 (`design/social-listening-v4.html`): la solapa
Monitoreo de Instagram con la estructura y el look de la maqueta. La fase A
dejó el marco nuevo en todas las páginas y un Monitoreo puente (tres cajas
de fuentes arriba, filtros en una fila, feed y pop-up con el marcado de
antes); esta fase arma la solapa de la maqueta con los datos reales que la
app ya tiene, del lado del cliente, más un resumen de la última corrida que
hoy no existe en la API.

## Scope

### In Scope

- Cabecera con Hoy / 7 días / 30 días (filtra todo por `posted_at` en hora
  de Argentina, recordado en `sl.monitoreo.periodo`) y "▶ Actualizar ahora"
- Recuadro de progreso de siempre con el look de `.progress` y el cierre
  "✓ Corrida terminada · HH:MM · duración", que se va solo a los 9 s
  (también en X); resuelve el hallazgo 10 de la revisión de la fase A
- Cuatro KPI del período: publicaciones (sparkline y variación), tono neto
  (anillo), "Se despegaron" (la mayor razón, con su métrica y su cuenta) y
  conversación (likes + comentarios)
- Columna izquierda: búsquedas, palabras clave y hashtags como chips con
  conteo del período y barrita de tono; clic filtra la lista, ✕ pide
  confirmación en el mismo chip, "+" abre el campo de agregar; 8 palabras y
  6 hashtags a la vista con "Ver las N →". Salen los modales "Ver todas"
- Centro: el flujo en vivo (una línea por publicación, la tarjeta no
  crece, pausa con el mouse, las nuevas entran al terminar una corrida)
- Derecha: pulso del tono de 7 días por hora, pipeline de la última corrida,
  tres alertas de hoy y cuentas seguidas (4 a la vista)
- "Se despegaron": hasta cuatro tiras del período, con la estructura de
  siempre y el look de `.up`
- "Publicaciones detectadas": Feed | Tabla, barra de ocho filtros con
  nombre (suma Tema, el combo de Cuenta con buscador y conteo, el orden "Más
  comentarios"), "Mostrando N de M publicaciones del período" con "Limpiar
  filtros" solo con algo puesto, y el filtro por fuente como pastilla
- Feed en filas completas de a tres con "+N · Ver 12 más"; las tarjetas
  conservan su estructura con el look de `.pc`
- Pop-up de siempre con el look nuevo: alto fijo, contador, recorre la
  lista desde la que se abrió, degradé del texto, rueda sobre la foto,
  "Analizar comentarios"
- Medidor de alcance `.reach` de la maqueta en la tabla, el feed, el flujo
  y las tiras
- Backend: `monitoring_runs.new_candidates`, `lastRun` y `model` en
  `/api/monitoring/status`, `temas` en `/api/monitoring/config`

### Out of Scope

- X: sigue con su layout (solo cambia el recuadro de progreso)
- Pausar fuentes (la maqueta tiene clic = pausar; acá clic = filtrar)
- El clic en una fila de la tabla sigue desplegando el detalle (la maqueta
  abre el pop-up)
- El selector de tono de la maqueta (botones): sigue el desplegable
  pastilla de siempre, con el look nuevo
- Cambiar la forma de `/api/analyze` o `/api/monitoring/posts`; tablas
  nuevas; corridas reales; Estadísticas (fase C); inicio y login (fase D);
  análisis (fase E)

## Capabilities

### New Capabilities

- `monitoreo-v4`: la solapa Monitoreo de Instagram de la maqueta v4

### Modified Capabilities

- `monitoreo-feed`, `monitoreo-popup`: filas completas, lista del pop-up y
  look nuevo (sin cambiar los datos ni los endpoints)
- `monitoreo-progreso-lista`: el recuadro cierra con "Corrida terminada" y
  se va solo

## Approach

Todo lo nuevo de la pantalla se calcula en el navegador con los posteos que
la tabla ya trae (`monitoringTable.getData()`), el período y los mismos
filtros (`postMatchesFilters`). Dos scripts nuevos, `monitoringPanel.js`
(KPI, fuentes, pulso, pipeline, alertas) y `monitoringFlow.js` (flujo),
escuchan `notifyMonitoringViews` como el feed. El único dato del servidor
que faltaba es el resumen de la última corrida (`src/lastRun.js`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/db.js`, `src/scheduler.js` | Modified | `new_candidates` en `monitoring_runs`; `getLastFinishedRun`, `listPostsDetectedBetween` |
| `src/lastRun.js` | New | Resumen de la última corrida para el Pipeline |
| `server.js` | Modified | `lastRun` y `model` en `/status`; `temas` en `/config` |
| `public/instagram.html` | Modified | Solapa Monitoreo de la maqueta; sin modales "Ver todas" |
| `public/js/monitoring.js` | Modified | Período, Tema, fuente, combo de Cuenta, progreso, tiras, `.reach` |
| `public/js/monitoringPanel.js` | New | KPI, fuentes, pulso, pipeline, alertas, cuentas |
| `public/js/monitoringFlow.js` | New | Flujo en vivo |
| `public/js/monitoringFeed.js` | Modified | Filas completas, distintivo de alcance alto |
| `public/js/monitoringFeedPopup.js` | Modified | Lista, look nuevo, "Analizar comentarios" |
| `public/css/styles.css` | Modified | Bloque del Monitoreo de la maqueta |
| `test/resumenCorrida.test.js` | New | `new_candidates` y `lastRun` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cientos de posteos recalculados en cada aviso | Low | El panel y el flujo solo redibujan si cambian los datos o el período (firma); el feed dibuja tres filas |
| "Hoy" vacío a la mañana antes de la primera corrida | Med | Línea "Todavía no hay publicaciones de hoy · ver 7 días" |
| La columna nueva en la base del piloto | Low | `ALTER` protegido; corridas viejas con "—" |

## Rollback Plan

Volver a `main` anterior al merge de esta rama. La columna
`new_candidates` es anulable y no la lee nada fuera de esta fase.

## Success Criteria

- [ ] La solapa de Instagram reproduce la maqueta con datos reales, en claro y oscuro, a 1366 y 375 px
- [ ] El período filtra KPI, fuentes, flujo, "Se despegaron" y la lista
- [ ] El pop-up recorre la lista desde la que se abrió
- [ ] X sigue igual salvo el recuadro de progreso
- [ ] Suite con `IG_ACTOR=apidojo` y `apify`
