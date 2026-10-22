# Tasks: sistema-visual-v4

Rama `sistema-visual-v4`, en una carpeta de trabajo aparte (la app del
piloto sirve `public/` desde la carpeta del repo). Sin Apify ni LLM. Se
prueba con un servidor de prueba en otro puerto y una copia de la base.

## Phase 0: maqueta y decisiones

- [x] 0.1 Tag `v3-riel-radar` en `main` (estado con el riel, el radar y las maquetas viejas), pusheado
- [x] 0.2 Maqueta `design/social-listening-v4.html`; se borran `riel-radar-v3`, `login-v1`, `dashboard-v1`, `analisis-v1`, `monitoreo-feed` y `monitoreo-popup`
- [x] 0.3 Decisiones del dueño (22/10/2026): hora de la última corrida en la barra (verde < 5 h); X con las mismas solapas, sin Estadísticas, abriendo en Análisis; `/status` sin plataforma desde la base; favicon ◎; mapa con mosaicos claros; tema claro de origen con botón

## Phase 1: sistema visual y marco

- [x] 1.1 `styles.css` reescrito: sistema visual, marco y componentes con tokens (REQ-V4-01)
- [x] 1.2 Barra superior y píldora en `instagram.html`, `x.html`, `dashboard.html`; `main.js` con teclas y `--top` (REQ-V4-02)
- [x] 1.3 `topbar.js`: estado de la escucha (REQ-V4-03)
- [x] 1.4 `tip.js`: tooltip global por `textContent` (REQ-V4-04)
- [x] 1.5 `footer.js`: pie de la maqueta (REQ-V4-05)
- [x] 1.6 Monitoreo puente sin riel ni radar; `rail.js` y `monitoringRadar.js` borrados (REQ-V4-06)
- [x] 1.7 Login y verificación en pantalla partida (REQ-V4-07)

## Phase 2: backend

- [x] 2.1 `db.getLastFinishedRunAtAny` y `/api/monitoring/status` sin plataforma (REQ-V4-03)
- [x] 2.2 Tests en `test/ultimaCorrida.test.js`

## Phase 3: tema, favicon y config

- [x] 3.1 `theme.js` y botón luna / sol: clara de origen (REQ-V4-08)
- [x] 3.2 Favicon ◎ en SVG, PNG e ICO
- [x] 3.3 `.env.example` con `SMTP_FROM` de la cuenta propia

## Phase 4: prueba y documentación

- [x] 4.1 Prueba en el navegador: las cinco páginas a 1366 y 375 px, oscuro, movimiento reducido, corrida simulada, X y el inicio
- [x] 4.2 Suite con `IG_ACTOR=apidojo` y `apify`
- [x] 4.3 `CLAUDE.md` (sección "Diseño v4"), `README.md` y este registro
