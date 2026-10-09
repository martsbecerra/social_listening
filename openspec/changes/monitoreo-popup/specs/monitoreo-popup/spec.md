# Spec: monitoreo-popup

Pop-up "Ver más" del feed del Monitoreo de Instagram. Solo frontend; el backend, la base, la tabla y X no cambian.

---

## ADDED Requirements

### Requirement: REQ-POP-01 — Abrir y cerrar

Un clic en cualquier parte de una tarjeta MUST abrir el pop-up de ese posteo, y también Enter o Espacio con el foco en la tarjeta, que MUST poder recibirlo con Tab y mostrarlo (desde octubre de 2026, rama `monitoreo_foto_proporcion`; antes lo abrían el botón "Ver más", que ya no existe, y un clic en la foto). Un clic en un control de la tarjeta (la ✕ de ignorar, el selector de sentimiento, "Abrir ↗") MUST NOT abrirlo, ni soltar el mouse después de marcar texto de la tarjeta. El pop-up MUST cerrarse con la ✕, con Esc y con un clic en el fondo oscuro. Mientras está abierto, la página de atrás MUST NOT desplazarse ni recibir foco. Al abrir, el foco MUST ir al botón de cerrar; al cerrar, MUST volver a la tarjeta del último posteo visto. Si se navegó a otro posteo que el de partida, esa tarjeta MUST quedar a la vista y marcarse un instante. Si la lista cambió mientras estaba abierto y la tarjeta no quedó entera a la vista, también MUST traerse a la vista; sin navegar y con la lista igual, la página MUST NOT moverse. Hasta 860 px de ancho el pop-up MUST ocupar la pantalla completa, sin que la ✕ ni el pie queden fuera de lo que se ve. El segundo clic de un doble clic MUST NOT actuar sobre algo que no estaba bajo el puntero en el primero (el pop-up recién abierto, el pie recién rehecho).

#### Scenario: Doble clic en la foto

- GIVEN una tarjeta de la primera columna
- WHEN se hace doble clic en su foto
- THEN el pop-up queda abierto en ese posteo

#### Scenario: Abrir desde la tarjeta

- GIVEN el feed con tarjetas
- WHEN se hace clic en la foto, el título o cualquier otra parte de una tarjeta que no sea un control
- THEN se abre el pop-up de ese posteo y el foco queda en el botón de cerrar

#### Scenario: Abrir con el teclado

- GIVEN el foco en una tarjeta
- WHEN se aprieta Enter o Espacio
- THEN se abre el pop-up de ese posteo, la página no se desplaza y, al cerrarlo con Esc, el foco vuelve a esa tarjeta

#### Scenario: Clic en un control de la tarjeta

- GIVEN el feed con tarjetas
- WHEN se hace clic en el selector de sentimiento, en la ✕ de ignorar o en "Abrir ↗"
- THEN el control hace lo suyo y el pop-up no se abre

#### Scenario: Marcar texto de la tarjeta

- GIVEN el feed con tarjetas
- WHEN se arrastra el mouse sobre el texto de una tarjeta para marcarlo y se suelta
- THEN el texto queda marcado y el pop-up no se abre

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

El selector de sentimiento del pop-up MUST usar las mismas funciones que la tabla y las tarjetas. La tarjeta de atrás MUST actualizarse y MUST NOT salir de la lista hasta que se vuelva a filtrar. Después de elegir un valor con el mouse, el foco MUST salir del selector (pasa al botón de cerrar); manejado con el teclado, el foco MUST quedarse en el selector.

#### Scenario: Flecha después de corregir con el mouse

- GIVEN el pop-up abierto en un posteo
- WHEN se elige "Positivo" con el mouse y se aprieta →
- THEN el pop-up pasa al posteo siguiente y el anterior queda guardado como "Positivo"

---

### Requirement: REQ-POP-06 — Ignorar

"Ignorar" MUST pedir confirmación dentro del pop-up. Esc con la confirmación abierta MUST cancelarla sin cerrar el pop-up. Una vez confirmado, con el pedido en camino, Esc MUST cerrar el pop-up y MUST NOT volver a armar el pie. Al confirmar, el pop-up MUST pasar al posteo siguiente, o al anterior si era el último, y MUST cerrarse si no queda ninguno. Si el pedido falla, el pie MUST volver a su estado normal con el aviso "No se pudo ignorar".

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
