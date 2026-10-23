# Tasks: estadisticas

Rama `estadisticas`, en una carpeta de trabajo aparte (la app del piloto
sirve `public/` desde la carpeta del repo). Sin Apify ni LLM. Se prueba con
un servidor de prueba en otro puerto y una copia de la base.

## Phase 0: plan y decisiones

- [x] 0.1 Fase 2 (rama `estadisticas-backend`): período en hora de Argentina, período anterior del mismo largo, `*Anterior` en null sin datos y la mediana desde el primer día con datos
- [x] 0.2 Plan archivo por archivo y siete preguntas; respuestas del dueño (23/10/2026): el Monitoreo toma el rango de Estadísticas como período temporal con ✕; `search_seen` a 100 días; positivas y negativas por palabra; tramos hacia atrás desde "hasta"; 6 en el ranking (10 en el endpoint); `--muted` oscuro a `#808aa5`; parar después del backend con el JSON real. Por defecto: sin tono = neutral, una fila por término con datos, sin badge si el anterior no tiene datos
- [x] 0.3 Revisión del JSON real de 30 días (23/10/2026): "Buenos Aires" como frase fija; "Se despegaron" con la misma función que el Monitoreo y el mismo número (55 de 296, mismos posteos); la rama pusheada

## Phase 1: backend

- [x] 1.1 Lecturas de la base por período, primer posteo y seguidores (REQ-EST-01)
- [x] 1.2 `src/stats.js` y `src/stopwords.js` (REQ-EST-02 a 09)
- [x] 1.3 `GET /api/monitoring/stats` montada desde `server.js` (REQ-EST-01)
- [x] 1.4 Motivo de cada posteo, ignorados y descartados por término (REQ-EST-07)
- [x] 1.5 `search_seen` se purga a los 100 días (REQ-EST-07)
- [x] 1.6 Menciones por término (REQ-EST-07)
- [x] 1.7 Temas con `anterior` y `destacada` (REQ-EST-08)
- [x] 1.8 Palabras con tono (REQ-EST-06)
- [x] 1.9 Tramos hacia atrás desde "hasta" (REQ-EST-08)
- [x] 1.10 "Buenos Aires" como frase fija (REQ-EST-06)
- [x] 1.11 Los ids de cada palabra (REQ-EST-06, REQ-EST-16)
- [x] 1.12 `temaSinDato` en `/api/monitoring/config` (REQ-EST-16)

## Phase 2: pantalla

- [x] 2.1 `--muted` oscuro a `#808aa5` (REQ-EST-17)
- [x] 2.2 `public/js/kpi.js` (REQ-EST-11)
- [x] 2.3 CSS de Estadísticas (REQ-EST-17)
- [x] 2.4 La solapa en `instagram.html`, `main.js` y el pie (REQ-EST-10)
- [x] 2.5 El Monitoreo con el rango de Estadísticas, el filtro por palabra y el tema sin dato (REQ-EST-16)
- [x] 2.6 `stats.js`: carga, período, estados y KPI (REQ-EST-10, REQ-EST-11)
- [x] 2.7 `stats.js`: nube, menciones y dona (REQ-EST-12, REQ-EST-13)
- [x] 2.8 `stats.js`: temas, horas y tono neto (REQ-EST-14, REQ-EST-15)
- [x] 2.9 `stats.js`: cuentas y ranking (REQ-EST-15)

## Phase 3: prueba y documentación

- [x] 3.1 `CLAUDE.md`, `README.md` y este registro
- [x] 3.2 Prueba en el navegador: la solapa a 1366 y 375 px, oscuro, movimiento reducido (emulado con Chrome sin ventana), 90 días, Positivos reales, sin datos, error, clics al Monitoreo, ranking y pop-up
- [x] 3.3 Suite con `IG_ACTOR=apidojo` y `apify` (469 de 469 con los dos)
- [x] 3.4 Revisión independiente (12 hallazgos; el verificador confirmó 4 medios y bajó el alto a medio): corregidos los 4 medios (la alerta no sacaba el rango, el anterior incompleto inflaba las comparaciones, el foco caía en `<body>` al rehacer el ranking y al sacar el rango o llegar desde Estadísticas) y 7 bajos (período entero sin datos, KPI entre 981 y 1200 px, el aviso de fechas mal escritas al volver, "tono neto por día", la cita y el ranking según el nivel, el anterior del Monitoreo con rango, la documentación). Queda para el dueño: `--accent` y `--pos` como texto chico en claro (3,83 y 3,51:1, tokens de la maqueta en toda la app)
