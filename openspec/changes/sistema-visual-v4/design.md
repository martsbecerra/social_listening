# Design: sistema-visual-v4

## Technical Approach

Frontend sin build y sin dependencias nuevas; las fuentes se cargan de
Google Fonts como antes, Tabulator y Leaflet siguen por unpkg. El CSS de la
maqueta se copia en tres partes comentadas dentro de `styles.css`: 1) el
sistema visual tal cual; 2) el marco (barra superior, paneles, pie); 3) los
componentes de la app que la maqueta no dibuja o que todavía no se
rehicieron, pasados a los tokens nuevos con sus mismas clases. Los scripts
siguen siendo clásicos; los nuevos (`theme.js`, `topbar.js`, `tip.js`)
llevan su prefijo (`theme`, `topbar`, `tip`).

## Architecture Decisions

- **Las solapas siguen siendo `.tab-panel` + `hidden`.** La maqueta usa
  `.panel.on`; acá se mantiene el mecanismo de `main.js` (y el truco que
  deja `#tab-monitoring` en el layout para que Tabulator mida su ancho). La
  píldora usa `role="tab"` y `aria-selected`; `openTab` corre la pastilla y
  repite las `.rv`. El hash sigue siendo `#tab-<nombre>` (los enlaces del pie
  y los marcadores de los usuarios no cambian).
- **Teclas 1-4.** El número de la solapa, sin modificadores, fuera de campos
  de texto y sin pop-up ni modal abiertos. ← → recorren la píldora con el
  foco en ella. Estadísticas (`aria-disabled`) no abre nada.
- **Estado de la escucha** (decisión del dueño, 22/10/2026): la hora de la
  última corrida terminada; verde si fue hace menos de 5 h, gris "última
  corrida · dd/mm HH:MM" si no, "todavía no corrió" sin ninguna. El inicio
  usa la de cualquier red: `/api/monitoring/status` sin plataforma pasa a
  leer `db.getLastFinishedRunAtAny()` (antes, la hora en memoria del
  scheduler, que se perdía con un reinicio). Es otra función, no un default
  de `getLastFinishedRunAt`.
- **Tema** (decisión del dueño, 22/10/2026): la maqueta tomaba el oscuro del
  sistema; la app arranca siempre clara y tiene un botón (luna / sol) en la
  barra superior. `theme.js` va en el `<head>` para no pintar un instante en
  claro una página elegida en oscuro; guarda `sl.tema` en `localStorage`
  con try/catch. El login respeta lo elegido sin botón propio.
- **X** (decisión del dueño): mismas solapas que Instagram, sin
  Estadísticas, y sigue abriendo en Análisis.
- **Monitoreo puente.** Sin riel ni panel, las tres cajas de fuentes van
  arriba de la solapa con los mismos ids y `data-full`; la fase B las pasa a
  la columna izquierda de la maqueta. "Se despegaron" pasa a 2 x 2, como
  `.ups`.
- **Sin estilo global de `<button>`.** El de antes (ancho completo,
  degradé) obligaba a pisarlo en cada componente; ahora cada botón lleva su
  clase.
- **Tooltip** (`tip.js`): la maqueta arma el HTML del tooltip con
  `innerHTML`; acá título y texto entran por `textContent` desde
  `data-tip-title` y `data-tip`.
- **Mapa** (decisión del dueño): mosaicos de OpenStreetMap claros en los
  dos temas; controles, leyenda, popups y tooltips con los tokens.
- **Login**: el archivo sigue siendo `index.html` (el que sirve `/`). Fase
  A: la pantalla partida sin blobs, constelación, ticker ni contadores.
- **Favicon** (decisión del dueño): el ◎ sobre el degradé, en SVG; los PNG
  y el `.ico` (16, 32, 48 px) salen de él con `sharp`.

## Data Flow

    topbar.js ──GET /api/monitoring/status[?plataforma]──► server.js
                                                    ├─ db.getLastFinishedRunAt(p)
                                                    └─ db.getLastFinishedRunAtAny()
    monitoring.js ──notifyMonitoringViews({ run: 'end' })──► topbar.js (relee)
    theme.js ──localStorage sl.tema──► <html data-theme="dark">

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `public/css/styles.css` | Rewrite | Sistema visual, marco y componentes con tokens |
| `public/js/main.js` | Modify | Píldora, teclas, `--top`, `#fuentes-…` |
| `public/js/theme.js` | Create | Tema con botón |
| `public/js/topbar.js` | Create | Estado de la escucha |
| `public/js/tip.js` | Create | Tooltip global |
| `public/js/footer.js` | Modify | Pie de la maqueta |
| `public/js/rail.js` | Delete | Riel |
| `public/js/monitoringRadar.js` | Delete | Radar |
| `public/instagram.html`, `x.html`, `dashboard.html` | Modify | Barra superior, `main.page`, pie |
| `public/index.html`, `login-verify.html` | Modify | Pantalla partida |
| `src/db.js`, `server.js` | Modify | `getLastFinishedRunAtAny` |
| `test/ultimaCorrida.test.js` | Modify | Tests nuevos |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | `getLastFinishedRunAtAny` | `test/ultimaCorrida.test.js`, base temporal |
| Browser | Las cinco páginas | Servidor de prueba en otro puerto, copia de la base, sin scheduler, Apify ni LLM; 1366 y 375 px, oscuro, movimiento reducido |
