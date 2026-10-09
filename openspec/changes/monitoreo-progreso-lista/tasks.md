# Tasks: monitoreo-progreso-lista

Rama `monitoreo_progreso_lista`, en una carpeta de trabajo aparte (la app del piloto quedó corriendo). Sin Apify. Probado con el servidor de prueba y una copia de la base.

## Phase 0: maqueta y decisiones

- [x] 0.1 Maqueta en la página de prueba, con datos simulados, sobre la página real
- [x] 0.2 Decisiones del dueño: cabecera sin un término solo ("Buscando posteos nuevos · N de 8 listas"); en curso, como mucho 3 líneas; "nuevos" con un solo significado y final "N relevantes guardados de M nuevos"; final a la vista con "Ocultar"; resúmenes de las otras fases

## Phase 1: backend

- [x] 1.1 `src/monitoringProgress.js`: líneas (`startItem`, `finishItem`), resumen por fase (`setPhaseSummary`, genérico si falta, `summary: false`), `suffix`, `getView` con el tope de 6 líneas y de 3 en curso, y el cierre del ciclo terminado (REQ-PROG-01 a REQ-PROG-04)
- [x] 1.2 `src/monitor.js`: una línea por fuente (`trackSource`, `describeFound`), `isNewPost`, `newCandidates` por plataforma, resumen de detalle y de relevancia (REQ-PROG-02, REQ-PROG-05)
- [x] 1.3 `src/accountStats.js`, `src/metricsRefresh.js` (por URL y por perfil), `src/postImageSync.js`: el resumen de su fase (REQ-PROG-03)
- [x] 1.4 `server.js`: la ruta del progreso devuelve `getView()`
- [x] 1.5 Tests: `test/monitoringProgress.test.js` (los anteriores, sin tocar, más las líneas), `test/searchSource.test.js` (un ciclo con cuatro búsquedas simuladas: nuevos, repetido entre búsquedas, sin resultados, falló), `test/xMonitoring.test.js` (`newCandidates` en el resultado)

## Phase 2: frontend

- [x] 2.1 `public/instagram.html` y `public/x.html`: cabecera (ícono, texto, contador, "Ocultar"), barra y lista; sale el párrafo del resultado
- [x] 2.2 `public/js/monitoring.js`: dibuja lo que manda el backend; final con ✓ o ✕; no redibuja la lista si no cambió; ignora el cierre de un ciclo anterior (REQ-PROG-06)
- [x] 2.3 `public/css/styles.css`: estilos `run-progress-*`
- [x] 2.4 Probado en el navegador con un ciclo simulado que llama al módulo real: búsquedas en paralelo, una que falla, las otras fases, final, final con error, segundo ciclo seguido, "Ocultar", escritorio y celular

## Phase 3: documentación

- [x] 3.1 `README.md`, `CLAUDE.md` y este registro

## Pendientes (fuera de este cambio)

- El porcentaje sigue pudiendo bajar cuando arranca una fase (suma su trabajo al total conocido): es el comportamiento anterior
- Si un ciclo del cron está corriendo, "Actualizar ahora" responde que ya hay uno en curso y no muestra su avance
- La suite no cubre el frontend: `drawProgressLines`, `monitorDoneText` y el final se probaron a mano
- Un posteo descartado sin haber pagado su detalle (llegó con texto y el clasificador dijo que no) no queda anotado en `search_seen`: si la búsqueda lo vuelve a traer, vuelve a contar como nuevo. Es anterior a este cambio
