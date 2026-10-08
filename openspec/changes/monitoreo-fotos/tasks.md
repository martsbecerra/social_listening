# Tasks: monitoreo-fotos

Un commit por paso en la rama `monitoreo_fotos`, por tandas aprobadas por el dueño. Ni Apify real ni descargas reales de Instagram en las pruebas.

## Phase 1: documentos

- [x] 1.1 `openspec/changes/monitoreo-fotos/` (proposal, design, tasks, spec)

## Phase 2: módulo de imágenes

- [x] 2.1 Dependencia `sharp` en `package.json` y `package-lock.json`
- [x] 2.2 `src/postImages.js`: descarga segura, dos copias JPEG de una sola descarga, escritura a temporal y renombre; nunca tira (REQ-FOTO-01, REQ-FOTO-02, REQ-FOTO-03)
- [x] 2.3 `test/postImages.test.js`, con `fetch` simulado e imágenes generadas

## Phase 3: base

- [x] 3.1 `src/db.js`: columnas `image_source_url`, `image_status`, `image_saved_at`, `image_width`, `image_height`, con guarda (REQ-FOTO-04)
- [x] 3.2 Funciones para anotar el resultado y leer el estado
- [x] 3.3 `test/postImagesMigration.test.js`: base vieja en un archivo temporal, segunda carga sin cambios, funciones nuevas
- [x] 3.4 Migración probada a mano sobre una copia de la base real, fuera del repo; el código de `main` sigue funcionando contra la copia migrada

## Phase 4: adapters

- [x] 4.1 `imageUrl` en el posteo normalizado de `instagramApify.js` (`displayUrl`) y de `instagramApidojo.js` (`image.url`); contrato en `platforms/index.js` (REQ-FOTO-05)

## Phase 5: enganche

- [x] 5.1 `src/monitor.js`: bajar la foto al guardar un posteo nuevo (REQ-FOTO-05)
- [x] 5.2 `src/metricsRefresh.js`: bajarla en el refresco por URL si el posteo no tiene copia (REQ-FOTO-05)
- [x] 5.3 `src/scheduler.js`: el aviso de ciclo trabado lista también las descargas
- [x] 5.4 `src/postImageSync.js`: el enganche en un módulo aparte (baja solo lo que falta, anota en la base, fase "Guardando fotos", una línea de resumen por ciclo); `src/concurrencyLimiter.js` con la opción `quiet`
- [x] 5.5 `test/postImagesCiclo.test.js`, con `POST_IMAGES=0` incluido

## Phase 6: servidor

- [x] 6.1 `server.js`: ruta de la imagen detrás del login y campos en el listado (REQ-FOTO-06)
- [x] 6.2 `src/postImageRoutes.js`: la ruta y la forma del listado fuera de `server.js`, para probarlas con el login real sin levantar la app; `test/postImagesRuta.test.js`

## Phase 7: frontend

- [x] 7.1 `feedImageUrl` y `feedPopImageUrl` leen `image.thumbUrl` e `image.fullUrl`; `feedImageFailed` decide entre "Sin foto" e "Imagen no disponible" (REQ-FOTO-07)
- [x] 7.2 Probado en el navegador con el servidor de prueba y fotos generadas (vertical, horizontal, cuadrada, portada de reel 9:16, rota, descarga fallida, link vencido, sin foto), en escritorio y en celular

## Phase 8: documentación final

- [x] 8.1 `.env.example` (`POST_IMAGES`), `README.md`, `CLAUDE.md`

## Phase 9: revisión independiente y arreglos

Tres revisores de solo lectura, en paralelo, sobre copias de la base: (a) descarga y ruta, (b) ciclo y base, (c) frontend. Los arreglos que eligió el dueño, uno por commit:

- [x] 9.1 El corte de la tanda actúa aunque haya una descarga colgada
- [x] 9.2 Cinco fallos seguidos cortan la tanda, sean de red o no (incluye que no se pudo anotar en la base). De paso: la tanda ya no tira con un posteo que no es un objeto ni con un aviso asincrónico que falla
- [x] 9.3 Tope de 2 minutos por tanda
- [x] 9.4 Solo JPEG, PNG y WebP, de hasta 12 megapíxeles
- [x] 9.5 La base se anota foto por foto
- [x] 9.6 Estado `pendiente`: la foto que no salió se reintenta al empezar el ciclo siguiente, con el link guardado y sin Apify
- [x] 9.7 Las fases de fotos no hacen bajar el porcentaje de progreso
- [x] 9.8 Foto de la tarjeta no arrastrable y texto alternativo en el pop-up
- [x] 9.9 El test de "nada fuera de la carpeta de fotos" ahora puede fallar
- [x] 9.10 Comentarios viejos de `styles.css` y "tres puntos" en el README
- [x] 9.11 Login salteable con `/API/` en mayúsculas: arreglado aparte, en la rama `fix_login_mayusculas` (ya estaba así en `main`). Tiene que estar en `main` antes o junto con este cambio: sin él la ruta de la foto no cumple REQ-FOTO-06

## Antes de la base real

- [ ] Backup de `data/monitoring.db` (hecho el 2026-10-07 en `data/backups/2026-10-07_pre-fotos/`, como copia de archivo; repetirlo justo antes de relanzar)
- [ ] El dueño relanza la app: ahí se migra la base real
- [ ] Mirar el primer ciclo real: la línea `[imagenes] fotos del ciclo` y, si aparece `host-no-permitido`, qué host fue. En la base no había links de imagen guardados para confirmar la lista de hosts antes
- [ ] Desde ese momento, sumar `data/media/` a los backups (se copia aparte de la base)

## Pendientes de la revisión independiente (sin arreglar, por decisión del dueño)

Backend:

- Con `REFRESH_MODE=perfil` el refresco no baja fotos: los posteos ya guardados sin foto no la reciben (solo posteos nuevos y reintentos de pendientes). Documentado en el README y en `.env.example`
- Un link vencido se vuelve a probar en cada refresco del posteo, con el link nuevo de esa respuesta, sin espaciar ni contar intentos (hasta unas 17 veces en 60 días si siempre falla). Lo mismo una foto pendiente, una vez por ciclo, mientras el fallo siga siendo pasajero
- Las dos copias no se reemplazan como una unidad: si la grande está abierta por otro programa al reintentar, puede quedar la miniatura nueva con la grande vieja
- Si el proceso muere entre escribir y renombrar, quedan archivos `*.tmp` en `data/media/` que nadie limpia
- Un archivo de 0 bytes (corte de luz después del renombre) no se detecta: se sirve vacío y no se vuelve a bajar
- La ruta de la imagen: un pedido con un rango imposible responde 404 con los encabezados de imagen y de caché de un año
- La caché del navegador (un año, `private`) sobrevive al cierre de sesión: las fotos ya vistas quedan en ese perfil del navegador
- Si se vuelve a `main` con la base ya migrada, el listado de `main` manda las columnas crudas, `image_source_url` incluida (el link firmado), a usuarios con sesión
- Cualquier script de esta rama que cargue `src/db.js` (por ejemplo `npm run costo`) migra la base real, antes del backup previsto. Es inofensivo: la migración es aditiva y el código de `main` sigue andando
- Una foto pendiente que se reintenta y además se refresca en el mismo ciclo se cuenta dos veces en la línea de resumen

Frontend:

- Mantener ← o → apretado en el pop-up pide una imagen grande por cada posteo salteado, sin cancelar las anteriores
- Una miniatura rota se vuelve a pedir en cada redibujo del feed (pasa por el recuadro de color antes de "Imagen no disponible")
- En celular la tarjeta ocupa todo el ancho y la miniatura de 360 px se ve estirada en pantallas de alta densidad
- Accesibilidad: el aviso "Imagen no disponible" no se anuncia a un lector de pantalla cuando aparece, y la etiqueta "Alcance bajo" tiene poco contraste sobre una foto clara

Tests:

- Los fixtures del actor oficial (`test/fixtures/apify/`) solo tienen reels: "carrusel = primera imagen" e "imagen = `displayUrl`" no están verificados contra una salida real
- En los fixtures de apidojo el link de la imagen y el del video son el mismo marcador: que nunca se devuelva el video lo cubren solo los casos armados a mano
- Sin test propio: el ciclo completo sin `sharp`, el aviso de ciclo trabado con fotos en vuelo

Aparte, en código anterior a este cambio: la conciliación del costo real (`reconcileRealCosts`) corre al cerrar cada ciclo aunque `APIFY_REAL_COST=0`. Son lecturas gratis a la API de Apify.

## Pendientes (fuera de este cambio)

- Los posteos de más de 60 días al llegar el cambio quedan sin foto: ya no se refrescan y no se pide nada extra
- Sin borrado automático de fotos: `data/media/` crece hasta unos 125 KB por posteo
- `image_width` e `image_height` se guardan y van en el listado, sin uso en el frontend (el lado de la foto del pop-up tiene tamaño fijo)
- La tarjeta recorta la miniatura a su recuadro (150 px de alto): de una foto vertical o de la portada de un reel se ve la franja del medio. Entera se ve en el pop-up. Cambiarlo es tocar `public/css/styles.css`, que en este cambio no se tocó
