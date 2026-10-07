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

## Phase 6: servidor

- [ ] 6.1 `server.js`: ruta de la imagen detrás del login y campos en el listado (REQ-FOTO-06)

## Phase 7: frontend

- [ ] 7.1 `feedImageUrl` y `feedPopImageUrl` leen las direcciones nuevas (REQ-FOTO-07)

## Phase 8: documentación final

- [ ] 8.1 `.env.example` (`POST_IMAGES`), `README.md`, `CLAUDE.md`

## Antes de la base real

- [ ] Backup de `data/monitoring.db` (hecho el 2026-10-07 en `data/backups/2026-10-07_pre-fotos/`, como copia de archivo; repetirlo justo antes de relanzar)
- [ ] El dueño relanza la app: ahí se migra la base real
