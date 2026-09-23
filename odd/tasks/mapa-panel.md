# mapa-panel

## Objetivo
El mapa de reclamos es una entrada del panel, al mismo nivel que las redes, y muestra los reclamos de todas.

## Problema
El mapa es una solapa dentro de Instagram y de X. `GET /api/reclamos` exige `plataforma=instagram|x`, así que cada solapa ve una sola red.

## Por qué
Se eligió la alternativa «Tarjeta en el panel»: una entrada propia debajo de las redes, que abre el mapa consolidado. Ahí se filtra por red y el detalle de cada punto dice de cuál viene cada reclamo.

## Alcance
- Tarjeta de ancho completo en `public/dashboard.html` que abre `public/mapa.html`.
- `mapa.html` reúne los reclamos de instagram, x, facebook y tiktok.
- Filtro de redes, con todas activas por defecto. Sin ninguna red activa, el mapa queda vacío.
- El detalle del punto nombra la red de cada reclamo y, si hay más de una, las lista juntas.
- El color del pin sigue siendo el de la categoría. El ranking de colores sale de toda la base, no de las redes filtradas.
- Se sacan las solapas de mapa de `instagram.html` y `x.html`. Los atajos y `#tab-claims-map` van a `mapa.html`.

## Fuera de alcance
- Monitoreo de Facebook o TikTok.
- Cambiar el geocoder, las categorías o el popup de estado.
- Abrir un cambio de OpenSpec. El requisito de `x-ig-style` que pide la solapa con `plataforma=x` queda reemplazado por este documento para la entrada del mapa.

## Restricciones
- TDD: off. No hay un switch de proyecto ni de sesión. El runner de chequeo es `npm test`.
- Entrega: `ask-on-risk`. Diff rastreado 201 inserciones y 168 borrados, más `public/mapa.html` y este documento. Pasa el umbral de ~400. La estrategia de cadena se pregunta antes del primer commit.
- Este perfil no commitea hasta que se pida. La identidad del commit queda pendiente.
- Este repo no está en el registro de backlogs: no hay NNN ni `openOdd`.

## Tareas
- [x] T01 La consulta acepta todas las redes o un subconjunto, y el conteo de categorías sigue siendo global.
- [x] T02 Tarjeta en el panel y página del mapa consolidado, con filtro de red y la red en el detalle del punto.
- [x] T03 Sacar las solapas de mapa por red y redirigir atajos y el hash viejo.

## Verificación
- `npm test`: 64 pass, 0 fail.
- El navegador abre el login (`http://localhost:3000/`). No pude recorrer el panel ni el mapa sin el magic link.

## Progreso
T01–T03 hechas. Commit pendiente.

## Siguiente
Reiniciar el servidor para que tome `server.js`, entrar y revisar la tarjeta y un punto. Después, si hace falta, el commit.

## Locator
odd/tasks/mapa-panel.md
