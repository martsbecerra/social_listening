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
- [x] 4.3b Los fixtures anonimizados y su test (REQ-PRO-14): `test/analisisFixtureRealF.test.js`
- [x] 4.4 Revisor independiente y PR sin mergear
- [x] 4.5 La repetición solo del modelo con tandas de 50 (150 de 150, ninguna cortada, US$ 0,357) y el borrado de `data/account-types.example.json` (autorizado por el dueño)

## Phase 5: F2, decisiones (rama `analisis-pro-pantalla`)

- [x] 5.1 Respuestas del dueño (24/10/2026): edición de figuras en la tarjeta más una lista; las sugeridas descartadas quedan en la misma tabla con `origen = descartada`; en un v1, "No disponible en análisis anteriores" a la vista; el mapita solo con reclamos ubicados (los pendientes en la lista, sin punto); `#analisis-<id>` y `#analisis-galeria`. Se prueba con el análisis v2 de la repetición, sin gastar nada.

## Phase 6: F2, servidor

- [x] 6.1 Figuras descartadas: `origen = descartada`, `POST /api/figuras/:username/descartar`, sin rol en la vista, fuera de los verificados sin ficha de la síntesis, una sugerencia nueva no la toca (REQ-PRO-17)

## Phase 7: F2, pantalla

- [ ] 7.1 La solapa de la maqueta en `instagram.html` y sus estilos bajo `.ana4` (REQ-PRO-15)
- [ ] 7.2 Analizar, pasos con porcentaje, avisos, tira de recientes y vistas (REQ-PRO-15, REQ-PRO-18)
- [ ] 7.3 Los bloques del resultado desde `vista`, con "No disponible en análisis anteriores" (REQ-PRO-15, REQ-PRO-16)
- [ ] 7.4 Temas: filtro, ✎ y "+ tema" en v2 y v1 (REQ-PRO-12)
- [ ] 7.5 Figuras: tarjeta y "Lista de figuras" (REQ-PRO-17)
- [ ] 7.6 Comentarios y compartir (REQ-PRO-09, REQ-PRO-15)
- [ ] 7.7 Galería e inicio (REQ-PRO-18)

## Phase 8: cierre de la F2

- [ ] 8.1 Servidor de prueba con el análisis v2 de la repetición, el v1 real de la fase E y los sembrados; capturas a 1366 y 375 px en claro, oscuro y con movimiento reducido; contraste
- [ ] 8.2 CLAUDE.md, README y la lista de diferencias con la maqueta
- [ ] 8.3 Suite con `IG_ACTOR=apidojo` y `apify`
- [ ] 8.4 Revisor independiente y PR sin mergear
