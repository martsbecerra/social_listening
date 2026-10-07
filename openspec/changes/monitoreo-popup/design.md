# Design: monitoreo-popup

## Technical Approach

El pop-up es una vista más sobre los datos que el feed ya tiene: lee el
posteo de la fila de Tabulator (como las tarjetas) y no guarda copia. Vive
en `public/js/monitoringFeedPopup.js`, un script clásico que
`instagram.html` carga después de `monitoringFeed.js`; todo lo suyo lleva el
prefijo `feedPop` / `FEED_POP_`.

## Architecture Decisions

- **`<dialog>` del navegador, con `showModal()`.** Da sin código propio el
  foco atrapado adentro, el resto de la página inactivo, Esc y la capa de
  arriba de todo (no compite con las barras pegadas). El `<dialog>` es el
  fondo oscuro a pantalla completa y la ventana es un hijo, así un clic en
  el fondo se distingue de un clic adentro. Lo único que no trae es el
  bloqueo del scroll de la página: se agrega con una clase en `<html>`,
  compensando el ancho de la barra de scroll para que el fondo no salte.
- **El fondo se mide con la pantalla que se ve.** Ancho y alto en unidades
  de viewport, no en porcentaje: en celular, si algo de la página es más
  ancho que la pantalla, el navegador agranda el área de los elementos fijos
  y un 100 % dejaba la ✕ afuera (pasa hoy con la barra superior a 375 px).
- **Cerrar ordena todo en el momento.** `closeFeedPop` es el único camino
  (la ✕, Esc, clic afuera, el propio código) y deja la página y el foco como
  estaban sin esperar al evento `close` del `<dialog>`, que el navegador
  dispara recién en el cuadro siguiente; ese evento queda de respaldo.
- **Esc se atiende en la tecla.** Con el pedido de confirmación de "ignorar"
  abierto lo cancela; si no, cierra. No se deja al aviso `cancel` del
  navegador, que solo se puede frenar si hubo un clic real justo antes;
  `cancel` queda para cuando el pedido de cerrar no viene de una tecla
  dentro de la ventana (el botón "atrás" del celular).
- **El foco nunca queda afuera.** Al pasar de posteo se rehacen el contenido
  y el pie; si lo que tenía el foco desapareció o quedó deshabilitado (la
  flecha en un extremo, "Ignorar"), pasa a la ✕. Sin foco adentro, ← → y Esc
  dejarían de llegar.
- **El foco no se queda en el selector de sentimiento.** En un selector con
  foco las flechas cambian el valor y lo guardan, así que → después de
  corregir con el mouse volvía a corregir. El pop-up anota si el selector
  se tocó con el mouse o con el teclado: con el mouse, al cambiar el valor
  el foco pasa a la ✕; con el teclado se queda.
- **Doble clic.** El segundo clic puede caer sobre algo que no estaba ahí en
  el primero: el pop-up recién abierto (el fondo lo cerraba en el acto) o el
  pie recién rehecho ("Abrir en Instagram" queda donde estaban "Cancelar" y
  "Sí, ignorar"). En la fase de captura se descarta todo clic repetido
  (`detail > 1`) que no caiga en el mismo elemento que el anterior; apretar
  varias veces seguidas la misma flecha sigue andando.
- **Confirmar baja la marca de "pidiendo confirmación".** Con el pedido de
  ignorar en camino no queda nada que cancelar: Esc cierra.
- **Al cerrar, la tarjeta a la vista.** Si se navegó o la lista cambió con
  el pop-up abierto, la tarjeta del posteo en el que se cerró se trae debajo
  de la barra de filtros cuando no quedó entera a la vista. Sin navegar y
  con la lista igual, la página no se toca.
- **Un solo pop-up, que se rellena.** El esqueleto está en `instagram.html`
  y se llena al abrir y al navegar. Nada se arma por adelantado: son
  cientos de tarjetas y casi ninguna se abre.
- **La lista es la que está en pantalla.** Anterior y siguiente recorren las
  tarjetas del feed en su orden (filtros y orden elegidos), incluida la que
  se quedó con un sentimiento recién corregido. No hay una segunda lista
  que mantener al día.
- **El feed avisa cuando cambia la lista.** `feedListListeners` en
  `monitoringFeed.js`, con el mismo esquema que `monitoringViewListeners`.
  Sin argumento: la lista ya cambió (redibujo, o salió una tarjeta); si el
  posteo abierto no está, el pop-up se cierra, y si está se actualiza el
  contador. `{ removing }`: esa tarjeta está por salir y todavía ocupa su
  lugar; si es la del posteo abierto, el pop-up pasa a la de al lado (la
  siguiente, o la anterior si era la última) y se cierra si no hay ninguna.
- **`monitoring.js` no se toca.** Sentimiento: `feedSetSentiment` (en
  `monitoringFeed.js`, la misma función que usa la tarjeta), que llama a
  `updateSentiment` y actualiza la fila de Tabulator; después la tarjeta de
  atrás se rehace con el dato nuevo. Ignorar: `confirmIgnore` tal como
  está; lee el posteo de `pendingIgnoreId`, que es lo que anota el cartel
  de la tabla al abrirse, así que el pop-up lo anota directo (su
  confirmación va en el pie) y espera. Si después sigue en el mismo posteo,
  el pedido falló.
- **Datos de Instagram, nunca como HTML.** Igual que en el feed: todo entra
  por `textContent`.
- **Imagen: un solo punto.** `feedPopImageUrl(post)` devuelve hoy siempre
  null y el lado izquierdo muestra el recuadro rayado con "Sin foto" y el
  tipo. La rama con imagen ya está armada (imagen entera, sin recortar, y el
  mismo recuadro con "Imagen no disponible" si no carga).

## Decisiones del dueño

- "Ver más" y el clic en la foto abren el pop-up; la fila desplegada se saca.
- Sin foto, el lado izquierdo dice "Sin foto". "Imagen no disponible" queda
  solo para una imagen que falló.
- Al cerrar, el foco vuelve a la tarjeta del último posteo visto (la
  maqueta volvía a la tarjeta de partida). Si se navegó, esa tarjeta se trae
  a la vista y parpadea una vez, como al llegar desde "Se despegaron".
- Si falla "ignorar", el pie vuelve a su estado normal con el aviso "No se
  pudo ignorar".
- Con un sentimiento recién corregido, la tarjeta de atrás se actualiza pero
  no sale hasta volver a filtrar, como hoy.
- "Se despegaron" sigue llevando a la tarjeta, sin abrir el pop-up.
- La barra superior que se pasa del ancho en celular y el aviso cuando falla
  el guardado del sentimiento quedan pendientes fuera de este cambio (ver
  `tasks.md`).

## Verificación

La suite (`npm test`) no cubre el frontend. Cada tanda se probó en el
navegador contra el servidor de prueba fuera del repo (otro puerto, copia de
la base, sin scheduler ni Apify), con 473 posteos reales: a 1366 px, a
1100 px y en tamaño celular (375 px, emulado); ← → y Esc con teclas reales;
ignorar con éxito, con el pedido fallando, en el último posteo y con una
sola tarjeta en la lista; la rama con imagen, con imágenes de ejemplo
(vertical, horizontal y una que no carga). `public/js/monitoring.js` y
`public/x.html` quedaron sin diferencias contra `main`.

La revisión independiente no encontró nada grave. Sus seis hallazgos y los
dos de la revisión propia se reprodujeron en la página de prueba; los cinco
primeros se arreglaron, cada uno en su commit y probado con clics y teclas
reales, y el resto quedó anotado en `tasks.md`.
