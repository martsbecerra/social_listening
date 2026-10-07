# Spec: monitoreo-popup

Pop-up "Ver más" del feed del Monitoreo de Instagram. Solo frontend; el backend, la base, la tabla y X no cambian.

---

## ADDED Requirements

### Requirement: REQ-POP-01 — Abrir y cerrar

"Ver más" y un clic en la foto de una tarjeta MUST abrir el pop-up de ese posteo. El pop-up MUST cerrarse con la ✕, con Esc y con un clic en el fondo oscuro. Mientras está abierto, la página de atrás MUST NOT desplazarse ni recibir foco. Al abrir, el foco MUST ir al botón de cerrar; al cerrar, MUST volver al "Ver más" de la tarjeta del último posteo visto. Si se navegó a otro posteo que el de partida, esa tarjeta MUST quedar a la vista y marcarse un instante. Hasta 860 px de ancho el pop-up MUST ocupar la pantalla completa, sin que la ✕ ni el pie queden fuera de lo que se ve.

#### Scenario: Abrir desde la foto

- GIVEN el feed con tarjetas
- WHEN se hace clic en la foto de una tarjeta
- THEN se abre el pop-up de ese posteo y el foco queda en el botón de cerrar

#### Scenario: Selección de texto que termina afuera

- GIVEN el pop-up abierto
- WHEN se arrastra para seleccionar texto y se suelta sobre el fondo oscuro
- THEN el pop-up sigue abierto

---

### Requirement: REQ-POP-02 — Contenido

El pop-up MUST mostrar: la cuenta y sus seguidores; el alcance con la métrica que lo disparó, o que no hay referencia; el tipo; el título; el texto completo con sus saltos de línea; likes y comentarios, cada uno con su valor, su × contra la mediana y la mediana de la cuenta; la fecha y hora de publicación; el motivo completo de la detección; "Ver perfil" y "Abrir en Instagram". Si el alcance es alto, la métrica que lo disparó MUST llevar la marca "dispara el alcance". Una métrica sin referencia MUST mostrar el mismo motivo que da la tabla. Todo dato del posteo MUST entrar como texto, nunca como HTML.

#### Scenario: Likes ocultos

- GIVEN un posteo con los likes ocultos por el autor y comentarios con referencia
- WHEN se abre el pop-up
- THEN likes muestra "—" y el motivo, sin ×; comentarios muestra su valor, su × y la mediana

---

### Requirement: REQ-POP-03 — Lado de la foto

Sin imagen, el lado izquierdo MUST mostrar un recuadro rayado con "Sin foto" y la etiqueta del tipo. `feedPopImageUrl(post)` MUST ser el único punto donde se decide la imagen. Con imagen, MUST verse entera, sin recortar; si no carga, MUST quedar el mismo recuadro con "Imagen no disponible".

---

### Requirement: REQ-POP-04 — Navegación

El pop-up MUST permitir pasar al posteo anterior y al siguiente de las tarjetas en pantalla, en su orden, con las flechas en pantalla y con ← →, y MUST mostrar la posición ("3 / 195"). Las flechas van a los costados de la ventana y, hasta 1240 px de ancho, en la cabecera. En los extremos la flecha que no corresponde MUST quedar deshabilitada. ← → MUST NOT actuar mientras el foco está en el selector de sentimiento. Si al pasar de posteo desaparece o se deshabilita el control que tenía el foco, el foco MUST pasar al botón de cerrar.

#### Scenario: Flechas con el foco en "Ignorar"

- GIVEN el pop-up abierto y el foco en "Ignorar"
- WHEN se aprieta → tres veces
- THEN el pop-up avanza tres posteos y el foco queda dentro de la ventana

---

### Requirement: REQ-POP-05 — Sentimiento

El selector de sentimiento del pop-up MUST usar las mismas funciones que la tabla y las tarjetas. La tarjeta de atrás MUST actualizarse y MUST NOT salir de la lista hasta que se vuelva a filtrar.

---

### Requirement: REQ-POP-06 — Ignorar

"Ignorar" MUST pedir confirmación dentro del pop-up. Esc con la confirmación abierta MUST cancelarla sin cerrar el pop-up. Al confirmar, el pop-up MUST pasar al posteo siguiente, o al anterior si era el último, y MUST cerrarse si no queda ninguno. Si el pedido falla, el pie MUST volver a su estado normal con el aviso "No se pudo ignorar".

#### Scenario: Falla el pedido

- GIVEN el pop-up en un posteo y el servidor que rechaza el pedido de ignorar
- WHEN se confirma "Sí, ignorar"
- THEN el pop-up sigue en ese posteo, la tarjeta sigue en la lista y el pie muestra "No se pudo ignorar"

---

### Requirement: REQ-POP-07 — La lista cambia con el pop-up abierto

Si la lista de tarjetas cambia y el posteo que muestra el pop-up ya no está, el pop-up MUST cerrarse.

---

### Requirement: REQ-POP-08 — La tabla y X no cambian

La vista Tabla y `x.html` MUST comportarse igual que antes. `public/js/monitoring.js` MUST NOT cambiar.

---

## REMOVED Requirements

### Requirement: REQ-FEED-09 — "Ver más" por fila visual (de `monitoreo-feed`)

Reason: lo reemplaza el pop-up. Las tarjetas ya no se abren en el lugar.
