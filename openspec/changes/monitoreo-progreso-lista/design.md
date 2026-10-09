# Design: monitoreo-progreso-lista

## Technical Approach

El progreso ya era real y en memoria (`src/monitoringProgress.js`): una
fase visible con su contador y un porcentaje global. El cambio le suma una
lista de líneas por ciclo y una vista (`getView`) pensada para la pantalla.
Nada de esto se guarda en la base ni sobrevive a un reinicio.

## Architecture Decisions

- **Las líneas las escribe y las elige el backend.** El frontend recibe un
  arreglo de `{ state, label, detail }` listo para dibujar. Así el criterio
  (qué entra en las 6 líneas, qué pasa con lo que está en curso) vive en un
  módulo puro y se prueba en la suite, que no cubre el frontend.
- **`getProgress` no cambia; se agrega `getView`.** `getProgress` sigue
  siendo el estado del ciclo en curso (`null` sin ciclo) y lo usa el aviso
  de ciclo trabado. `getView` es lo que devuelve la ruta
  `/api/monitoring/progress`: lo mismo más `suffix` y `lines`, y el cierre
  del ciclo terminado.
- **El cierre queda disponible hasta el próximo ciclo.** La última fase
  deja su resumen recién en `endCycle`, cuando ya no hay nada "en curso" que
  consultar, y entre el fin del ciclo y la respuesta de "Actualizar ahora"
  pasa un rato (se concilia el costo). `getView` devuelve entonces
  `{ finished: true, lines }`. `startCycle` lo borra. El frontend lo usa de
  dos maneras: lo dibuja si llega mientras espera (y ya vio avanzar ese
  ciclo), y lo pide una vez más al recibir la respuesta.
- **Búsquedas en paralelo: sin "la actual".** Las fuentes de la detección
  salen todas juntas (hasta `APIFY_MAX_CONCURRENT`). La cabecera dice
  "Buscando posteos nuevos · N de 8 listas" (`suffix: 'listas'`) y no nombra
  ninguna. En la lista, lo que está en curso ocupa como mucho 3 líneas: las
  dos primeras y "y N más · buscando…". El resto del lugar es para lo último
  que terminó, en el orden en que terminó.
- **Una línea por fuente, con clave.** `startItem(key, label, detail)` y
  `finishItem(key, { ok, detail })`. La clave lleva la plataforma y el tipo
  de fuente; la etiqueta es lo que se ve (`«término»`, `@cuenta`,
  `#hashtag`).
- **Un resumen por fase.** Quien corre la fase llama a `setPhaseSummary` con
  el nombre con el que la arrancó, apenas termina su trabajo y antes de que
  arranque la siguiente; la línea se agrega cuando la fase cede el lugar. Si
  la fase visible es otra (la suya no llegó a anunciarse), no hace nada. Sin
  resumen propio sale uno genérico ("4 de 4, 1 con error"). La detección no
  deja resumen (`summary: false`): sus líneas son las de cada fuente.
- **"Nuevos", un solo significado.** Nuevo = no está en `detected_posts` ni
  en `search_seen` (`monitor.isNewPost`). Cada fuente cuenta los suyos al
  terminar; el ciclo los cuenta sin repetidos entre fuentes, antes del
  detalle (que ya anota en `search_seen` lo que paga), y los devuelve en
  `porPlataforma.<red>.newCandidates`. El final dice "N relevantes guardados
  de M nuevos": N es `newCount`, M es la suma de `newCandidates`. La suma de
  las líneas puede ser mayor que M (un posteo que llega por dos búsquedas
  cuenta en las dos).
- **El resumen de relevancia cuenta solo los nuevos.** Un posteo ya evaluado
  que la búsqueda vuelve a traer pasa por el ciclo, pero no es nuevo: no
  suma ni a relevantes ni a descartados.
- **El final queda a la vista.** Con ✓ y el resultado, o con ✕ y el error
  (la barra queda donde llegó, en coral), y las últimas líneas. Se va con
  "Ocultar" o al lanzar otro ciclo. Sale el párrafo aparte que decía
  "Listo: X posteos revisados, Y nuevos".
- **El texto de la cabecera no se corta.** Fluye como un renglón y sigue
  abajo si no entra (celular, o un error largo); el contador no se parte.
- **La lista no se redibuja si no cambió.** Al rehacerla, las rueditas de lo
  que está en curso volverían a empezar en cada consulta.
- **X usa el mismo recuadro.** El progreso no sabe de plataformas: en X las
  líneas son por cuenta, hashtag y keyword.

## Data Flow

```
scheduler.runCycle ─► progress.startCycle()
  monitor.runMonitoringCycle
    startPhase('Buscando posteos nuevos', n, { suffix: 'listas', summary: false })
    por cada fuente: startItem ─► (consulta) ─► finishItem + tick
    detalle / relevancia: startPhase ─► tick ─► setPhaseSummary
  accountStats, metricsRefresh, postImageSync: startPhase ─► tick ─► setPhaseSummary
progress.endCycle() ─► cierra la última fase y guarda el cierre

GET /api/monitoring/progress ─► progress.getView()
  en curso:   { phase, done, total, suffix, percent, lines }
  terminado:  { finished: true, lines }
POST /api/monitoring/run-now ─► { checked, newCount, porPlataforma: { <red>: { newCandidates, … } } }
```

## Líneas de cada fase

| Fase | Línea al terminar |
|------|-------------------|
| Buscando posteos nuevos | Una por fuente: "«macri» · 50 encontrados, 6 nuevos", "· sin resultados", "· falló" |
| Detalle de búsquedas | "11 posteos nuevos" (y ", 2 sin texto"); "falló" |
| Clasificando relevancia | "Relevancia · 4 relevantes, 7 descartados" |
| Guardando fotos | "Fotos · 11 guardadas, 1 no disponible" (y ", 2 pendientes") |
| Guardando fotos pendientes | "Fotos pendientes · …" |
| Calculando benchmark de cuentas | "Benchmark de cuentas · 3 cuentas" (y ", 1 sin calcular") |
| Refrescando métricas | "Métricas · 148 actualizadas, 2 sin respuesta" (y ", N sin consultar"); en modo perfil, "N cuentas consultadas" |
