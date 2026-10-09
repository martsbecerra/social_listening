# Spec: monitoreo-feed

Vista "Feed" (tarjetas) de la solapa Monitoreo en vivo de Instagram, sobre los mismos posteos y los mismos filtros que la tabla. Solo frontend; el backend, la base y X no cambian.

---

## ADDED Requirements

### Requirement: REQ-FEED-01 — Interruptor Tabla / Feed

La solapa Monitoreo en vivo de Instagram MUST tener un interruptor "Tabla / Feed" arriba de los resultados. "Tabla" MUST mostrar la vista de siempre. La última vista elegida MUST recordarse en `localStorage` (`sl.monitoreo.vista`) y usarse al volver a entrar. Si `localStorage` no está disponible o trae otro valor, la vista MUST ser la tabla y el interruptor MUST seguir funcionando.

#### Scenario: Volver a entrar

- GIVEN el usuario eligió "Feed" y recargó la página
- WHEN termina de cargar la solapa
- THEN se ve el feed y el interruptor marca "Feed"

#### Scenario: Almacenamiento bloqueado

- GIVEN un navegador que tira al leer o escribir `localStorage`
- WHEN el usuario elige "Feed"
- THEN se ve el feed, sin error; al recargar vuelve a la tabla

---

### Requirement: REQ-FEED-02 — Mismos posteos y mismos filtros

El feed MUST mostrar exactamente los posteos que muestra la tabla con los filtros de la barra: no pide nada nuevo al servidor y dibuja las filas que la tabla ya filtró (con `postMatchesFilters`), sin volver a filtrar por su cuenta. El contador "Mostrando N de M" MUST valer para las dos vistas y coincidir siempre con la cantidad de tarjetas. El feed MUST mostrar todas las tarjetas filtradas, sin paginar.

#### Scenario: Sentimiento corregido con el filtro puesto

- GIVEN el filtro "Negativo" y una tarjeta que se acaba de pasar a "Positivo"
- WHEN se cambia el orden, o se va a Tabla y se vuelve
- THEN la tarjeta sigue en el feed, la fila sigue en la tabla y el contador no cambia; al volver a filtrar sale de las dos vistas y el contador baja en uno

#### Scenario: Filtro combinado

- GIVEN sentimiento "Negativo", una fecha en "Desde" y "macri" en el buscador
- WHEN se cambia de Tabla a Feed
- THEN el feed tiene tantas tarjetas como dice el contador y son los mismos posteos

#### Scenario: Sin resultados

- GIVEN un filtro que no deja ningún posteo
- WHEN se mira el feed
- THEN aparece "No hay publicaciones con esos filtros."

#### Scenario: Sin posteos detectados

- GIVEN una base sin posteos de Instagram
- WHEN se mira el feed
- THEN aparece "Todavía no se detectó ningún posteo."

---

### Requirement: REQ-FEED-03 — Alcance del posteo

Cada posteo MUST tener a lo sumo una etiqueta de alcance (alto | medio | bajo), obtenida de los dos niveles que manda el backend en `benchmark.likes` y `benchmark.comments`, sin recalcular medianas ni cortes. Likes y comentarios pesan igual y MUST valer el mejor de los dos: "alto" si alguno da alto; "bajo" solo si los dos dan bajo; "medio" en el resto ("normal" del backend se muestra "medio"). Una métrica sin referencia MUST NOT contar: decide la otra. Si ninguna tiene referencia, el posteo MUST NOT llevar etiqueta. MUST guardarse qué métrica disparó la etiqueta y su razón contra la mediana; en un empate, comentarios.

#### Scenario: Likes ocultos

- GIVEN un posteo con likes sin dato y comentarios en nivel alto
- WHEN se calcula el alcance
- THEN es "alto", disparado por comentarios

#### Scenario: Uno alto y otro bajo

- GIVEN likes en nivel bajo y comentarios en nivel alto
- WHEN se calcula el alcance
- THEN es "alto"

#### Scenario: Sin referencia

- GIVEN una cuenta con menos de 5 posteos recientes (las dos métricas sin referencia)
- WHEN se calcula el alcance
- THEN el posteo no lleva etiqueta

---

### Requirement: REQ-FEED-04 — Filtro "Alcance" y fechas

La barra de filtros de Instagram MUST tener un selector "Alcance" (Alto, Medio, Bajo) que filtra las dos vistas con la etiqueta de REQ-FEED-03. Con un nivel elegido, un posteo sin etiqueta MUST NOT aparecer. "Limpiar" MUST dejarlo en blanco. Las fechas MUST llevar a la vista el texto "Desde" y "Hasta"; su filtro (inclusivo, por fecha de publicación) no cambia.

#### Scenario: Solo alcance alto

- GIVEN "Alcance" en "Alto" y el resto de los filtros en blanco
- WHEN se mira cualquiera de las dos vistas
- THEN solo quedan posteos con etiqueta "alto" y el contador lo refleja

#### Scenario: Limpiar

- GIVEN "Alcance" en "Bajo"
- WHEN se pulsa "Limpiar"
- THEN el selector vuelve a "Alcance", se ven todos los posteos y "Limpiar" queda apagado

---

### Requirement: REQ-FEED-05 — Contenido de la tarjeta

La tarjeta MUST seguir la maqueta `design/monitoreo-feed.html`: cabecera con la inicial y el nombre de la cuenta, seguidores y antigüedad; recuadro de imagen; título y texto (tres líneas); likes, comentarios y sentimiento; motivo corto de detección y enlace al posteo. Por ahora el recuadro MUST ser siempre el de reemplazo, con el ícono del tipo y las etiquetas de tipo y de alcance, y MUST quedar listo para mostrar una imagen cuando el posteo traiga ese dato (carga diferida y aviso si no carga). Un posteo sin tipo MUST llevar el ícono de imagen y ninguna etiqueta de tipo. Un valor sin dato (likes ocultos) MUST verse "—", nunca 0. El borde de arriba MUST llevar el color del sentimiento (neutral en ámbar; sin clasificar, gris).

Cambios de octubre de 2026 (rama `monitoreo_foto_proporcion`, Phase 10 de `tasks.md`), que valen por encima de la maqueta: la tarjeta MUST mostrar solo el título, sin el texto del posteo, que se lee entero en el pop-up; el recuadro de imagen MUST ser un cuadrado con la foto entera sobre fondo negro o, sin foto, rayado con su texto (ya no hay recuadro de reemplazo con ícono); likes y comentarios MUST ir en una franja propia y el sentimiento en el pie.

#### Scenario: Tarjeta sin el texto del posteo

- GIVEN un posteo con título y con texto
- WHEN se dibuja su tarjeta
- THEN se ve el título y no el texto; al abrir el pop-up, el texto está entero

#### Scenario: Likes ocultos

- GIVEN un posteo con likes null
- WHEN se dibuja su tarjeta
- THEN los likes se ven "—"

#### Scenario: Posteo sin tipo

- GIVEN un posteo con `post_type` null
- WHEN se dibuja su tarjeta
- THEN el recuadro lleva el ícono de imagen y no tiene etiqueta de tipo

---

### Requirement: REQ-FEED-06 — Orden del feed

En la vista Feed MUST verse un selector de orden: "Más recientes" (por defecto), "Mayor alcance" (la mayor de las dos razones contra la mediana) y "Más likes". Lo que no tiene dato MUST ir al final y, a igualdad, primero lo más reciente. El selector MUST NOT verse en la vista Tabla, que sigue ordenando por encabezado.

#### Scenario: Mayor alcance

- GIVEN el orden "Mayor alcance"
- WHEN se dibuja el feed
- THEN las tarjetas van de mayor a menor razón y las que no tienen etiqueta quedan al final

---

### Requirement: REQ-FEED-07 — Acciones de la tarjeta

La tarjeta MUST permitir corregir el sentimiento e ignorar el posteo con los mismos endpoints que la fila de la tabla (`PATCH /api/monitoring/posts/:id` y `POST /api/monitoring/posts/:id/ignore`, con `?plataforma=instagram`) y el mismo cartel de confirmación. Al confirmar "ignorar" MUST salir solo esa tarjeta, sin rehacer el resto. El cambio MUST verse también en la tabla y en "Se despegaron".

#### Scenario: Corregir sentimiento

- GIVEN una tarjeta "Neutral"
- WHEN se elige "Negativo" en su selector
- THEN se guarda en el servidor, el borde pasa a coral y la fila de la tabla queda "Negativo"

#### Scenario: Ignorar la última

- GIVEN un filtro que deja una sola tarjeta
- WHEN se la ignora y se confirma
- THEN queda "No hay publicaciones con esos filtros."

#### Scenario: Cancelar

- GIVEN el cartel de confirmación abierto
- WHEN se pulsa "Cancelar"
- THEN no cambia nada

---

### Requirement: REQ-FEED-08 — "Se despegaron" abre el pop-up del posteo

Desde octubre de 2026 (rama `monitoreo_progreso_lista`), un clic en un destacado de "Se despegaron" MUST abrir el pop-up de ese posteo, solo, según REQ-POP-09 de `monitoreo-popup`: igual con el feed o con la tabla como vista activa. MUST NOT tocar los filtros ni mover la página. Antes llevaba a la tarjeta (feed) o a la fila (tabla), y no hacía nada si un filtro tapaba el posteo; ese camino queda solo como respaldo donde no hay pop-up.

#### Scenario: Posteo tapado por un filtro

- GIVEN un filtro que no incluye al posteo destacado
- WHEN se hace clic en el destacado
- THEN se abre el pop-up de ese posteo y los filtros quedan como estaban

---

### Requirement: REQ-FEED-10 — Fecha de las métricas

La tarjeta MUST mostrar, chica y a la derecha de likes y comentarios, la fecha de esos números ("al 08/10", día y mes con dos dígitos), en el mismo renglón: MUST NOT sumarle alto a la tarjeta, tampoco en la más angosta (240 px) con números largos y la razón del alcance a la vista. La fecha MUST ser la del último refresco de likes y comentarios del posteo o, si nunca se refrescó, la de su detección. Con más de 3 días MUST verse en naranja. Al pasar el mouse MUST decir la fecha y la hora completas.

#### Scenario: Nunca refrescado

- GIVEN un posteo detectado ayer que todavía no pasó por ningún refresco
- WHEN se dibuja su tarjeta
- THEN la fecha de las métricas es la de ayer, sin naranja

#### Scenario: Métricas viejas

- GIVEN un posteo cuyo último refresco fue hace 7 días
- WHEN se dibuja su tarjeta
- THEN la fecha va en naranja

---

### Requirement: REQ-FEED-09 — "Ver más" por fila visual

"Ver más" MUST abrir a la vez todas las tarjetas de la misma fila visual y "Ver menos" MUST cerrarlas juntas. Abierta, la tarjeta MUST mostrar el texto completo con sus saltos de línea y los datos de la tabla desplegada: qué métrica disparó el alcance, la mediana de la cuenta y la razón de este posteo para likes y para comentarios (o, sin referencia, el mismo motivo que da la tabla), el motivo completo de detección, la fecha y hora de publicación y el enlace al perfil. Un redibujo (filtros, orden, cambio de vista, datos nuevos) MUST dejar las tarjetas cerradas. Si se ignora una tarjeta o cambia el ancho de la ventana, las filas abiertas MUST quedar enteras (ninguna fila con tarjetas abiertas y cerradas mezcladas).

#### Scenario: Cuatro columnas

- GIVEN un feed de cuatro columnas
- WHEN se pulsa "Ver más" en la segunda tarjeta de una fila
- THEN se abren las cuatro de esa fila y sus botones dicen "Ver menos"

#### Scenario: Una columna

- GIVEN un celular (una columna)
- WHEN se pulsa "Ver más"
- THEN se abre solo esa tarjeta

#### Scenario: Ignorar con la fila abierta

- GIVEN una fila abierta
- WHEN se ignora una de sus tarjetas
- THEN la fila sigue abierta y completa con la tarjeta que ocupó el lugar

#### Scenario: Ignorar la última, sola en su fila

- GIVEN 9 tarjetas en 4 columnas y la novena abierta
- WHEN se la ignora
- THEN no queda ninguna tarjeta abierta

---

### Requirement: REQ-FEED-10 — Los datos de Instagram nunca van como HTML

Todo dato del posteo (título, texto, cuenta, motivo) MUST insertarse como texto. Como HTML MUST insertarse solo contenido propio y constante (íconos).

#### Scenario: Texto con etiquetas

- GIVEN un posteo cuyo texto contiene `<img src=x onerror=alert(1)>`
- WHEN se dibuja su tarjeta
- THEN se lee ese texto tal cual y no se crea ningún elemento

---

### Requirement: REQ-FEED-11 — Cientos de tarjetas sin trabar

Con unas 470 tarjetas, escribir en el buscador MUST seguir siendo fluido: el feed MUST redibujarse una sola vez después de una pausa corta y no en cada tecla, y en la vista Tabla MUST NOT armarse ninguna tarjeta.

#### Scenario: Escribir en el buscador

- GIVEN el feed con 470 tarjetas
- WHEN se escriben cinco letras seguidas
- THEN el feed se redibuja una vez, al terminar

---

### Requirement: REQ-FEED-13 — Los resultados nuevos se muestran desde el principio

Si al cambiar un filtro o el orden el principio del feed quedó arriba de la barra de filtros, la página MUST volver al principio del feed. Lo mismo MUST pasar con los resultados de la vista nueva al elegir Tabla o Feed en el interruptor. Si el principio ya está a la vista, la página MUST NOT moverse. Tampoco MUST moverse cuando llegan datos nuevos con los mismos filtros y el mismo orden, al ignorar un posteo ni al corregir un sentimiento.

#### Scenario: Ordenar desde abajo

- GIVEN el feed con 470 tarjetas y la página bajada hasta la fila 40
- WHEN se elige "Mayor alcance"
- THEN se ve la primera fila del orden nuevo, debajo de la barra

#### Scenario: Datos nuevos

- GIVEN la página bajada y ningún cambio de filtros ni de orden
- WHEN termina "Actualizar ahora" y el feed se redibuja
- THEN la página se queda donde estaba

---

### Requirement: REQ-FEED-12 — X no cambia

`public/x.html` MUST NOT cambiar ni cargar el feed. Lo que se toque en `public/js/monitoring.js`, que comparten las dos redes, MUST dar en X el mismo resultado que antes: el filtro, los contadores, "Limpiar" y los formateadores de la razón y de la fecha, con cualquier entrada. Un control que exista solo en `instagram.html` MUST tratarse como ausente en X.

#### Scenario: Filtro en X

- GIVEN la solapa Monitoreo de X
- WHEN se aplica cualquier combinación de sentimiento, cuenta, fechas y buscador
- THEN quedan los mismos posteos que antes del cambio
