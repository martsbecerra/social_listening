# Proposal: sistema-visual-v4

## Intent

El equipo eligió otro diseño: `design/social-listening-v4.html`, una sola
maqueta con el login, el inicio y las cuatro solapas. Reemplaza al riel
lateral y al radar de la fase anterior (`riel-y-radar`, guardada en el tag
`v3-riel-radar`) y a las maquetas que lo acompañaban. El rediseño va en
cinco fases, una rama y un PR por fase; esta es la A: el marco nuevo en
todas las páginas, sin rehacer todavía el contenido de cada solapa.

## Scope

### In Scope

- `public/css/styles.css` reescrito con el sistema visual de la maqueta
  (tokens claro / oscuro, Sora + IBM Plex, `.card`, `.chip`, `.kpi`, `.seg`,
  `.btn`, `.field`, `.tip`, animaciones) y, con los mismos tokens, lo que la
  maqueta no dibuja: progreso, fuentes, filtros, Tabulator, feed, pop-up,
  modales, análisis, mapa, inicio y login
- Barra superior: marca, píldora de solapas con teclas 1-4, plataforma,
  estado de la escucha, botón de tema y usuario, en `instagram.html`,
  `x.html` y (sin solapas) `dashboard.html`
- Tema: clara de origen, botón para pasar a oscura, recordado en el navegador
- Pie de la maqueta en las tres páginas con sesión
- Afuera el riel, el panel de fuentes, la franja y el radar
  (`rail.js`, `monitoringRadar.js`); las cajas de fuentes arriba del
  Monitoreo hasta la fase B
- `/api/monitoring/status` sin plataforma: la última corrida de cualquier
  red, de la base
- Login y verificación: pantalla partida estática con el formulario de
  siempre
- Favicon nuevo y `SMTP_FROM` de ejemplo con la cuenta propia de la app
- Borrar las seis maquetas que la v4 reemplaza

### Out of Scope

- El contenido nuevo del Monitoreo (KPI, flujo en vivo, pulso, pipeline,
  alertas, fuentes en columna, filtros en grilla, pop-up nuevo): fase B
- Estadísticas (backend y pantalla): fase C; el botón queda "pronto"
- Inicio y login con sus datos y animaciones: fase D
- Análisis de publicación nuevo: fase E
- El módulo de X más allá del marco; `/api/analyze`, `/api/monitoring/posts`
  y `/api/auth/*` sin cambios
- Nada contra Apify ni el LLM

## Approach

Se porta tal cual el bloque "sistema visual" de la maqueta y, para lo que
todavía no se rehace, se pasan las reglas de siempre a los tokens nuevos
sin tocar clases ni comportamiento. Los ids que usa `monitoring.js`,
`monitoringFeed.js`, `monitoringFeedPopup.js`, `analysis.js`,
`x-analysis.js`, `claimsMap.js` y `login.js` no cambian.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `public/css/styles.css` | Reescrito | Sistema visual v4 y componentes con tokens |
| `public/js/main.js` | Modificado | Píldora, teclas, `--top`, enlaces `#fuentes-…` |
| `public/js/theme.js` | Nuevo | Tema claro / oscuro con botón |
| `public/js/topbar.js` | Nuevo | "escuchando · HH:MM" |
| `public/js/tip.js` | Nuevo | Tooltip global por `textContent` |
| `public/js/footer.js` | Modificado | Pie de la maqueta |
| `public/js/rail.js`, `monitoringRadar.js` | Borrados | Riel y radar |
| `public/*.html` | Modificados | Marco nuevo |
| `src/db.js`, `server.js` | Modificados | `getLastFinishedRunAtAny` en `/status` |
| `test/ultimaCorrida.test.js` | Modificado | Tests de la lectura nueva |
| `public/favicon*`, `apple-touch-icon.png` | Reemplazados | Favicon ◎ |
| `.env.example` | Modificado | `SMTP_FROM` |
| `design/` | Modificado | Entra la v4, salen seis maquetas |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Un componente viejo pierde su estilo al irse el `button` global | Media | Cada botón con su clase; revisado en el navegador, claro y oscuro |
| La barra superior en celular ocupa tres renglones (como la maqueta) | Alta | Se deja como la maqueta y se anota para decidir |
| `x.html` comparte `monitoring.js` | Baja | Mismos ids; probado en el servidor de prueba |

## Rollback Plan

Revertir el merge, o volver al tag `v3-riel-radar`. El backend agrega una
lectura; nada cambia en la base.

## Success Criteria

- [x] Las cinco páginas con el marco nuevo, sin desplazamiento de costado a 375 px
- [x] Teclas 1-4, hash y enlaces del pie andan
- [x] Clara de origen aunque el sistema esté en oscuro; el botón cambia y se recuerda
- [x] Suite en verde con `IG_ACTOR=apidojo` y `apify`
