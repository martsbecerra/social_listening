# Spec: monitoreo-fotos

Copia local de la foto de cada posteo de Instagram del Monitoreo, para el feed y el pop-up. Sin pedidos nuevos a Apify.

---

## ADDED Requirements

### Requirement: REQ-FOTO-01 — Descarga segura

La imagen MUST bajarse solo por `https`, solo de hosts terminados en `.cdninstagram.com` o `.fbcdn.net`, sin usuario, contraseña ni puerto en el link y sin seguir redirecciones. La respuesta MUST ser `image/*`. Cada descarga MUST tener un tope de tamaño (15 MB) y de tiempo (15 segundos). Una plataforma sin lista de hosts MUST NOT bajar nada. Los logs MUST NOT llevar el link firmado.

#### Scenario: Host que no es de Instagram

- GIVEN un link `https://ejemplo.com/foto.jpg`
- WHEN se pide guardar la imagen
- THEN no se hace ningún pedido de red y el resultado es `error`

#### Scenario: Host que solo se parece

- GIVEN un link a `https://cdninstagram.com.ejemplo.com/foto.jpg` o a `https://malcdninstagram.com/foto.jpg`
- WHEN se pide guardar la imagen
- THEN no se hace ningún pedido de red

#### Scenario: Redirección

- GIVEN un host permitido que responde 302
- WHEN se pide guardar la imagen
- THEN no se sigue la redirección y el resultado es `error`

---

### Requirement: REQ-FOTO-02 — Dos copias de una sola descarga

De una misma descarga MUST salir dos archivos JPEG: una miniatura de 360 px de ancho y una imagen de 900 px de lado largo, con el alto proporcional y la orientación de la foto respetada. Una imagen más chica MUST NOT agrandarse. Los archivos van en `data/media/<plataforma>/<id>_thumb.jpg` y `<id>_full.jpg`.

#### Scenario: Portada de un reel

- GIVEN una imagen de 1080 × 1920
- WHEN se guarda
- THEN la miniatura mide 360 × 640 y la grande 506 × 900, las dos en JPEG

#### Scenario: Imagen chica

- GIVEN una imagen de 200 × 200
- WHEN se guarda
- THEN las dos copias miden 200 × 200

---

### Requirement: REQ-FOTO-03 — Un fallo no rompe nada

El módulo MUST NOT tirar: todo fallo vuelve como resultado. `vencido` si el servidor respondió 403, 404 o 410; `error` en el resto. Un fallo MUST NOT modificar ni borrar copias ya guardadas, y MUST NOT dejar archivos a medias. Tras cinco fallos de red seguidos, la tanda MUST cortarse. Con `POST_IMAGES=0` MUST NOT bajarse nada.

#### Scenario: Falla con una copia ya guardada

- GIVEN un posteo con sus dos copias en disco
- WHEN un intento nuevo falla
- THEN los dos archivos quedan como estaban

#### Scenario: Interruptor apagado

- GIVEN `POST_IMAGES=0`
- WHEN corre un ciclo con posteos nuevos que traen link de imagen
- THEN no se hace ningún pedido de red, no se escribe ningún archivo, no cambia ninguna columna `image_*` y el ciclo termina como siempre
- AND las fotos ya guardadas se siguen sirviendo

#### Scenario: La red no llega al servidor de imágenes

- GIVEN una tanda en la que cinco descargas seguidas, en el orden de la lista, fallan por la red
- WHEN se procesa la tanda
- THEN las que siguen no se intentan ni se anotan como fallidas, y quedan para el próximo refresco de cada posteo

---

### Requirement: REQ-FOTO-04 — Base

`detected_posts` MUST sumar `image_source_url`, `image_status`, `image_saved_at`, `image_width` e `image_height`, todas anulables, con una migración aditiva y con guarda que no toca las filas existentes y que se puede correr más de una vez. `image_saved_at` MUST ser lo único que decide si hay foto: un intento fallido MUST cambiar `image_status` y el link, y MUST NOT tocar `image_saved_at` ni las medidas. Las funciones van por id y plataforma, sin default.

#### Scenario: Base anterior al cambio

- GIVEN una base sin las columnas `image_*` y con posteos guardados
- WHEN arranca la app
- THEN las columnas existen, los posteos conservan todos sus datos y las columnas nuevas están vacías

---

### Requirement: REQ-FOTO-05 — Cuándo se baja

La foto MUST bajarse al guardar un posteo nuevo y en el refresco por URL cuando el posteo no tiene copia y la respuesta trae link. Con copia guardada (marca en la base y archivos en disco) MUST NOT volver a bajarse. Un posteo ya guardado que vuelve a aparecer en la detección MUST NOT bajar nada: lo completa el refresco. Si la respuesta no trae imagen MUST NOT hacerse ningún pedido extra. MUST NOT hacerse ningún pedido a Apify que no se hiciera antes. Una descarga fallida MUST NOT frenar el ciclo. Los logs MUST llevar una línea de resumen por ciclo y un renglón por cada foto que falla, y MUST NOT llevar un renglón por cada foto que sale bien.

#### Scenario: Posteo guardado antes del cambio

- GIVEN un posteo guardado sin foto, de menos de 60 días
- WHEN le toca el refresco por URL y la respuesta trae link de imagen
- THEN se guardan sus dos copias y la base queda con `image_status` `ok` e `image_saved_at`

#### Scenario: La base dice que hay copia y los archivos no están

- GIVEN un posteo con `image_saved_at` y sin sus archivos en disco
- WHEN le toca el refresco por URL y la respuesta trae link
- THEN la foto se vuelve a bajar

---

### Requirement: REQ-FOTO-06 — Detrás del login

Las imágenes MUST servirse solo con sesión iniciada, por id y plataforma, con un tamaño de lista cerrada (`thumb` | `full`). El archivo MUST armarse con datos de la base, nunca con texto del pedido. El listado de posteos MUST mandar `image` con `thumbUrl`, `fullUrl`, `status`, `width` y `height` (las direcciones en null si no hay copia; `image` en null en una plataforma sin fotos). El link original de Instagram MUST NOT mandarse al navegador.

#### Scenario: Sin sesión

- GIVEN un pedido de la imagen de un posteo sin sesión iniciada
- WHEN llega al servidor
- THEN responde 401 y no manda el archivo

#### Scenario: Desde otra plataforma, o sin copia

- GIVEN un posteo de Instagram con foto
- WHEN se pide su imagen con `plataforma=x`, o se pide la de un posteo sin copia guardada
- THEN responde 404

---

### Requirement: REQ-FOTO-07 — Feed y pop-up

La tarjeta MUST mostrar la miniatura (`image.thumbUrl`) con carga diferida y el pop-up la imagen grande (`image.fullUrl`), cuando existen. Si nunca se intentó bajar la foto, la tarjeta MUST mostrar el recuadro de color con el ícono del tipo y el pop-up "Sin foto". Si la descarga falló (`image.status` `vencido` o `error`, sin copia) o la copia no carga, la tarjeta y el pop-up MUST mostrar "Imagen no disponible". El frontend MUST leer el dato solo en `feedImageUrl`, `feedPopImageUrl` y `feedImageFailed`.

#### Scenario: Descarga fallida

- GIVEN un posteo con `image.status` `error` y las direcciones en null
- WHEN se dibuja su tarjeta y se abre su pop-up
- THEN los dos dicen "Imagen no disponible" y no se hace ningún pedido de imagen

#### Scenario: La copia no carga

- GIVEN un posteo con direcciones de imagen cuyo archivo ya no está
- WHEN se dibuja su tarjeta
- THEN en lugar del ícono de imagen rota dice "Imagen no disponible"
