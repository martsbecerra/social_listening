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

## Antes de la base real

- [ ] Backup de `data/monitoring.db` (hecho el 2026-10-07 en `data/backups/2026-10-07_pre-fotos/`, como copia de archivo; repetirlo justo antes de relanzar)
- [ ] El dueño relanza la app: ahí se migra la base real
- [ ] Mirar el primer ciclo real: la línea `[imagenes] fotos del ciclo` y, si aparece `host-no-permitido`, qué host fue. En la base no había links de imagen guardados para confirmar la lista de hosts antes
- [ ] Desde ese momento, sumar `data/media/` a los backups (se copia aparte de la base)

## Pendientes (fuera de este cambio)

- Los posteos de más de 60 días al llegar el cambio quedan sin foto: ya no se refrescan y no se pide nada extra
- Sin borrado automático de fotos: `data/media/` crece hasta unos 125 KB por posteo
- `image_width` e `image_height` se guardan y van en el listado, sin uso en el frontend (el lado de la foto del pop-up tiene tamaño fijo)
- La tarjeta recorta la miniatura a su recuadro (150 px de alto): de una foto vertical o de la portada de un reel se ve la franja del medio. Entera se ve en el pop-up. Cambiarlo es tocar `public/css/styles.css`, que en este cambio no se tocó
