# Design: monitoreo-fotos

## Technical Approach

Un módulo nuevo, `src/postImages.js`, recibe el link de la imagen de un
posteo, la baja con reglas estrictas y deja dos archivos JPEG. No sabe nada
de Apify ni de la base: devuelve qué pasó y quien lo llama lo anota. La base
guarda el link, el estado del último intento y cuándo se guardaron las
copias. El servidor sirve los archivos detrás del login.

## Architecture Decisions

- **Archivos en disco, no BLOB.** `data/media/<plataforma>/<id>_thumb.jpg` y
  `<id>_full.jpg`. Son unos 125 KB por posteo: con BLOB la base pasaría de
  1,6 MB a decenas de MB y cada backup copiaría además todas las fotos. La
  base se respalda igual que hoy; la carpeta se copia aparte con una copia
  común, aun con la app corriendo, porque cada archivo se escribe a un
  temporal, se renombra y no cambia más. `data/` ya está ignorada por git.
- **`sharp` para redimensionar.** Node no trae nada para eso. Baja un
  binario precompilado y no compila; lee JPEG, PNG y WebP.
- **Dos tamaños, de la misma descarga.** Miniatura de 360 px de ancho (la
  tarjeta mide entre 250 y 300 px, y así cubre también Windows al 125 %) e
  imagen de 900 px de lado largo para el pop-up. Nunca se agranda una imagen
  chica. Siempre JPEG, respetando la orientación de la foto.
- **Reglas de la descarga.** Solo `https`; solo hosts terminados en
  `.cdninstagram.com` o `.fbcdn.net`; sin usuario, contraseña ni puerto en
  el link; sin seguir redirecciones; solo `image/*`; tope de 15 MB y de 15
  segundos por imagen; tres a la vez con limitador propio; la tanda se corta
  tras cinco fallos de red seguidos. En los logs va el host, nunca el link
  firmado.
- **Sin default de plataforma.** La lista de hosts permitidos va por
  plataforma; una plataforma sin lista no baja nada.
- **El módulo nunca tira.** Cualquier fallo vuelve como resultado
  (`vencido` si el servidor respondió 403, 404 o 410; `error` en el resto).
  Un fallo no toca los archivos que ya estaban.
- **Columnas en `detected_posts`**, todas anulables:
  - `image_source_url`: el link original del último intento.
  - `image_status`: `ok`, `vencido` o `error`; vacío si nunca vino imagen.
  - `image_saved_at`: cuándo se guardaron las copias. Es lo único que decide
    si hay foto; un intento fallido cambia el estado y no toca esto.
  - `image_width`, `image_height`: medidas de la original, para que el
    pop-up reserve el lugar.
- **Cuándo se baja.** Al guardar un posteo nuevo (el detalle que ya se pide
  trae el link) y en el refresco por URL, si el posteo no tiene copia y la
  respuesta trae link. Con copia guardada no se vuelve a bajar. Sin imagen
  en la respuesta no se hace nada.
- **Detrás del login.** `data/` no está dentro de `public/`, así que no se
  sirve sola. La ruta va bajo `/api/monitoring/`, que ya exige sesión. El
  archivo se arma con el id de la base y un tamaño de lista cerrada, nunca
  con texto del pedido.
- **Apagado.** `POST_IMAGES=0` no baja nada; lo ya guardado se sigue viendo.

## Decisiones del dueño

- Disco, `sharp`, miniatura de 360 px de ancho e imagen de 900 px de lado
  largo.
- `image_width` e `image_height` se guardan desde ahora.
- Los posteos de más de 60 días quedan sin foto: no se pide nada extra.
- Reel: la portada. Carrusel: la primera imagen. No se bajan videos.
- La base real no se toca hasta que el dueño relance la app: backup antes y
  migración probada sobre una copia fuera del repo.

## Verificación

Todos los tests usan `fetch` simulado e imágenes generadas en memoria: ni
Apify ni descargas reales de Instagram. La migración se prueba en la suite
sobre una base vieja armada en un archivo temporal y, a mano, sobre una
copia de la base real fuera del repo.
