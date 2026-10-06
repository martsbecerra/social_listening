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
- [ ] 8.2 Revisión independiente de la rama (solo lectura) y decisión del dueño sobre cada hallazgo
- [ ] 8.3 PR a `main` (merge commit, sin squash), con OK del dueño

## Pendiente fuera de este cambio

- [ ] Imagen del posteo: guardarla o servirla desde el backend y devolverla en `feedImageUrl`
