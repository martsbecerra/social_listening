# Tasks: monitoreo-popup

Por tandas en la rama `monitoreo_popup`, cada una con `npm test` (los dos actores), prueba en la página de prueba y resumen al dueño.

## Phase 0: maqueta

- [x] 0.1 `design/monitoreo-popup.html` aprobada por el dueño y sumada al repo
- [x] 0.2 Decisiones cerradas con el dueño sobre lo que la maqueta no resuelve (ver `design.md`)

## Phase 1: pop-up que abre, muestra y cierra

- [ ] 1.1 Esqueleto del pop-up en `public/instagram.html` y estilos `feed-pop-*` en `public/css/styles.css` (REQ-POP-01)
- [ ] 1.2 `public/js/monitoringFeedPopup.js`: contenido completo del posteo y lado de la foto (REQ-POP-02, REQ-POP-03)
- [ ] 1.3 Abrir con "Ver más" y con la foto; cerrar con ✕, Esc y clic afuera; foco, sin scroll de fondo y pantalla completa en celular (REQ-POP-01)
- [ ] 1.4 Sacar la fila desplegada de `public/js/monitoringFeed.js` y sus estilos; aviso de cambios en la lista (REQ-POP-07)

## Phase 2: navegación y acciones

- [ ] 2.1 Anterior y siguiente: flechas en pantalla, ← → y contador (REQ-POP-04)
- [ ] 2.2 Sentimiento dentro del pop-up (REQ-POP-05)
- [ ] 2.3 Ignorar con la confirmación adentro (REQ-POP-06)

## Phase 3: documentación y repaso

- [ ] 3.1 Frase de "Ver más" corregida en `CLAUDE.md` y `README.md`, sin agregar texto
- [ ] 3.2 Repaso completo en la página de prueba; `x.html` y la tabla sin cambios (REQ-POP-08)

## Pendiente fuera de este cambio

- Imagen del posteo (cambio siguiente: fotos). Punto único: `feedPopImageUrl`.
