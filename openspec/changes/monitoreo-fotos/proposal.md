# Proposal: monitoreo-fotos

## Intent

Mostrar la foto de cada posteo en el feed y en el pop-up del Monitoreo de
Instagram. Los links de imagen de Instagram vencen a los pocos días, así
que no alcanza con guardar el link: por cada posteo se guarda el link
original y **dos copias locales en JPEG, hechas de una sola descarga**: una
miniatura para la tarjeta y una imagen más grande para el pop-up.

No se hace ningún pedido nuevo a Apify: el link sale de respuestas que ya se
piden (el detalle al detectar y el refresco de métricas por URL).

## Scope

### In Scope

- Módulo de imágenes: descarga segura, dos copias JPEG, escritura que no
  deja archivos a medias
- Columnas nuevas en `detected_posts` (aditivas, con guarda) y funciones
  para anotar el resultado
- El posteo normalizado de los adapters de Instagram suma el link de la
  imagen
- Bajar la foto al detectar un posteo nuevo y en el refresco por URL, que
  además completa los posteos ya guardados
- Ruta de la imagen detrás del login y direcciones en el listado
- Feed y pop-up: enchufar la miniatura y la imagen grande en los puntos ya
  previstos (`feedImageUrl`, `feedPopImageUrl`)
- Documentación (README, CLAUDE.md, `.env.example`, este SDD)

### Out of Scope

- Videos: de un reel se guarda la portada; de un carrusel, la primera imagen
- Cualquier pedido extra a Apify. Si una respuesta no trae imagen, el posteo
  queda sin foto
- Posteos de más de 60 días: ya no se refrescan, así que quedan sin foto
- Borrado automático de fotos viejas
- X: no tiene imágenes en este cambio

## Capabilities

### New Capabilities

- `monitoreo-fotos`: copia local de la foto de cada posteo de Instagram

### Modified Capabilities

- `monitoreo-feed` y `monitoreo-popup`: muestran la foto cuando existe

## Approach

Ocho pasos, un commit por paso (ver `tasks.md`):

1. Documentos del cambio.
2. `sharp` y `src/postImages.js`: el módulo, todavía sin que nadie lo llame.
3. Base: las columnas `image_*` y sus funciones.
4. Adapters: `imageUrl` en el posteo normalizado.
5. Enganche en la detección y en el refresco por URL.
6. Servidor: ruta de la imagen y campos en el listado.
7. Frontend: feed y pop-up.
8. Documentación final.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/postImages.js` | New | Descarga segura y las dos copias |
| `src/postImageSync.js` | New | Enganche con el ciclo y la base: baja lo que falta y anota el resultado |
| `src/postImageRoutes.js` | New | Ruta de la imagen y forma del listado |
| `package.json`, `package-lock.json` | Modified | Dependencia nueva: `sharp` |
| `src/db.js` | Modified | Cinco columnas `image_*` y sus funciones |
| `src/platforms/instagramApify.js`, `instagramApidojo.js`, `index.js` | Modified | `imageUrl` en el posteo normalizado |
| `src/monitor.js`, `src/metricsRefresh.js`, `src/scheduler.js` | Modified | Bajar la foto en la detección y en el refresco; resumen por ciclo |
| `src/concurrencyLimiter.js` | Modified | Opción `quiet` para el limitador de las fotos |
| `server.js` | Modified | Monta la ruta de la imagen y arma `image` en el listado |
| `public/js/monitoringFeed.js`, `monitoringFeedPopup.js` | Modified | Mostrar la foto |
| `data/media/` | New | Las copias (no se versiona: `data/` ya está ignorada) |
| `test/` | New | Todo con mocks: ni Apify ni descargas reales |
| `.env.example`, `README.md`, `CLAUDE.md` | Modified | `POST_IMAGES` y la documentación |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Bajar algo que no es una imagen de Instagram | Low | Solo `https`, solo hosts de Instagram / Facebook, sin redirecciones, solo `image/*`, tope de tamaño y de tiempo |
| Una descarga trabada frena el ciclo | Med | Tiempo máximo por imagen, pocas a la vez con limitador propio, corte de la tanda tras cinco fotos seguidas con fallo y tope de 2 minutos por tanda; el módulo nunca tira; lo que no sale queda pendiente para el ciclo siguiente |
| Pisar una copia buena con una descarga fallida | Low | Se escribe a un temporal y se renombra recién con las dos copias listas; un fallo no toca archivos ni la marca de "hay foto" |
| Migrar la base real antes de tiempo | Med | Columnas aditivas con guarda; se prueba sobre una copia fuera del repo; backup antes; la base real se migra cuando el dueño relanza la app |
| La carpeta de fotos crece | Med | Unos 125 KB por posteo; sin borrado automático en este cambio, queda anotado |
| `sharp` no instala en la PC del piloto | Low | Trae binario precompilado para Windows; no compila nada |

## Rollback Plan

`POST_IMAGES=0` en `.env` apaga las descargas sin tocar código. Las columnas
son aditivas y el código anterior funciona contra la base migrada: volver
atrás no requiere restaurar la base. La carpeta `data/media/` se puede
borrar sin efecto en el resto de la app.

## Dependencies

- `sharp` (redimensionar y pasar a JPEG): Node no trae nada para eso
- El detalle de posteos del actor oficial (`displayUrl`), que ya se pide

## Success Criteria

- [x] Dos copias JPEG por posteo, de una sola descarga: miniatura de 360 px
  de ancho e imagen de 900 px de lado largo
- [x] Ningún pedido nuevo a Apify
- [x] Una descarga fallida no pisa una copia ni frena el ciclo
- [x] Solo se baja de hosts de Instagram / Facebook, solo imágenes, con tope
  de tamaño y de tiempo
- [x] Migración aditiva, probada sobre una copia de la base
- [x] Las imágenes solo se ven con sesión iniciada
- [x] El feed y el pop-up muestran la foto cuando existe (probado en el
  navegador con el servidor de prueba y fotos generadas)
- [x] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify` (314 de 314,
  ya con los arreglos de la revisión independiente)

Todo se verificó con red simulada e imágenes generadas. Falta lo que solo
se puede ver con datos reales: el primer ciclo con la app relanzada (ver
"Antes de la base real" en `tasks.md`).
