# Spec: analisis-pro

El análisis de publicación de Instagram con postura, temas, hecho dominante, pedidos y figuras públicas (fase F del diseño v4). Este registro cubre la F1 (modelo, servidor y figuras); la pantalla va en la F2. X no cambia.

---

## ADDED Requirements

### Requirement: REQ-PRO-01 — Cada comentario, clasificado en cinco campos

Cada comentario clasificado MUST tener tono (positivo / neutral / negativo / ruido), postura hacia la gestión (favor / neutra / critica), tema (uno de la lista de la publicación, o ninguno), si habla del posteo y si pide o pregunta algo concreto. Lo que el modelo no devuelve MUST quedar sin clasificar, no completado. Instagram MUST NOT pedir ni guardar tipo de cuenta.

#### Scenario: Una tanda que omite un comentario

- GIVEN una tanda de 50 comentarios
- WHEN el modelo devuelve 48
- THEN los 2 que faltan quedan sin clasificar y no cuentan como analizados

#### Scenario: Una tanda cuya respuesta se corta por el tope de salida

- GIVEN una tanda cuya respuesta llega al tope de salida (el razonamiento del modelo también cuenta)
- WHEN el proveedor la devuelve cortada
- THEN no se reintenta igual: la tanda va en dos mitades, una después de la otra, y lo gastado en el intento cortado se suma al costo del análisis

---

### Requirement: REQ-PRO-02 — Los temas los define la primera tanda

La primera tanda MUST correr sola y definir la lista de temas de la publicación. Las siguientes MUST recibir esa lista y MAY agregar temas nuevos, que se unen por nombre (sin acentos ni mayúsculas).

#### Scenario: Dos tandas agregan el mismo tema

- GIVEN las tandas 2 y 3 corren a la vez y las dos agregan "Seguridad en el parque"
- WHEN terminan
- THEN la lista tiene ese tema una sola vez y los comentarios de las dos tandas cuentan en él

---

### Requirement: REQ-PRO-03 — El modelo no cuenta

Todo número del análisis (cantidades, proporciones, ponderados, horas, comparaciones) MUST calcularlo el servidor. La síntesis MUST recibir los números ya calculados y MUST NOT devolver cantidades.

---

### Requirement: REQ-PRO-04 — Tono, postura y desvío

El servidor MUST dar el tono en cantidades y proporción (base: clasificados sin el ruido), el ponderado por likes (peso likes + 1), el ruido y los sin clasificar aparte; la postura en cantidades y proporción; `on` (los que hablan del posteo sobre la base) y a qué temas se desvía el resto, por proporción.

---

### Requirement: REQ-PRO-05 — Hecho dominante

El análisis MUST mostrar un hecho dominante solo si la síntesis lo marcó sobre el tema principal de los comentarios que no hablan del posteo Y ese tema junta al menos el 20 % de los analizados. Con hecho: `share`, la proporción de los likes, los verificados entre ellos, los 3 comentarios con más likes, cuándo empezó y "qué conviene mirar". Sin hecho: el tema principal con su proporción y los 4 primeros temas.

#### Scenario: El modelo marca un hecho chico

- GIVEN la síntesis marca un hecho sobre un tema que junta el 12 % de los analizados
- WHEN se arma el análisis
- THEN no hay hecho dominante y va la versión calma

---

### Requirement: REQ-PRO-06 — Verificados y figuras públicas

Los verificados MUST salir de `owner.is_verified` de cada comentario. Todo el que comentó MUST cruzarse con `figuras_publicas` por usuario. El modelo MAY sugerir rol y alineación SOLO para verificados que no están en la tabla; la sugerencia MUST guardarse con `origen = sugerida` y MUST NOT pisar una fila `origen = equipo`. La alineación MUST quedar vacía salvo para legislador/a, funcionario/a, partido, junta comunal, periodista y medio.

#### Scenario: Una sugerencia para alguien del equipo

- GIVEN `@periodista1` está en la tabla con `origen = equipo` y rol periodista
- WHEN la síntesis lo sugiere como medio
- THEN la fila no cambia

---

### Requirement: REQ-PRO-07 — Pedidos, etiquetas, emojis y los que más pegaron

Los pedidos MUST venir agrupados por el modelo con los números de sus comentarios; la cantidad MUST ser la de números válidos y el ejemplo el de más likes. Las cuentas y hashtags etiquetados MUST salir del texto (no hay campo aparte). Los emojis MUST contarse con `\p{Extended_Pictographic}` y repartirse en apoyo y bronca con las listas fijas. Los que más pegaron: los 6 con más likes.

---

### Requirement: REQ-PRO-08 — El tiempo y la comparación con la cuenta

"Cuándo comentaron" MUST sumar la demora del primer comentario, cuándo se llegó al 50 %, el pico y los comentarios de las últimas 24 h antes del análisis. La comparación MUST promediar los análisis anteriores de la misma cuenta (sin otros de la misma publicación) en negativos, comentarios, verificados y hablan del posteo, con la serie de negativos de los últimos 12; con ninguno anterior, MUST decir que es el primero.

---

### Requirement: REQ-PRO-09 — El informe de 8 puntos y los CSV

El informe (Copiar y WhatsApp, el mismo texto) MUST tener los 8 puntos de la maqueta y los comentarios destacados, y reemplaza al institucional solo en Instagram. El CSV de comentarios MUST traer un renglón por comentario con tono, postura, tema, si habla del posteo, pedido, verificado, likes y fecha en hora de Argentina. El CSV de reclamos MUST seguir.

---

### Requirement: REQ-PRO-10 — Galería y forma completa

`GET /api/analisis` MUST aceptar búsqueda (`q`), filtro (`f` = all / ev / neg / ver) y orden (`ord` = recent / c / neg / ver) y devolver por análisis la foto local, cuenta, fecha, texto, tono, tema estrella, si hubo hecho, analizados, comentarios de Instagram, verificados y reclamos. `GET /api/analisis/:id` MUST devolver la forma completa.

---

### Requirement: REQ-PRO-11 — Los análisis anteriores siguen abriéndose

Un análisis v1 MUST abrirse con todo lo que se puede contar con sus comentarios; los bloques que necesitan campos v2 MUST venir marcados como no disponibles. La migración MUST completar las columnas nuevas de los v1.

---

### Requirement: REQ-PRO-12 — Temas editables

Renombrar un tema MUST unirlo a otro si el nombre coincide. "+ tema" MUST agregar uno a mano, sin conteo, que entra en el informe. Un tema del modelo MUST NOT poder borrarse (sus comentarios quedarían sin tema); uno a mano, sí.

---

### Requirement: REQ-PRO-13 — Pasos

Los pasos MUST ser: Esperar turno en Apify (si hace falta), Traer la publicación, Traer los comentarios, Clasificar tono, postura y temas (con "100 de 300"), Detectar verificados y figuras públicas, Ubicar reclamos y Armar el informe, con el porcentaje del avance.

---

### Requirement: REQ-PRO-14 — Fixture real

La corrida real autorizada MUST validar el schema nuevo y guardar, anonimizadas, la respuesta de Apify y la del modelo como fixtures, con su test.
