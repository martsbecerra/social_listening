# Tasks: analisis-v4

Rama `analisis-v4`, en una carpeta de trabajo aparte (la app del piloto
sirve `public/` desde la carpeta del repo). Sin Apify ni LLM salvo UN
análisis real autorizado por el dueño. Se prueba con un servidor de
prueba en otro puerto y una copia de la base.

## Phase 0: plan y decisiones

- [x] 0.1 Relevamiento del análisis de hoy, la maqueta y los datos (24/10/2026)
- [x] 0.2 Plan archivo por archivo y doce preguntas; respuestas del dueño (24/10/2026): openspec sí; el análisis corre en el servidor; tonos en cantidades simples con el ruido aparte y el ponderado rotulado; temas con conteo; resumen = lectura estratégica; Copiar + WhatsApp + CSV; foto sin pedido nuevo; aviso de "ya analizado"; reclamos que conservan su gestión; "Cuándo comentaron" con al menos 10 comentarios con fecha; topes en 300 con tandas de 100 (en vez de no subirlos); un análisis real autorizado para el fixture

## Phase 1: base y Apify

- [x] 1.1 Tabla `analisis` y sus lecturas y escrituras (REQ-ANA-01)
- [x] 1.2 `apify_calls.analisis_id` (REQ-ANA-15)
- [x] 1.3 `upsertReclamo` con `conservarGestion` (REQ-ANA-11)
- [x] 1.4 Publicación y comentarios con aviso propio; fecha, id, código y foto; likes sin dato (REQ-ANA-03, REQ-ANA-08)
- [x] 1.5 Topes 300 (REQ-ANA-04)

## Phase 2: modelo

- [x] 2.1 Tandas de 100 y síntesis (REQ-ANA-04, REQ-ANA-05)
- [x] 2.2 El número real de analizados (REQ-ANA-04)
- [x] 2.3 Temas con conteo (REQ-ANA-05)
- [x] 2.4 Tonos en cantidades simples; el ponderado del informe (REQ-ANA-06)

## Phase 3: el trabajo y las rutas

- [x] 3.1 "Cuándo comentaron" (REQ-ANA-07)
- [x] 3.2 Progreso por id y sus pasos (REQ-ANA-03)
- [x] 3.3 El trabajo en el servidor, el mismo link en curso (REQ-ANA-02)
- [x] 3.4 Las rutas y la foto (REQ-ANA-02, REQ-ANA-08, REQ-ANA-09)
- [x] 3.5 Interrumpidos al arrancar (REQ-ANA-14)
- [ ] 3.6 El análisis real autorizado y el fixture anonimizado (REQ-ANA-18)

## Phase 4: pantalla

- [x] 4.1 La solapa de la maqueta (REQ-ANA-17)
- [x] 4.2 Progreso, recientes y `#analisis-<id>` (REQ-ANA-03, REQ-ANA-12)
- [x] 4.3 La precarga desde el pop-up y "ya analizado" (REQ-ANA-09, REQ-ANA-10)
- [x] 4.4 Compartir (REQ-ANA-13)
- [x] 4.5 "Análisis recientes" en el inicio (REQ-ANA-12)
- [x] 4.6 X: el Enter doble (REQ-ANA-16)

## Phase 5: cierre

- [x] 5.1 CLAUDE.md, README y `.env.example`
- [ ] 5.2 Suite con `IG_ACTOR=apidojo` y `apify`
- [ ] 5.3 Capturas a 1366 y 375, en oscuro y con movimiento reducido
- [ ] 5.4 Diferencias con la maqueta, PR sin mergear y revisor independiente
