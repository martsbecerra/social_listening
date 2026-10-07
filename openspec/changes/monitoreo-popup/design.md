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
- **Un solo pop-up, que se rellena.** El esqueleto está en `instagram.html`
  y se llena al abrir y al navegar. Nada se arma por adelantado: son
  cientos de tarjetas y casi ninguna se abre.
- **La lista es la que está en pantalla.** Anterior y siguiente recorren las
  tarjetas del feed en su orden (filtros y orden elegidos), incluida la que
  se quedó con un sentimiento recién corregido. No hay una segunda lista
  que mantener al día.
- **El feed avisa cuando cambia la lista.** `feedListListeners` en
  `monitoringFeed.js`, con el mismo esquema que `monitoringViewListeners`:
  el pop-up se anota y, si el posteo que muestra ya no está, se cierra.
- **`monitoring.js` no se toca.** Sentimiento: `updateSentiment` y la fila
  de Tabulator, igual que la tarjeta. Ignorar: `confirmIgnore`, que saca la
  fila y avisa al feed.
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
- Al cerrar, el foco vuelve a la tarjeta del último posteo visto, que queda
  a la vista (la maqueta volvía a la tarjeta de partida).
- Si falla "ignorar", el pie vuelve a su estado normal con el aviso "No se
  pudo ignorar".
- Con un sentimiento recién corregido, la tarjeta de atrás se actualiza pero
  no sale hasta volver a filtrar, como hoy.
- "Se despegaron" sigue llevando a la tarjeta, sin abrir el pop-up.

## Verificación

La suite (`npm test`) no cubre el frontend. Cada tanda se prueba en el
navegador contra el servidor de prueba fuera del repo (otro puerto, copia de
la base, sin scheduler ni Apify).
