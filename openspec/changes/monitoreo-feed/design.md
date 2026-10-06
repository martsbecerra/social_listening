# Design: monitoreo-feed

## Technical Approach

El feed es una segunda vista sobre los mismos datos de la tabla, no un
módulo con datos propios. La tabla de Tabulator sigue siendo la dueña de
los posteos (`monitoringTable.getData()`) y de la barra de filtros; el feed
toma esos posteos, les aplica la misma condición y los dibuja como
tarjetas. Así no hay una segunda copia que mantener al día: corregir un
sentimiento o ignorar un posteo actualiza la fila de la tabla y la tarjeta
se apoya en eso.

El frontend no tiene paso de build ni módulos: son scripts clásicos que
comparten el ámbito global. `public/js/monitoringFeed.js` se carga después
de `public/js/monitoring.js` y usa lo que ese archivo ya define. Todo lo
que declara lleva el prefijo `feed` / `FEED_` para no chocar con nada.

## Architecture Decisions

- **Solo Instagram, por carga y no por condición.** `instagram.html` carga
  `monitoringFeed.js`; `x.html` no. En `monitoring.js` no hay ningún "si es
  Instagram" para el feed: avisa a las vistas anotadas en
  `monitoringViewListeners`, y en X esa lista está vacía. Los controles que
  solo existen en `instagram.html` (`fAlcanceEl`) son null en X y el código
  los trata así.
- **Un solo filtro para las dos vistas.** `readFilterValues()` lee la barra
  y `postMatchesFilters(post, filters)` decide. La tabla lo usa en
  `setFilter`; el feed, al dibujar. El predicado es el de antes (sentimiento
  con "sin clasificar" como ausencia de valor, cuenta, fechas inclusivas en
  hora local sobre `posted_at`, buscador sin acentos sobre título, cuenta y
  texto) más el alcance.
- **Alcance: se combina, no se recalcula.** El backend ya clasifica likes y
  comentarios contra la mediana de la cuenta (`classifyValue` en
  `src/accountStats.js`: alto desde 1,5×, bajo por debajo de 0,5×, normal
  en el medio, o sin referencia). `postReach(post)` toma esos dos niveles y
  devuelve una sola etiqueta con la regla del dueño: likes y comentarios
  pesan igual y vale el mejor de los dos (alto si alguno da alto; bajo solo
  si los dos dan bajo; medio en el resto; "normal" se muestra "medio"). Una
  métrica sin referencia no cuenta y decide la otra; si ninguna la tiene,
  devuelve null y el posteo no lleva etiqueta. Guarda qué métrica disparó
  (`by`, `label`) y su razón (`ratio`); en un empate, comentarios, igual
  que `highlightOf` en el backend. Como las dos métricas se cortan en los
  mismos valores, la de mejor nivel es siempre la de mayor razón: por eso
  "Mayor alcance" ordena por esa razón.
- **Aviso a las vistas.** `notifyMonitoringViews(change)`: sin argumento,
  cambiaron los datos o los filtros y hay que redibujar; `{ ignoredId }`,
  se ignoró ese posteo; `{ goToId }`, un destacado de "Se despegaron" pide
  mostrar ese posteo, y la vista activa devuelve true para hacerse cargo
  (si ninguna lo hace, lo muestra la tabla).
- **Redibujo completo, con espera.** Cada cambio de filtros, de orden o de
  datos rehace todas las tarjetas (`renderFeed`). El buscador avisa una vez
  por tecla: `scheduleFeedRender` espera 150 ms y dibuja una sola vez. En
  la vista Tabla no se arma ninguna tarjeta.
- **Cientos de tarjetas sin paginar.** `content-visibility: auto` con
  `contain-intrinsic-height: auto 420px` para que el navegador no calcule
  ni pinte las que están fuera de pantalla; `Intl.NumberFormat` y
  `Intl.DateTimeFormat` armados una sola vez (`toLocaleString` con opciones
  crea uno por llamada); acciones atendidas en el contenedor, no tarjeta
  por tarjeta; el detalle de "Ver más" se arma recién al abrir. Medido con
  470 tarjetas: redibujo completo en unos 46 ms y abrir una fila entre 2 y
  4 ms. Antes de estas medidas, cada tecla del buscador rehacía todo y
  trababa la escritura.
- **Formateadores compartidos, misma salida.** `formatBenchmarkRatio` y
  `formatFullDateTime` los usan las dos redes. Se compararon contra la
  versión anterior con miles de valores (0, negativos, miles, millones,
  NaN, null, fechas inválidas y los valores reales de la base). La única
  diferencia apareció con valores que no son números (un null pasaba a
  verse "0,0" en vez de tirar): ahora solo los números van por el
  formateador compartido.
- **Datos de Instagram, nunca como HTML.** Título, texto, cuenta y motivo
  entran por `textContent`. Como HTML solo se insertan constantes propias
  (los íconos SVG). El id del posteo va a `data-id` y se busca con
  `CSS.escape`.
- **Acciones con el código de la tabla.** El selector de sentimiento es el
  mismo (`buildSentimentSelect`); el cambio llama a `updateSentiment` y
  actualiza la fila de Tabulator. La X de ignorar abre el mismo cartel
  (`openIgnoreModal`); al confirmar, `confirmIgnore` saca la fila y avisa
  con `{ ignoredId }`: sale solo esa tarjeta, sin rehacer el resto.
- **"Ver más" por fila visual.** La grilla estira las tarjetas de una fila
  al alto de la más alta; abrir una sola dejaría huecos en las de al lado,
  así que se abren y se cierran juntas las que quedaron a la misma altura
  (`feedRowCards`, misma tolerancia que la maqueta). Un redibujo las deja
  cerradas, como en la maqueta. `feedOpenIds` recuerda con qué posteo se
  abrió cada fila solo para rearmarlas cuando las tarjetas cambian de lugar
  sin redibujar: al ignorar una y al cambiar el ancho de la ventana.
- **Imagen: un solo punto para enchufarla.** `feedImageUrl(post)` devuelve
  hoy siempre null y la tarjeta muestra el recuadro de reemplazo (degradé
  con el tono de la cuenta, ícono del tipo, etiquetas de tipo y alcance).
  El resto ya está armado: `<img loading="lazy">` y el aviso "Imagen no
  disponible" si no carga.
- **Memoria de la vista.** `localStorage`, clave `sl.monitoreo.vista`
  (`tabla` | `feed`), con try/catch en lectura y escritura; cualquier otro
  valor vale como `tabla`.

## Decisiones del dueño sobre lo que la maqueta no resuelve

- La pastilla fija de sentimiento de la maqueta se reemplaza por el
  selector de la tabla, con sus colores (neutral en ámbar, también en el
  borde de la tarjeta). La X de ignorar va arriba a la derecha.
- La razón ("5,4×") va al lado de la métrica que disparó el alcance.
- Ancho mínimo de tarjeta 240 px y no los 230 de la maqueta: el contenedor
  de la app es más ancho y con 230 entraban cinco columnas apretadas.
- Posteos sin tipo detectado: ícono de imagen y sin etiqueta de tipo.
- "Ver más" muestra las tres filas de la maqueta más las mismas dos para
  comentarios, la métrica que disparó el alcance, la fecha y hora y "Ver
  perfil". El motivo completo va debajo de su etiqueta, a lo ancho. Una
  métrica sin referencia lleva una sola línea con el texto de la tabla.
- Cambiar un filtro, el orden o la vista cierra las tarjetas abiertas.
  "Se despegaron" lleva a la tarjeta pero no la abre.
- El selector "Alcance" tiene las tres opciones de la maqueta; los posteos
  sin etiqueta solo se ven con el filtro en blanco.
- La tabla no suma columna de alcance. "Limpiar" no toca el orden.
- Se aceptan como están: nombres de cuenta cortados con puntos suspensivos
  (el nombre entero va en `title`), la barra de filtros en dos renglones a
  1366 px, un renglón más en Feed entre unos 860 y 1010 px de ventana y la
  barra alta en celular.

## Verificación

La suite (`npm test`) no cubre el frontend. Cada paso se probó en el
navegador contra un servidor de prueba fuera del repo: otro puerto, sirve
`public/` tal cual, responde `/api/monitoring/*` desde una copia de la base
en memoria y no carga el scheduler ni ningún módulo de Apify o del LLM. La
app real no se relanzó ni se tocó la base del piloto.

Los cambios de `monitoring.js` se compararon además fuera del navegador
contra el commit anterior, con los posteos reales: mismo resultado del
filtro para 1.260 combinaciones en Instagram y en X, y la etiqueta de
alcance igual a `benchmark.top` del backend en todos los posteos. Reparto
con la base del 6/10/2026 (473 posteos): 202 alto, 220 medio, 39 bajo y 12
sin etiqueta.
