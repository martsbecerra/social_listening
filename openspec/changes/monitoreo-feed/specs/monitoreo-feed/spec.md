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

El feed MUST mostrar exactamente los posteos que mostraría la tabla con los filtros de la barra: no pide nada nuevo al servidor y usa la misma condición (`postMatchesFilters`). El contador "Mostrando N de M" MUST valer para las dos vistas. El feed MUST mostrar todas las tarjetas filtradas, sin paginar.

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

### Requirement: REQ-FEED-08 — "Se despegaron" lleva a la tarjeta

Con el feed como vista activa, un clic en un destacado de "Se despegaron" MUST llevar a la tarjeta de ese posteo, dejarla debajo de la barra de filtros y marcarla un momento. MUST NOT tocar los filtros: si el posteo está tapado por uno, no hace nada. MUST NOT abrir la tarjeta. Con la tabla como vista activa, el comportamiento MUST ser el de siempre.

#### Scenario: Posteo tapado por un filtro

- GIVEN un filtro que no incluye al posteo destacado
- WHEN se hace clic en el destacado
- THEN la página no se mueve

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

### Requirement: REQ-FEED-12 — X no cambia

`public/x.html` MUST NOT cambiar ni cargar el feed. Lo que se toque en `public/js/monitoring.js`, que comparten las dos redes, MUST dar en X el mismo resultado que antes: el filtro, los contadores, "Limpiar" y los formateadores de la razón y de la fecha, con cualquier entrada. Un control que exista solo en `instagram.html` MUST tratarse como ausente en X.

#### Scenario: Filtro en X

- GIVEN la solapa Monitoreo de X
- WHEN se aplica cualquier combinación de sentimiento, cuenta, fechas y buscador
- THEN quedan los mismos posteos que antes del cambio
