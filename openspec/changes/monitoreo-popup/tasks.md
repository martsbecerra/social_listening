# Tasks: monitoreo-popup

Por tandas en la rama `monitoreo_popup`, cada una con `npm test` (los dos actores), prueba en la página de prueba y resumen al dueño.

## Phase 0: maqueta

- [x] 0.1 `design/monitoreo-popup.html` aprobada por el dueño y sumada al repo
- [x] 0.2 Decisiones cerradas con el dueño sobre lo que la maqueta no resuelve (ver `design.md`)

## Phase 1: pop-up que abre, muestra y cierra

- [x] 1.1 Esqueleto del pop-up en `public/instagram.html` y estilos `feed-pop-*` en `public/css/styles.css` (REQ-POP-01)
- [x] 1.2 `public/js/monitoringFeedPopup.js`: contenido completo del posteo y lado de la foto (REQ-POP-02, REQ-POP-03)
- [x] 1.3 Abrir con "Ver más" y con la foto; cerrar con ✕, Esc y clic afuera; foco, sin scroll de fondo y pantalla completa en celular (REQ-POP-01)
- [x] 1.4 Sacar la fila desplegada de `public/js/monitoringFeed.js` y sus estilos; aviso de cambios en la lista (REQ-POP-07)

## Phase 2: navegación y acciones

- [x] 2.1 Anterior y siguiente: flechas en pantalla, ← → y contador (REQ-POP-04)
- [x] 2.2 Sentimiento dentro del pop-up (REQ-POP-05)
- [x] 2.3 Ignorar con la confirmación adentro (REQ-POP-06)

## Phase 3: documentación y revisión

- [x] 3.1 Documentos del cambio al día y sección del feed en `CLAUDE.md` y `README.md`
- [x] 3.2 `npm test` con los dos actores y repaso del diff contra `main`; `x.html` y `monitoring.js` sin diferencias (REQ-POP-08)
- [x] 3.3 Revisión independiente (un agente de solo lectura, sin abrir la base). Los hallazgos esperan la decisión del dueño: no se arregla nada sin su visto bueno

## Pendiente fuera de este cambio

- Imagen del posteo (cambio siguiente: fotos). Punto único: `feedPopImageUrl`.
- Aviso si falla el guardado del sentimiento: la pantalla queda con el valor no guardado y solo se anota en la consola. Ya pasaba en `main` con la tabla (hallazgo 7 de la revisión de `monitoreo-feed`) y vale igual para las tarjetas y para el pop-up, porque los tres usan `updateSentiment`.
- Barra superior en celular: en una pantalla de 375 px, el botón de usuario queda 35 px afuera del ancho. Ya pasaba en `main` y la barra es compartida por todas las páginas: no se toca en este cambio. Por eso el fondo del pop-up se mide con la pantalla que se ve y no en porcentaje.
