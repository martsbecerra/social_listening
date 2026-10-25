# Tasks: respuestas-tope-mapa

Rama `respuestas-tope-mapa`, en una carpeta de trabajo aparte. Sin revisor
independiente (decisión del dueño). Sin Apify ni LLM salvo la sonda chica y
UNA corrida real con respuestas al final, autorizadas por el dueño.

## Phase 0: plan y decisiones

- [x] 0.1 Plan archivo por archivo y ocho decisiones; respuestas del dueño (25/10/2026): el actor de comentarios con respuestas; la sonda chica; las respuestas de la cuenta solo en "¿La cuenta respondió?"; esa tarjeta debajo de "Verificados y figuras"; "Analizar 3.000" con más de 3.000; el (0,0) en un PR aparte antes (#31, mergeado); mapa y estado también en X; mosaicos de Google con respaldo automático en OpenStreetMap
- [x] 0.2 La sonda (US$ 0,0368): el padre va en `parentCommentUrl`; el tope cuenta solo los de primer nivel; no llegan todas las respuestas

## Phase 1: respuestas

- [x] 1.1 El actor de comentarios, las respuestas con su padre, el tiempo de espera y la tarifa
- [x] 1.2 Las respuestas en las tandas; las de la cuenta, afuera
- [x] 1.3 Métricas, informe y CSV
- [x] 1.4 Pantalla: "Más respuestas", "¿La cuenta respondió?", "↳ responde a" y el filtro

## Phase 2: tope y confirmación

- [x] 2.1 Topes de 3.000, el costo estimado y el factor de respuestas
- [x] 2.2 Publicación primero, la espera, confirmar y cancelar
- [x] 2.3 Pantalla de la confirmación

## Phase 3: login y mapa

- [x] 3.1 "Abrir Gmail" según el dominio
- [x] 3.2 Mosaicos de Google con Mapa / Satélite y respaldo en OpenStreetMap
- [x] 3.3 El estado de los reclamos fuera de la pantalla

## Phase 4: cierre

- [x] 4.1 CLAUDE.md y README
- [ ] 4.2 Suite con `IG_ACTOR=apidojo` y `apify`; capturas a 1366 y 375 px en claro y oscuro
- [ ] 4.3 PR sin mergear
- [ ] 4.4 La corrida real con respuestas (con el link y el OK del dueño)
