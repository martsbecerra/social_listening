# Tasks: analisis-pro

Rama `analisis-pro` (F1), en una carpeta de trabajo aparte. Sin Apify ni
LLM salvo UNA corrida real autorizada por el dueño al final. Se prueba con
un servidor de prueba en otro puerto y una copia de la base.

## Phase 0: plan y decisiones

- [x] 0.1 La maqueta nueva y lo que hay en `main` (24/10/2026)
- [x] 0.2 Plan archivo por archivo y ocho preguntas; respuestas del dueño (24/10/2026): dos PR (F1 y F2, tags `v4-fase-f1` y `v4-fase-f`); el informe de 8 puntos reemplaza al institucional solo en Instagram; sin tipo de cuenta en Instagram; CSV de comentarios y "CSV de reclamos"; se cruzan todos los que comentaron, el modelo sugiere solo para verificados; sugerencias con `origen = sugerida`; hecho dominante desde el 20 %; ✎ renombra y une, "+ tema" a mano; métricas al leer; ponderado likes + 1; iniciales, sin seguidores, roles sin género, "+74 %" en vez de "1,7×"; la primera tanda sola define los temas

## Phase 1: base

- [x] 1.1 La maqueta nueva y los `.rar` fuera del repo
- [x] 1.2 Columnas nuevas de `analisis` y su relleno en los v1 (REQ-PRO-11)
- [x] 1.3 `figuras_publicas` y sus lecturas (REQ-PRO-06)
- [x] 1.4 Galería, anteriores de la cuenta, reclamos de un posteo, temas v2 (REQ-PRO-08, REQ-PRO-10, REQ-PRO-12)

## Phase 2: modelo

- [x] 2.1 Tanda v2 sin tipo de cuenta (REQ-PRO-01)
- [x] 2.2 La primera tanda define los temas (REQ-PRO-02)
- [x] 2.3 Síntesis v2 con los números del servidor (REQ-PRO-03, REQ-PRO-05, REQ-PRO-06)
- [x] 2.4 Informe de 8 puntos y CSV de comentarios (REQ-PRO-09)

## Phase 3: servidor

- [x] 3.1 `src/analysisMetrics.js` (REQ-PRO-04, REQ-PRO-05, REQ-PRO-07, REQ-PRO-08)
- [x] 3.2 Pasos y porcentaje (REQ-PRO-13)
- [x] 3.3 El trabajo v2 y las columnas
- [x] 3.4 Rutas: galería, forma completa, PATCH de temas, CSV, compatibilidad con la solapa de la fase E (REQ-PRO-10, REQ-PRO-12)
- [x] 3.5 `/api/figuras` (REQ-PRO-06)

## Phase 4: cierre de la F1

- [x] 4.1 CLAUDE.md y README
- [x] 4.2 Suite con `IG_ACTOR=apidojo` y `apify`
- [x] 4.3 La corrida real autorizada (24/10/2026)
- [x] 4.3a Lo que mostró: tandas de 50 con 16.000 de tope, la respuesta cortada se parte en dos, lo gastado en los errores, el punto 1 del informe, los temas vacíos, el prompt de ruido y pedidos
- [ ] 4.3b Los fixtures anonimizados y su test (REQ-PRO-14)
- [ ] 4.4 Revisor independiente y PR sin mergear
