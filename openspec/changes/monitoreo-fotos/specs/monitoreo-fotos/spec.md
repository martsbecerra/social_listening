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

---

### Requirement: REQ-FOTO-04 — Base

`detected_posts` MUST sumar `image_source_url`, `image_status`, `image_saved_at`, `image_width` e `image_height`, todas anulables, con una migración aditiva y con guarda que no toca las filas existentes y que se puede correr más de una vez. `image_saved_at` MUST ser lo único que decide si hay foto: un intento fallido MUST cambiar `image_status` y el link, y MUST NOT tocar `image_saved_at` ni las medidas. Las funciones van por id y plataforma, sin default.

#### Scenario: Base anterior al cambio

- GIVEN una base sin las columnas `image_*` y con posteos guardados
- WHEN arranca la app
- THEN las columnas existen, los posteos conservan todos sus datos y las columnas nuevas están vacías

---

### Requirement: REQ-FOTO-05 — Cuándo se baja

La foto MUST bajarse al guardar un posteo nuevo y en el refresco por URL cuando el posteo no tiene copia y la respuesta trae link. Con copia guardada MUST NOT volver a bajarse. Si la respuesta no trae imagen MUST NOT hacerse ningún pedido extra. MUST NOT hacerse ningún pedido a Apify que no se hiciera antes. Una descarga fallida MUST NOT frenar el ciclo.

---

### Requirement: REQ-FOTO-06 — Detrás del login

Las imágenes MUST servirse solo con sesión iniciada, por id y plataforma, con un tamaño de lista cerrada. El archivo MUST armarse con datos de la base, nunca con texto del pedido. El link original de Instagram MUST NOT mandarse al navegador.

---

### Requirement: REQ-FOTO-07 — Feed y pop-up

La tarjeta MUST mostrar la miniatura con carga diferida y el pop-up la imagen grande, cuando existen. Sin foto, la tarjeta MUST mostrar el recuadro de reemplazo y el pop-up "Sin foto". "Imagen no disponible" queda para una imagen que falló.
