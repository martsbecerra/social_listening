# Tasks: riel-y-radar

Rama `riel-y-radar`, en una carpeta de trabajo aparte (la app del piloto
sirve `public/` desde la carpeta del repo). Sin Apify ni LLM. Se prueba con
un servidor de prueba en otro puerto y una copia de la base.

## Phase 0: maqueta y decisiones

- [x] 0.1 Maquetas aprobadas: `design/riel-radar-v3.html` (esta fase), `design/login-v1.html`, `design/dashboard-v1.html` y `design/analisis-v1.html` (fases siguientes)
- [x] 0.2 Decisiones del dueño (20/10/2026): pie armado por `footer.js`, sin "Qué escuchamos" ni la línea "Escuchando", Facebook y TikTok sin enlace; Estadísticas en el riel deshabilitado; columna "Alcance" en la tabla; los dos textos de vacío del radar; posteos sin referencia como círculo hueco sobre "lo habitual"; "Publicaciones detectadas" con "N de M"; medidor en el pie de la tarjeta; hasta 4 tiras con selector; Desde/Hasta, Orden y Limpiar se quedan; Feed primero y por defecto; el riel sin parcial compartido

## Phase 1: backend

- [x] 1.1 `src/scheduler.js`: `getRunHours()` (REQ-RIEL-04)
- [x] 1.2 `src/db.js`: `getLastFinishedRunAt(plataforma)` (REQ-RIEL-04)
- [x] 1.3 `server.js`: `/api/monitoring/status` con `lastRunAt` y `runHours`; `/api/footer-stats` con `runHours`
- [x] 1.4 Tests: `test/schedulerCron.test.js` y `test/ultimaCorrida.test.js`

## Phase 2: pie y riel

- [x] 2.1 `public/js/footer.js` arma el pie; `#siteFooter` en `instagram.html`, `x.html` y `dashboard.html`; `main.js` completa el nombre y "Cerrar sesión" (REQ-RIEL-12)
- [x] 2.2 Riel y solapas en `instagram.html`, `main.js` por `[data-tab]` y hash, Monitoreo por defecto, Estadísticas deshabilitado (REQ-RIEL-01, REQ-RIEL-02)
- [x] 2.3 Panel de fuentes: `rail.js`, `data-full` y contadores en `monitoring.js` (REQ-RIEL-03)

## Phase 3: franja y radar

- [x] 3.1 Franja: título, estado, "Actualizar ahora", leyenda y el recuadro de progreso mudado con sus ids (REQ-RIEL-04)
- [x] 3.2 `public/js/monitoringRadar.js`: pulsos, ahora, corridas, tooltip, hover cruzado, clic, barrido, ondas, vacío y movimiento reducido (REQ-RIEL-05 a REQ-RIEL-08)
- [x] 3.3 `monitoring.js`: avisos `{ run }` y porcentaje; el feed ignora los avisos `run`

## Phase 4: contenido claro

- [x] 4.1 "Se despegaron" en tiras con selector de sentimiento (REQ-RIEL-09)
- [x] 4.2 Medidor de alcance en el pie de la tarjeta y columna "Alcance" en la tabla (REQ-RIEL-10)
- [x] 4.3 Fila de herramientas, Feed primero y por defecto, "Publicaciones detectadas" con "N de M" (REQ-RIEL-11)

## Phase 5: prueba y documentación

- [x] 5.1 Prueba en el navegador con el servidor de prueba: escritorio y celular, movimiento reducido, corrida simulada, `x.html` y el inicio
- [x] 5.2 `README.md`, `CLAUDE.md` y este registro
