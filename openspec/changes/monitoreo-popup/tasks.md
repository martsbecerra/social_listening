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
- [x] 3.3 Revisión independiente (un agente de solo lectura, sin abrir la base): ningún hallazgo grave, uno medio y cinco bajos, más dos bajos de la revisión propia del diff. Los ocho se reprodujeron en la página de prueba

## Phase 4: arreglos de la revisión (decididos por el dueño)

Un commit por arreglo, cada uno probado en la página de prueba.

- [x] 4.1 Hallazgo 1 (medio): después de elegir el sentimiento con el mouse, el foco sale del selector; así ← → no lo cambian otra vez (REQ-POP-05)
- [x] 4.2 Hallazgo 2: el segundo clic de un doble clic en la foto o en "Ver más" no actúa sobre el pop-up recién abierto (REQ-POP-01)
- [x] 4.3 Hallazgo 3: el segundo clic de un doble clic en "Cancelar" o en "Sí, ignorar" no cae en "Abrir en Instagram" (REQ-POP-06)
- [x] 4.4 Hallazgo 4: con el pedido de ignorar en camino, Esc cierra y no vuelve a armar el pie (REQ-POP-06)
- [x] 4.5 Hallazgo 5: al cerrar, la tarjeta queda a la vista también si la lista cambió por detrás (REQ-POP-01)

## Phase 5: posteo solo desde "Se despegaron" y fecha de las métricas (octubre 2026, rama `monitoreo_progreso_lista`)

Pedidos por el dueño. Probado en el navegador con el servidor de prueba y una copia de la base.

- [x] 5.1 `openFeedPopSolo(id)`: abre un posteo solo, buscándolo por su fila (`feedPopRow`), sin flechas ni contador (REQ-POP-09). `monitoring.js` lo llama desde el clic en un destacado (`openHighlight`); donde no hay pop-up, va a la fila como antes
- [x] 5.2 Sentimiento e ignorar sin tarjeta detrás: directo sobre la fila; al ignorar se cierra, y si falla queda abierto con el aviso (REQ-POP-09)
- [x] 5.3 Al cerrar, el foco vuelve al destacado y la página no se mueve; abierto después desde una tarjeta, vuelve a tener flechas y contador (REQ-POP-09)
- [x] 5.4 "Métricas al dd/mm/aaaa · hh:mm" debajo de las métricas, en naranja con más de 3 días (REQ-POP-10)
- [x] 5.5 Probado: vista Tabla y Feed, con el posteo a la vista y con un filtro que lo tapa; Esc, ← →, sentimiento, ignorar (cancelado, con fallo y bien); tarjeta común después

## Pendiente fuera de este cambio

- Imagen del posteo (cambio siguiente: fotos). Punto único: `feedPopImageUrl`.
- Hallazgo 6: celular apaisado o ventana angosta y baja (667 × 375): la foto, la cabecera y el pie se llevan casi todo y para el texto quedan unos 64 px de alto, con scroll. En vertical a 375 px está bien.
- Hallazgo 7: si se abre "Ver más" dentro de los 150 ms de espera del buscador y el posteo queda filtrado, el pop-up se cierra solo al redibujarse la lista.
- Hallazgo 8: con el pop-up abierto, si llegan datos nuevos (termina "Actualizar ahora") se actualizan el contador y las flechas, pero no los números del posteo abierto, hasta navegar.
- Resto del hallazgo 4: si se cierra el pop-up con el pedido de ignorar en camino y en ese lapso se abre el cartel de ignorar de otra tarjeta, `confirmIgnore` lo esconde al terminar. Es `monitoring.js`, que este cambio no toca.
- Aviso si falla el guardado del sentimiento: la pantalla queda con el valor no guardado y solo se anota en la consola. Ya pasaba en `main` con la tabla (hallazgo 7 de la revisión de `monitoreo-feed`) y vale igual para las tarjetas y para el pop-up, porque los tres usan `updateSentiment`.
- Barra superior en celular: en una pantalla de 375 px, el botón de usuario queda 35 px afuera del ancho. Ya pasaba en `main` y la barra es compartida por todas las páginas: no se toca en este cambio. Por eso el fondo del pop-up se mide con la pantalla que se ve y no en porcentaje.
