# Tasks: monitoreo-feed

Un commit por paso en la rama `monitoreo_feed`, cada uno aprobado por el dueño antes de seguir.

## Phase 0: maqueta

- [x] 0.1 `design/monitoreo-feed.html` aprobada por el dueño y sumada al repo
- [x] 0.2 Decisiones cerradas con el dueño sobre lo que la maqueta no resuelve (ver `design.md`)

## Phase 1: filtro compartido y alcance (sin cambio visible)

- [x] 1.1 `readFilterValues` y `postMatchesFilters` en `public/js/monitoring.js`; la tabla filtra con ellas (REQ-FEED-02)
- [x] 1.2 `postReach` con la regla del dueño (REQ-FEED-03)
- [x] 1.3 Comparación contra el filtro anterior con los posteos reales y tabla de verdad de `postReach`

## Phase 2: estilos

- [x] 2.1 Sección "vista Feed" en `public/css/styles.css`, calcada de la maqueta con los tokens de `:root` y el prefijo `feed-`

## Phase 3: interruptor y tarjetas

- [x] 3.1 Interruptor "Tabla / Feed", selector de orden y contenedor del feed en `public/instagram.html` (REQ-FEED-01, REQ-FEED-06)
- [x] 3.2 `public/js/monitoringFeed.js`: tarjetas con los posteos reales, orden, estados vacíos, memoria de la vista (REQ-FEED-01, REQ-FEED-05, REQ-FEED-06, REQ-FEED-10)
- [x] 3.3 Rendimiento: `content-visibility`, redibujo con espera, formateadores armados una vez (REQ-FEED-11)
- [x] 3.4 Ancho mínimo de tarjeta 240 px; buscador, contador y "Limpiar" agrupados al final de la barra
- [x] 3.5 Formateador de la razón idéntico al anterior también con valores que no son números (REQ-FEED-12)

## Phase 4: acciones

- [x] 4.1 Corregir sentimiento e ignorar desde la tarjeta, con los endpoints y el cartel de la tabla (REQ-FEED-07)
- [x] 4.2 `notifyMonitoringViews(change)`: `{ ignoredId }` y `{ goToId }`; "Se despegaron" lleva a la tarjeta (REQ-FEED-08)

## Phase 5: "Ver más"

- [x] 5.1 Botón "Ver más" / "Ver menos" por fila visual; detalle armado al abrir (REQ-FEED-09)
- [x] 5.2 Filas abiertas rearmadas al ignorar y al cambiar el ancho de la ventana; al cerrar, la tarjeta vuelve a quedar a la vista

## Phase 6: filtro Alcance y fechas

- [x] 6.1 Selector "Alcance" en `public/instagram.html` y en el predicado compartido; "Limpiar" lo borra (REQ-FEED-04)
- [x] 6.2 "Desde" / "Hasta" con su texto a la vista (REQ-FEED-04)
- [x] 6.3 Comparación contra el commit anterior: 1.260 combinaciones de filtros sin diferencias con Alcance en blanco, en Instagram y en X

## Phase 7: documentación

- [x] 7.1 `README.md`, `CLAUDE.md`
- [x] 7.2 Este SDD (`proposal.md`, `design.md`, `tasks.md`, spec REQ-FEED-*)

## Phase 8: cierre

- [x] 8.1 Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify` en cada paso
- [x] 8.2 Revisión independiente de la rama (solo lectura): ningún hallazgo grave, uno medio y seis bajos; el dueño decidió sobre cada uno (Phase 9)
- [ ] 8.3 PR a `main` (merge commit, sin squash), con OK del dueño

## Phase 9: arreglos tras la revisión independiente

- [x] 9.1 Hallazgo 1: al filtrar, ordenar o cambiar de vista con la página bajada, los resultados se muestran desde el principio (REQ-FEED-13)
- [x] 9.2 Hallazgo 2: el feed dibuja las filas que la tabla ya filtró; feed, tabla y contador muestran siempre lo mismo (REQ-FEED-02)
- [x] 9.3 Hallazgo 3: ignorar la última tarjeta, abierta y sola en su fila, ya no abre la fila de arriba (REQ-FEED-09)
- [x] 9.4 Hallazgo 4, solo el borde: "hace 1 h" y "hace 1 día" en vez de "hace 60 min" y "hace 24 h". Queda como estaba que el texto no se actualiza solo con la página abierta
- [x] 9.5 Hallazgos 5 (un motivo viejo "palabra clave … — sin clasificar" se ve mal en el pie; hoy no hay ningún caso en la base) y 6 (la razón redondeada puede decir "1,5×" al lado de "Alcance medio"; 3 tarjetas hoy, y el mismo redondeo ya está en la tabla): el dueño decidió dejarlos como están

## Phase 10: ajustes de la tarjeta (octubre 2026, rama `monitoreo_foto_proporcion`)

Pedidos por el dueño con las fotos reales ya a la vista. Un commit por punto; probado en el navegador con el servidor de prueba y fotos de varias proporciones (9:16, 4:5, 1:1, 1,91:1, rota, fallida y sin foto), en escritorio y en celular.

- [x] 10.1 Foto sin recorte: el recuadro es un cuadrado del ancho de la tarjeta, con fondo negro, y la miniatura va entera y centrada. Sin foto, el mismo cuadrado rayado con "Sin foto" o "Imagen no disponible"; salen el recuadro de color y el ícono del tipo
- [x] 10.2 Toda la tarjeta abre el pop-up, con un clic o con Enter / Espacio (foco visible); sale el botón "Ver más". No lo abren la ✕ de ignorar, el selector de sentimiento, "Abrir ↗" ni soltar el mouse después de marcar texto. Al cerrar el pop-up, el foco vuelve a la tarjeta
- [x] 10.3 Likes y comentarios en una franja propia, con ícono y el número en 21 px y negrita; la razón del alcance, chica al lado del número que la disparó. El selector de sentimiento pasa al pie, que queda en dos renglones (motivo arriba; selector y "Abrir ↗" abajo): entra en la tarjeta de 240 px y en celular
- [x] 10.4 Hover más marcado: la tarjeta sube 6 px con sombra fuerte y borde del color del sentimiento, la foto se acerca a 1,05 dentro de su cuadrado y el cursor es la manito. Solo con mouse; el movimiento se apaga con `prefers-reduced-motion`
- [x] 10.5 `README.md`, `CLAUDE.md`, REQ-POP-01 de `monitoreo-popup` y los pendientes de `monitoreo-fotos`
- [x] 10.6 La tarjeta muestra solo el título, sin el texto del posteo (que sigue entero en el pop-up); el cuerpo queda con el mismo aire arriba y abajo. Con los 473 posteos reales, 431 títulos ocupan dos renglones, 30 tres y 12 uno. Probado con las fotos reales de `data/media`, leídas en solo lectura por el servidor de prueba
- [x] 10.7 Likes y comentarios un 17 % más chicos: número e ícono pasan de 21 px a 17,5 px, siempre en negrita. Con las fotos reales a la vista, 21 px quedaba exagerado

La maqueta `design/monitoreo-feed.html` no se actualizó: muestra la tarjeta anterior (foto en franja de 150 px, botón "Ver más").

## Pendiente fuera de este cambio

- [ ] Imagen del posteo: guardarla o servirla desde el backend y devolverla en `feedImageUrl`
- [ ] Hallazgo 7 de la revisión: si falla el guardado del sentimiento (el PATCH), la pantalla queda con el valor no guardado hasta recargar (la pastilla, el borde de la tarjeta, la fila y "Se despegaron"). `updateSentiment` en `public/js/monitoring.js` solo lo anota en la consola. Ya estaba en `main` para la tabla y el feed hace lo mismo: se trata aparte de esta rama, para las dos vistas
