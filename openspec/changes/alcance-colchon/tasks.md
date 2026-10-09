# Tasks: alcance-colchon

Un commit por paso en la rama `alcance_colchon`. Sin Apify. El análisis y la página de prueba, con copias de la base.

## Phase 0: análisis y decisiones

- [x] 0.1 Con una copia de la base: cuántos posteos son alto / medio / bajo con la regla anterior y con la nueva, y ejemplos reales que dejan de ser alto
- [x] 0.2 Colchón y piso de comentarios equivalentes a los de likes: 300 y 150
- [x] 0.3 Corte de medio: tabla con 1,05, 1,1, 1,2 y 1,3; el dueño eligió 1,1

## Phase 1: la regla

- [x] 1.1 `src/reachRule.js`: lectura y validación de `REACH_*`, razón con colchón y nivel con piso (REQ-ALC-01, REQ-ALC-02, REQ-ALC-03)
- [x] 1.2 `test/reachRule.test.js`: colchón, piso, mediana 0, bordes 1,09 / 1,10 / 1,50, lectura del `.env`, valores inválidos y vuelta a la regla anterior

## Phase 2: benchmark

- [x] 2.1 `accountStats.classifyValue` usa la regla; cada métrica lleva `cushion` y `floor` (REQ-ALC-04)
- [x] 2.2 `accountStats.highlightOf`: mejor nivel, después mayor razón; devuelve `level` (REQ-ALC-05)
- [x] 2.3 `scripts/recalc-account-stats.js`: candidatos a "Se despegaron" por alcance alto
- [x] 2.4 `test/accountStats.test.js` y `test/likesNull.test.js`, con los números de la regla nueva

## Phase 3: arranque y configuración

- [x] 3.1 `server.js`: valida `REACH_*` antes de cargar el resto y muestra los números en uso (REQ-ALC-03)
- [x] 3.2 `.env.example`: las seis variables

## Phase 4: frontend

- [x] 4.1 `monitoring.js`: razón con dos decimales cortados; detalle de la tabla con "medio" y el colchón (REQ-ALC-06)
- [x] 4.2 `monitoring.js`: "Se despegaron" con los alto que manda el backend, el valor y la mediana reales (REQ-ALC-05)
- [x] 4.3 `monitoringFeed.js`: cartelito de la razón en la tarjeta; orden "Mayor alcance" por etiqueta y razón
- [x] 4.4 `monitoringFeedPopup.js`: razón junto a la etiqueta; mediana real y colchón en cada métrica (REQ-ALC-06)
- [x] 4.5 Probado en el navegador con el servidor de prueba y una copia de la base: tabla, feed, filtro y orden de alcance, "Se despegaron" y pop-up, en escritorio y en celular; los bordes reales (1,09 bajo, 1,10 medio, 1,50 alto)
- [x] 4.6 `instagram.html`: el subtítulo de "Se despegaron" pasa de "muy por encima del promedio de su propia cuenta" a "Posteos con alcance alto: muy por encima de lo normal de su propia cuenta"

## Phase 5: documentación

- [x] 5.1 `README.md`, `CLAUDE.md` y este registro

## Pendientes (fuera de este cambio)

- Un comentario de `public/css/styles.css` y las maquetas de `design/` todavía muestran la razón con un decimal ("5,4×")
- La suite no cubre el frontend: `formatBenchmarkRatio` (el corte a dos decimales) y `postReach` se probaron a mano
- El alcance mira solo likes y comentarios: no hay vistas ni compartidos
- Benchmark de X: sigue pendiente (X no tiene `capabilities.benchmark`)
