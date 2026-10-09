# Proposal: monitoreo-progreso-lista

## Intent

Que el recuadro de "Actualizar ahora" cuente qué va pasando y no solo
cuánto falta. Hasta ahora mostraba una fase con su contador y la barra, y
al terminar se escondía dejando una línea: no se veía qué búsqueda trajo
algo, cuál falló ni qué hizo cada fase.

El diseño ("lista simple") lo aprobó el dueño sobre una maqueta con datos
simulados, en la página de prueba. Las decisiones que la maqueta dejaba
abiertas quedaron en `design.md`.

## Scope

### In Scope

- Cabecera con la fase y su contador; en la detección, "Buscando posteos
  nuevos · N de 8 listas"
- La barra a todo el ancho
- Lista de hasta 6 líneas escritas para una persona: una por fuente de la
  detección (encontrados y nuevos, sin resultados, falló), lo que está en
  curso (como mucho 3 líneas) y un resumen por fase que termina
- Final a la vista, con el resultado ("N relevantes guardados de M nuevos"
  o el error) y un botón "Ocultar"
- "Nuevos" con un solo significado; el ciclo devuelve cuántos fueron
- El mismo recuadro en la solapa de X

### Out of Scope

- El cálculo del porcentaje (sigue igual, con la excepción de las fotos)
- Mostrar el progreso de un ciclo del cron que no lanzó quien mira
- El log de la consola: no cambia ninguna línea, salvo el nombre de la fase
  de detección
- Apify, la base y el orden de las fases del ciclo

## Capabilities

### New Capabilities

- `monitoreo-progreso-lista`: lista de lo que va pasando en "Actualizar
  ahora"

### Modified Capabilities

- Ninguna de las registradas en `openspec/`: el progreso real anterior
  estaba documentado en README y CLAUDE.md

## Approach

`src/monitoringProgress.js` ya tenía la fase, el contador y el porcentaje.
Se le suman las líneas: quien corre cada parte del ciclo avisa cuándo
empieza y cómo termina cada fuente, y deja un resumen al terminar su fase.
El módulo las entrega ya elegidas y ordenadas (`getView`), junto con el
cierre del ciclo terminado; el frontend solo dibuja. Detalle en `design.md`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/monitoringProgress.js` | Modified | Líneas (`startItem`, `finishItem`, `setPhaseSummary`), `getView` y el cierre del ciclo |
| `src/monitor.js` | Modified | Una línea por fuente; resumen de detalle y de relevancia; `isNewPost` y `newCandidates` |
| `src/accountStats.js`, `src/metricsRefresh.js`, `src/postImageSync.js` | Modified | El resumen de su fase |
| `server.js` | Modified | La ruta del progreso devuelve `getView()` |
| `public/instagram.html`, `public/x.html` | Modified | El recuadro: cabecera, barra, lista y "Ocultar" |
| `public/js/monitoring.js` | Modified | Dibuja cabecera, lista y final |
| `public/css/styles.css` | Modified | Estilos `run-progress-*` |
| `test/monitoringProgress.test.js`, `test/searchSource.test.js` | Modified | Líneas, tope de las en curso, resúmenes, cierre y un ciclo con búsquedas simuladas |
| `test/xMonitoring.test.js` | Modified | El resultado por plataforma trae `newCandidates` |
| `README.md`, `CLAUDE.md` | Modified | El progreso, al día |
| `src/scheduler.js`, `src/db.js`, adapters | Unchanged | |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| El texto de una línea frena el ciclo (contar los nuevos consulta la base) | Low | `describeFound` nunca tira: sin la cuenta, deja "N encontrados" |
| Se dibuja el cierre de un ciclo anterior al arrancar otro | Med | `startCycle` borra el cierre; el frontend ignora un "terminado" hasta ver avanzar el ciclo que espera |
| La última fase se queda sin su resumen | Med | El cierre queda disponible en `getView` y el frontend lo pide una vez más al recibir la respuesta |
| Un término de búsqueda o una cuenta interpretados como HTML | Low | Todo entra por `textContent` |
| El aviso de ciclo trabado deja de entender el progreso | Low | `getProgress` no cambia de forma; los tests anteriores siguen sin tocar |

## Rollback Plan

Revertir los commits de la rama. No hay cambios de datos ni de esquema.

## Success Criteria

- [x] La cabecera, la barra y la lista muestran lo que manda el backend, en vivo
- [x] Una búsqueda que falla se ve con ✕ y no frena el resto
- [x] Lo que está en curso ocupa como mucho 3 líneas
- [x] Cada fase deja su resumen; el final queda a la vista con "Ocultar"
- [x] "Nuevos" es lo mismo en las líneas y en el final
- [x] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify`
