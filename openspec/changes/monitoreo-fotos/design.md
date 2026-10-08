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
  - `image_width`, `image_height`: medidas de la original (ver "Lo que
    cambió al implementar": por ahora el frontend no las usa).
- **Cuándo se baja.** Al guardar un posteo nuevo (el detalle que ya se pide
  trae el link) y en el refresco por URL, si el posteo no tiene copia y la
  respuesta trae link. Con copia guardada no se vuelve a bajar. Sin imagen
  en la respuesta no se hace nada.
- **Detrás del login.** `data/` no está dentro de `public/`, así que no se
  sirve sola. La ruta va bajo `/api/monitoring/`, que ya exige sesión. El
  archivo se arma con el id de la base y un tamaño de lista cerrada, nunca
  con texto del pedido.
- **Apagado.** `POST_IMAGES=0` no baja nada; lo ya guardado se sigue viendo.

## Lo que cambió al implementar

- **Un módulo para el enganche: `src/postImageSync.js`.** El diseño decía
  "quien lo llama lo anota". La detección y el refresco hacen lo mismo
  (filtrar lo que falta, bajar, anotar, contar), así que eso quedó en un
  solo lugar: `syncPostImages(plataforma, items)`. Nunca tira.
- **"Tiene copia" es la marca de la base y los archivos en disco.** Si se
  restauró la base sin la carpeta `data/media`, la foto se vuelve a bajar en
  el próximo refresco del posteo.
- **Solo los posteos nuevos bajan en la detección.** Un posteo ya guardado
  que la búsqueda vuelve a traer no baja nada: lo completa el refresco por
  URL. El refresco saltea las cuentas que el benchmark acaba de recalcular
  en ese ciclo, así que sus fotos llegan en un ciclo posterior.
- **El corte por red se cuenta en el orden de la lista**, no en el orden en
  que terminan las descargas: un éxito lento no tapa cinco fallos rápidos.
- **Logs callados.** El limitador de las fotos no escribe un renglón por
  descarga (`quiet` en `createLimiter`). Queda una línea de resumen por
  ciclo (`[imagenes] fotos del ciclo: ...`, solo si hubo posteos con link) y
  un renglón por cada foto que falla.
- **Progreso.** Mientras se bajan, "Actualizar ahora" muestra la fase
  "Guardando fotos"; sin fotos por bajar, la fase no se anuncia.
- **La ruta y la forma del listado, en `src/postImageRoutes.js`.**
  `server.js` no se puede cargar en un test sin levantar la app; el módulo
  se prueba con el control de login real. El listado manda
  `image: { thumbUrl, fullUrl, status, width, height }` y no las columnas
  crudas. La dirección lleva `v=<image_saved_at>` y la respuesta se puede
  guardar en el navegador (`private, immutable`): si la foto se vuelve a
  bajar, cambia la dirección.
- **Resguardos de la miniatura y de la entrada.** La miniatura tiene además
  un alto máximo de 720 px (un reel da 360 × 640; solo entra en juego con
  una imagen altísima, que queda más angosta). Una imagen de más de 50
  megapíxeles se rechaza.
- **Sin `sharp`, la app arranca igual**: avisa en el log y no baja fotos.
- **`MONITORING_MEDIA_DIR`**, solo para los tests: la carpeta de las copias.
- **`image_width` e `image_height` quedaron sin uso en el frontend.** El
  lado de la foto del pop-up tiene tamaño fijo y la imagen se acomoda
  adentro: no hace falta reservar el lugar.

## Decisiones del dueño

- Disco, `sharp`, miniatura de 360 px de ancho e imagen de 900 px de lado
  largo.
- `image_width` e `image_height` se guardan desde ahora, aunque el frontend
  todavía no los use.
- Los posteos de más de 60 días quedan sin foto: no se pide nada extra.
- Reel: la portada. Carrusel: la primera imagen. No se bajan videos.
- La base real no se toca hasta que el dueño relance la app: backup antes y
  migración probada sobre una copia fuera del repo.
- Logs: una línea de resumen por ciclo y detalle solo si algo falla.
- Sin intento de descarga: recuadro de color en la tarjeta y "Sin foto" en
  el pop-up. Descarga fallida o copia que no carga: "Imagen no disponible"
  en la tarjeta y en el pop-up.
- `public/css/styles.css` no se toca en este cambio sin aviso previo.

## Verificación

Todos los tests usan `fetch` simulado e imágenes generadas en memoria: ni
Apify ni descargas reales de Instagram. La migración se prueba en la suite
sobre una base vieja armada en un archivo temporal y, a mano, sobre una
copia de la base real fuera del repo.

El frontend no está en la suite: se probó en el navegador con el servidor
de prueba (otro puerto, copia de los datos, sin scheduler ni Apify) y fotos
dibujadas para la prueba, pasadas por `src/postImages.js` con la red
simulada: vertical 4:5, horizontal 1,91:1, cuadrada, portada de reel 9:16,
una con el archivo faltante, una con la descarga fallida, una con el link
vencido y una sin foto, en escritorio y en celular.
