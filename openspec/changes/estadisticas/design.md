# Design: estadisticas

## Technical Approach

Backend: `src/stats.js` tiene una función pura por bloque (recibe posteos
ya preparados, devuelve números) y `armarEstadisticas`, que resuelve el
período, lee la base con lecturas propias de `src/db.js` y arma la
respuesta. `src/statsRoutes.js` la monta en `GET /api/monitoring/stats`,
separada de `server.js` como `postImageRoutes.js`, con lo que depende de la
app por parámetro (la config de la plataforma para las frases de la nube y
si tiene benchmark).

Frontend sin build ni dependencias nuevas. La solapa toma el marcado de la
maqueta en `instagram.html` con ids propios (`stats…`). `public/js/stats.js`
es un script clásico (prefijo `stats`) que pide el endpoint y dibuja cada
bloque con nodos y SVG (`createElementNS`); todo dato entra por
`textContent` y los tooltips van por `data-tip` (tip.js). Las tarjetas KPI
salen de `monitoringPanel.js` a `public/js/kpi.js` para que las dos solapas
usen las mismas.

## Architecture Decisions

- **Una sola respuesta.** Todos los bloques en un pedido: el mismo recorte
  en todos y una sola espera. Sin caché: con la base real son ~8 ms con 7
  días, ~50 con 30 y ~80 con 90.
- **Período en hora de Argentina, con datos o sin datos.** El anterior
  tiene el mismo largo y va pegado antes. Los días previos al primer posteo
  de la base no son días sin publicaciones: el período efectivo arranca en
  el primer día con datos (la mediana de lo habitual sale de esos días) y,
  si el anterior queda entero fuera, sus `*Anterior` van en null. La
  pantalla lo dice ("sin datos", "hay publicaciones guardadas desde el…").
- **El alcance es el del listado.** `accountStats.classifyPostAgainstBenchmark`
  al armar la respuesta, nada guardado; "se despegó" = `top.level ===
  'alto'`. Verificado con la base real: el KPI del Monitoreo (navegador) y
  el de Estadísticas dan 55 de 296 en 30 días, con los mismos posteos. Las
  razones viajan sin redondear; la pantalla las corta con
  `formatBenchmarkRatio`. La razón de un pico (día / mediana diaria) no
  lleva colchón y sí puede decir "× lo habitual".
- **La nube.** Cuenta posteos (no apariciones) por palabra en título y
  texto. Primero las frases de las palabras clave y búsquedas de la
  plataforma, más `FRASES_FIJAS` ("Buenos Aires", que salía partida),
  enteras y la más larga primero; después palabras de 3 letras o más sin
  `src/stopwords.js`. Trae los ids de los posteos: buscar el texto en el
  Monitoreo daba otro número en 48 de las 60 palabras ("Macri" 33 contra
  177, porque va dentro de "Jorge Macri").
- **Menciones por término.** El término sale del motivo base ("Búsqueda:
  <término>"), leído como `postReasonParts` de la pantalla. `detectadas`
  suma los ignorados y los descartados de `search_seen`; como `search_seen`
  no guarda `posted_at`, los descartados van por `first_seen_at` (con la
  ventana dinámica, el mismo día o el siguiente). `search_seen` pasa a
  purgarse a los 100 días para cubrir 90.
- **Tramos.** Por día hasta 14 días; más, de 7 días contados hacia atrás
  desde `hasta`: el último son los últimos 7 días ("esta semana") y el que
  queda corto es el primero.
- **Carga en la pantalla.** La primera vez que se abre la solapa
  (`openStats`, desde `openTab`) y al cambiar el período. Un contador de
  pedidos descarta la respuesta de un período que ya no es el elegido.
  Para saber si los datos quedaron viejos se compara una firma de los
  posteos de la tabla (ids, tono, tema): si cambió, se vuelve a pedir, ya si
  la solapa está a la vista y el pop-up cerrado (al cerrarlo, si no).
- **Del clic al Monitoreo.** `showInMonitoring` (en `monitoring.js`) limpia
  los filtros, pone la palabra o el tema y el período de Estadísticas como
  rango temporal (`monitorPeriodRange`), abre la solapa y baja a la lista.
  El rango es un período más: `monitorPeriodStart` / `monitorPeriodEnd` y
  `postInPeriod(post, from, to)`, así lo siguen la lista, los KPI (con el
  anterior de días enteros, el mismo de Estadísticas), las fuentes, el flujo
  y "Se despegaron". No se guarda. La palabra filtra por sus ids (filtro de
  fuente `palabra`); el tema, con el select de siempre, que ahora trae
  también los posteos sin tema al elegir "Coyuntura / Otros" (`temaSinDato`
  de la config), como los cuenta Estadísticas.
- **Badges y contraste.** El blanco de la maqueta sobre los badges no
  llegaba a 4,5:1 (en oscuro, ~3,1 en todos; "En alza" en claro, 2,17):
  van con `--accent-ink` (blanco en claro, la tinta oscura en oscuro),
  "En alza" en claro con `--fg` y "Pico" con el rojo un poco más oscuro.
  `--muted` oscuro pasa de `#6f7b99` a `#808aa5` (5,03 y 4,51).

## Data Flow

    GET /api/monitoring/stats ── statsRoutes ── armarEstadisticas
        └─ db (posteos del período y el anterior, ignorados, descartados,
           primer posteo, seguidores) + accountStats (alcance)
              └─ resumen · porDia · habitual · picos · porHora · palabras
                 · menciones · semanas · temas · cuentas · ranking

    stats.js ── openStats / período ── fetch ── statsRender (un bloque por función)
       └─ clic en palabra / tema ── showInMonitoring (monitoring.js)
       └─ clic en el ranking ── openFeedPopList (pop-up)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/stats.js`, `src/statsRoutes.js`, `src/stopwords.js` | Create | El endpoint |
| `src/db.js`, `src/monitor.js`, `server.js` | Modify | Lecturas, purga de 100 días, ruta y `temaSinDato` |
| `public/js/stats.js`, `public/js/kpi.js` | Create | La solapa y las tarjetas KPI |
| `public/js/monitoring.js`, `monitoringPanel.js`, `monitoringFlow.js` | Modify | Rango, filtro por palabra, tema sin dato, `kpi.js` |
| `public/instagram.html`, `public/js/main.js`, `public/js/footer.js` | Modify | La solapa, su aviso y el enlace del pie |
| `public/css/styles.css` | Modify | `04b-estadisticas` y `--muted` oscuro |
| `test/stats.test.js`, `test/searchEnrichment.test.js` | Create / Modify | 37 tests de Estadísticas y la purga |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Período, efectivo, cada bloque, término del motivo, frases, ids | `test/stats.test.js`, posteos armados en memoria |
| Integration | `armarEstadisticas` sobre una base temporal con posteos, ignorados y `search_seen`; el endpoint (400, 500, frases de la config) | `test/stats.test.js`, base en un tempfile |
| Real | Números de 30 días y tiempos | Script sobre una COPIA de la base (backup de SQLite, original en solo lectura) |
| Pantalla | 1366 y 375 px, oscuro, movimiento reducido, clics, sin datos, error | Servidor de prueba (otro puerto, copia, `--sin-hoy`), Chrome sin ventana |

## Migration / Rollout

Sin migración: no hay columnas ni tablas nuevas. La purga de 100 días
empieza a regir con el próximo ciclo.

## Open Questions

Ninguna.
