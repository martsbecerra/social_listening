# Tasks: monitoreo-v4

Rama `monitoreo-v4`, en una carpeta de trabajo aparte (la app del piloto
sirve `public/` desde la carpeta del repo). Sin Apify ni LLM. Se prueba con
un servidor de prueba en otro puerto y una copia de la base.

## Phase 0: plan y decisiones

- [x] 0.1 Plan archivo por archivo y ocho preguntas; respuestas del dueño (22/10/2026): "Hoy" por defecto con la línea vacía "Todavía no hay publicaciones de hoy · ver 7 días"; "la mayor: N,NN× en comentarios, de @cuenta" también en la alerta; el selector de tono sigue siendo el desplegable pastilla; confirmación corta en el chip; `new_candidates` con "—" en las viejas, traídas desde las búsquedas y el modelo del `.env`; `temas` en `/config`; Orden deshabilitado en Tabla; la fila de la tabla sigue desplegando

## Phase 1: backend

- [x] 1.1 `monitoring_runs.new_candidates` y el scheduler la llena (REQ-MV4-07)
- [x] 1.2 `src/lastRun.js` y `lastRun` + `model` en `/api/monitoring/status` (REQ-MV4-07)
- [x] 1.3 `temas` en `/api/monitoring/config` (REQ-MV4-09)
- [x] 1.4 `test/resumenCorrida.test.js`

## Phase 2: pantalla

- [x] 2.1 CSS del Monitoreo de la maqueta
- [x] 2.2 Marcado, período y filtros nuevos (REQ-MV4-01, REQ-MV4-09)
- [x] 2.3 Panel: KPI, fuentes, pulso, pipeline, alertas, cuentas (REQ-MV4-02 a 05, 07, 08)
- [x] 2.4 Flujo en vivo (REQ-MV4-06)
- [x] 2.5 Recuadro de progreso (REQ-MV4-10)
- [x] 2.6 Feed en filas completas (REQ-MV4-11)
- [x] 2.7 "Se despegaron" del período (REQ-MV4-12)
- [x] 2.8 Pop-up sobre una lista (REQ-MV4-13)
- [x] 2.9 Medidor `.reach` (REQ-MV4-14)

## Phase 3: prueba y documentación

- [x] 3.1 `CLAUDE.md`, `README.md` y este registro
- [ ] 3.2 Prueba en el navegador: la solapa a 1366 y 375 px, oscuro, movimiento reducido, corrida simulada, X
- [ ] 3.3 Suite con `IG_ACTOR=apidojo` y `apify`
- [ ] 3.4 Revisión independiente y correcciones de lo alto y lo medio
