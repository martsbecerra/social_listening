# Design: riel-y-radar

## Technical Approach

Frontend sin build y sin dependencias nuevas, como el resto de la app. Se
porta de `design/riel-radar-v3.html` el CSS, el marcado y las funciones de
dibujo, y se sacan los datos simulados, los generadores y el control de la
maqueta. Los scripts siguen siendo clásicos (mismo ámbito global) y cada
archivo nuevo lleva su prefijo: `rail` en `public/js/rail.js` y `radar` en
`public/js/monitoringRadar.js`. Los dos los carga solo `instagram.html`.

El backend suma dos datos que la pantalla no tenía: la hora de la última
corrida de la plataforma, guardada en `monitoring_runs` (antes solo existía
en memoria y se perdía con un reinicio), y las horas de corrida que salen de
`MONITOR_CRON`. La franja no inventa horas.

## Architecture Decisions

- **El riel es la barra de solapas.** Mismo mecanismo de `main.js`
  (`data-tab` + `.tab-panel`), con el selector por atributo
  (`[data-tab]`): sirve igual para el riel de Instagram y para las solapas
  de `x.html`. Al cambiar de solapa se actualiza el hash (`#tab-…`, con
  `history.replaceState`) y se atiende `hashchange`: así navegan los enlaces
  del pie dentro de la misma página. Monitoreo abre por defecto.
- **Estadísticas está en el riel desde ahora, deshabilitado.**
  `aria-disabled="true"`, atenuado y con `title="Pronto"`; un clic no hace
  nada. Decisión del dueño: el riel no cambia en cada fase, y en la fase 3
  solo se activa. No hay pantalla "en preparación".
- **El pie lo arma `footer.js`.** Hoy el marcado del pie estaba repetido en
  cada HTML. Ahora cada página con sesión tiene un `<footer id="siteFooter">`
  vacío y `footer.js` lo arma una sola vez: DGAYD, la frase, las corridas
  por día con sus horas (`/api/footer-stats`) y las columnas de la maqueta.
  - Secciones: enlaces a `instagram.html#tab-…`. Estadísticas va
    deshabilitado, como en el riel.
  - Fuentes: enlaces a `instagram.html#fuentes-busquedas`,
    `#fuentes-cuentas` y `#fuentes-palabras`, que abren el panel.
  - Plataformas: Instagram, X, Facebook y TikTok (los dos últimos sin
    enlace: todavía no tienen página) y "Elegir plataforma" (el inicio).
  - Cuenta: el nombre del usuario y "Cerrar sesión" (los completa `main.js`
    con la misma sesión del encabezado).
  - Salen "Qué escuchamos" y la línea "Escuchando" del pie viejo.
  `index.html` y `login-verify.html` mantienen su pie chico hasta la fase 4.
- **Fuentes en un panel, con los ids de siempre.** Las tres cajas de
  configuración se mudan al panel con la jerarquía de la maqueta: arriba,
  "Búsquedas por palabra clave"; abajo, el bloque "Guía para el
  clasificador" con cuentas y palabras. `monitoring.js` las sigue manejando
  igual. El único cambio es que un contenedor con `data-full` muestra la
  lista completa y esconde "Ver todas". Los modales de "Ver todas" quedan en
  el DOM, ocultos, porque `monitoring.js` los usa. `rail.js` abre y cierra el
  panel (Esc, clic afuera, ✕); al abrir desde un botón, hace scroll a ese
  grupo y enfoca su input. Los contadores del riel los actualiza
  `monitoring.js` cada vez que dibuja una lista (`[data-src-count]`).
- **La franja es la dueña del estado de la escucha.** "Escuchando. Última
  corrida a las HH:MM, la próxima a las HH:MM." sale de
  `/api/monitoring/status?plataforma=instagram`. Lo pide el radar al cargar,
  al terminar una corrida y cada 5 minutos. Sin última corrida (nunca corrió
  ninguna) se dice solo la próxima. `monitoring.js`
  (`loadNextRun`) sigue escribiendo su línea en `x.html`.
- **El recuadro de progreso se muda adentro de la franja.** Mismos ids,
  mismo polling de `/api/monitoring/progress`, mismo "Ocultar". Se le suma
  el porcentaje grande de la maqueta (`#monitoringProgressPct`), que
  `monitoring.js` escribe si existe.
- **El radar lee lo mismo que el feed.** Las filas activas de la tabla
  (`monitoringTable.getData('active')`, ya filtradas por
  `postMatchesFilters`) publicadas hoy en hora de Argentina
  (`America/Argentina/Buenos_Aires`, por `posted_at`). Se redibuja con
  `notifyMonitoringViews`, igual que el feed.
- **Qué dibuja cada pulso.**
  - x: la hora de publicación (hora decimal, en hora de Argentina).
  - y: la razón de `benchmark.top.ratio`, en escala logarítmica entre 0,6×
    y 3× (se recorta en los bordes). Línea punteada de "alto" en 1,5× y de
    "lo habitual" en 1×.
  - Color: el sentimiento (jade positivo, arena neutral, coral negativo);
    null cuenta como neutral.
  - Radio: 4 + raíz(comentarios) · 0,42, como en la maqueta.
  - Alcance alto: halo y un anillo que late.
  - Sin `benchmark.top` (la cuenta no tiene mediana): círculo hueco sobre
    "lo habitual", y el tooltip avisa "sin referencia de su cuenta".
    Decisión del dueño.
- **Ahora y corridas.** La línea de "ahora" es la hora real de Argentina y
  se mueve sola (cada 30 s); a su derecha, la zona queda atenuada. Las
  marcas de corrida salen de `runHours`: las horas ya pasadas dicen
  "corrida" y las que faltan, "próxima".
- **Hover cruzado.** Un pulso con el mouse encima muestra el tooltip
  (cuenta, hora, título, likes, comentarios y alcance, todo por
  `textContent`) y le pone la clase `hot` a la tira, la tarjeta o la fila de
  ese posteo (`[data-post-id]`). Al revés, el mouse sobre una tira de "Se
  despegaron" o una tarjeta del feed resalta su pulso. Clic en un pulso:
  `openFeedPopSolo(id)`, como un destacado.
- **"Actualizar ahora" en el radar.** `monitoring.js` avisa por
  `notifyMonitoringViews` `{ run: 'start' }` al lanzar la corrida y
  `{ run: 'end', newIds }` al terminar, con los ids que no estaban antes. El
  radar barre una vez de izquierda a derecha al empezar y, al terminar, los
  posteos nuevos de hoy entran con tres ondas; la línea de "ahora" queda en
  la hora de fin. El feed ignora estos avisos.
- **Animación con freno.** `requestAnimationFrame` corre solo mientras la
  franja está a la vista, la pestaña del navegador no está en segundo plano
  y hay algo que animar (latido de los altos, barrido, ondas, la línea de
  ahora que respira). Con `prefers-reduced-motion` no hay latido, barrido
  ni ondas: un dibujo quieto por cambio.
- **Vacío.** Sin posteos de hoy, la franja dice "Todavía no hay
  publicaciones de hoy. La próxima corrida es a las HH:MM."; si el
  navegador no puede dibujar el canvas, "No se puede dibujar el radar en
  este navegador.". Nunca un recuadro negro.
- **"Se despegaron" en tiras.** Mismo criterio de siempre: hasta 4 posteos
  con `benchmark.top.level === 'alto'`, de mayor a menor razón. Cada tira
  lleva la razón grande con su métrica, el título, la cuenta, la hora, el
  valor contra la mediana y el selector de sentimiento, que usa
  `updateSentiment` como la tabla. El clic en la tira (salvo en el selector)
  abre el pop-up solo.
- **Medidor de alcance.** El nivel sale de `postReach` (`monitoring.js`),
  que combina lo que manda el backend; no se recalcula nada. Va en el pie
  de la tarjeta, al lado del selector de sentimiento, como en la maqueta
  (decisión del dueño), y en la columna nueva "Alcance" de la tabla, angosta
  y solo en Instagram. Esa columna ordena por nivel y, dentro de cada nivel,
  por razón. En "alto" las cinco barras laten y brillan, en "medio" la
  tercera respira y en "bajo" queda quieto. Sin referencia: "—".
- **Fila de herramientas.** Feed | Tabla (Feed primero y por defecto cuando
  no hay nada guardado), Sentimiento, Alcance, Cuenta, Desde/Hasta, Orden
  del feed, buscador y Limpiar, en una fila que baja entera si no entra. El
  título "Publicaciones detectadas" lleva al lado "N de M".
- **Clases que chocan.** Las de la maqueta que ya existían con otro estilo
  (`.status`, `.chip`, `.add-row`, `.btn-ghost`, `.btn`, `.sec-head`,
  `.foot-in`) van con alcance (`.sky …`, `.src-panel …`) o con nombre propio
  (`.sky-status`, `.hl-tops`). El CSS del pie viejo se reemplaza por el
  nuevo.

## Data Flow

```
GET /api/monitoring/status?plataforma=instagram
  ─► { nextRunAt, lastRunAt, runHours }   (scheduler.getRunHours, db.getLastFinishedRunAt)
GET /api/footer-stats ─► { …, corridasPorDia, runHours }

monitoring.js
  loadPosts ─► tabla ─► applyFilters ─► notifyMonitoringViews()
  runNow   ─► notifyMonitoringViews({ run: 'start' })
           ─► (corrida, polling del progreso de siempre)
           ─► loadPosts ─► notifyMonitoringViews({ run: 'end', newIds })

monitoringRadar.js (escucha notifyMonitoringViews)
  filas activas de hoy ─► pulsos ─► canvas
  hover ─► tooltip + .hot en [data-post-id]       clic ─► openFeedPopSolo(id)

rail.js ─► panel de fuentes (abrir/cerrar, scroll y foco al grupo)
footer.js ─► #siteFooter (y /api/footer-stats)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/scheduler.js` | Modify | `getRunHours()` |
| `src/db.js` | Modify | `getLastFinishedRunAt(plataforma)` |
| `server.js` | Modify | `/status` y `/footer-stats` |
| `public/instagram.html` | Modify | Riel, franja, panel, contenido claro, `#siteFooter` |
| `public/x.html`, `public/dashboard.html` | Modify | `#siteFooter` en lugar del pie viejo |
| `public/css/styles.css` | Modify | Secciones nuevas; el pie viejo se reemplaza |
| `public/js/main.js` | Modify | `[data-tab]`, hash, pie |
| `public/js/footer.js` | Modify | Arma el pie |
| `public/js/rail.js` | Create | Panel de fuentes |
| `public/js/monitoringRadar.js` | Create | Radar y estado |
| `public/js/monitoring.js` | Modify | Cambios mínimos (ver "Architecture Decisions") |
| `public/js/monitoringFeed.js` | Modify | Medidor en el pie, Feed por defecto, ignora `run` |
| `design/*.html` | Create | Las cuatro maquetas aprobadas |
