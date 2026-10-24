# Spec: analisis

La solapa "Análisis de publicación" de Instagram del diseño v4 (`design/social-listening-v4.html`), el trabajo que la alimenta y "Análisis recientes" del inicio. No cambia el monitoreo, el análisis de X (salvo lo dicho en REQ-ANA-11 y REQ-ANA-16) ni el formato del informe institucional.

---

## ADDED Requirements

### Requirement: REQ-ANA-01 — Cada análisis se guarda

Cada análisis MUST quedar en la tabla `analisis` con su plataforma, el link normalizado a `/p/<code>/`, el estado (`en curso` | `ok` | `sin comentarios` | `error` | `interrumpido`), inicio y fin, quién lo corrió, los datos de la publicación, los números (traídos, únicos, enviados, analizados, por tono), el resultado del modelo, los temas, los comentarios con su tono, "Cuándo comentaron", el informe, el CSV, la cantidad de reclamos, el gasto y la foto. Las funciones MUST pedir la plataforma, sin default.

#### Scenario: Un análisis terminado

- GIVEN un análisis que terminó bien
- WHEN se pide `GET /api/analisis/:id?plataforma=instagram`
- THEN viene con todo lo de arriba, sin volver a llamar a Apify ni al modelo

---

### Requirement: REQ-ANA-02 — El análisis corre en el servidor

`POST /api/analyze` MUST responder 400 con un link que no sea de una publicación de Instagram y, si no, 202 con `{ id }` antes de llamar a Apify. El análisis MUST seguir aunque la pestaña se cierre. Con un análisis en curso del mismo link normalizado, MUST devolver ese mismo id sin arrancar otro.

#### Scenario: El mismo link dos veces

- GIVEN un análisis en curso de `/p/ABC/`
- WHEN llega otro `POST /api/analyze` con `/p/ABC/?igsh=x`
- THEN responde el mismo id y no hay una segunda corrida

---

### Requirement: REQ-ANA-03 — Progreso real

`GET /api/analyze/progress?id=` MUST devolver los pasos del análisis con su estado (`pendiente` | `en curso` | `ok` | `omitido` | `error`) y un detalle que sale del trabajo real: esperar turno en Apify (solo si hizo falta), traer la publicación, traer los comentarios, clasificar el tono ("N de M" por tanda), detectar los temas y armar la lectura, ubicar los reclamos y armar el informe. MUST NOT mostrar un número, un porcentaje o una frase que no venga del trabajo.

#### Scenario: Tres tandas

- GIVEN 287 comentarios a clasificar (tandas de 100, 100 y 87, que corren a la vez)
- WHEN termina la tanda de 87 antes que las otras
- THEN el paso del tono dice "87 de 287": suma los clasificados de las tandas ya terminadas, en el orden en que terminan

---

### Requirement: REQ-ANA-04 — Topes y número real

`COMMENTS_LIMIT` y `COMMENTS_ANALYSIS_LIMIT` MUST valer 300 por defecto y leerse del `.env`. La clasificación MUST ir en tandas de 100 comentarios por llamada. "Analizados" MUST ser la cantidad de comentarios que el modelo clasificó de verdad (un índice que no devolvió no cuenta) y la pantalla MUST decir "analizados N de M" con M el total de comentarios que informa Instagram. MUST NOT haber un número fijo de comentarios en la pantalla.

#### Scenario: Una tanda falla

- GIVEN 250 comentarios en tres tandas y la segunda falla
- WHEN termina el análisis
- THEN "analizados" es 150 y el análisis terminó bien

---

### Requirement: REQ-ANA-05 — Temas con conteo

La síntesis MUST devolver hasta 8 temas con los números de los comentarios de cada uno; el conteo MUST ser el de los números válidos de la muestra. Los temas editados (renombrar, quitar, agregar) MUST guardarse con el análisis y entrar en el informe.

---

### Requirement: REQ-ANA-06 — Tonos

La pantalla MUST mostrar las cantidades de positivos, neutrales y negativos de lo clasificado, con el ruido aparte. El informe MUST mantener su porcentaje ponderado por tipo de cuenta y la pantalla MUST rotularlo así.

---

### Requirement: REQ-ANA-07 — Cuándo comentaron

El bloque MUST aparecer solo si la publicación tiene fecha y al menos 10 de los comentarios traídos tienen fecha. MUST contar todos los traídos (no la muestra), desde la publicación hasta el último comentario, por hora hasta 48 h, de a 6 h hasta 7 días y por día después, con el pico marcado.

#### Scenario: Sin fechas

- GIVEN comentarios sin fecha
- WHEN se arma el análisis
- THEN `cuando` es null y la pantalla no muestra el bloque

---

### Requirement: REQ-ANA-08 — La foto

La foto MUST salir de la corrida de la publicación (ningún pedido nuevo a Apify), con las reglas de `src/postImages.js`. Si la publicación ya tiene foto en el Monitoreo MUST usarse esa. La ruta MUST armar el archivo con datos de la fila.

---

### Requirement: REQ-ANA-09 — "Ya analizado"

Con un link que ya tiene un análisis terminado, la pantalla MUST avisarlo con su fecha y ofrecer verlo o analizar de nuevo, antes de gastar.

---

### Requirement: REQ-ANA-10 — Precarga sin disparar

"Analizar comentarios" del pop-up del Monitoreo MUST llevar el link a la solapa sin analizar. Si a la vista había el análisis de otra publicación, MUST dejar de mostrarse.

---

### Requirement: REQ-ANA-11 — Los reclamos conservan su gestión

Re-analizar una publicación (Instagram o X) MUST conservar el estado de sus reclamos y, si la dirección detectada no cambió, su geocodificado. El importador de reclamos MUST seguir como antes.

---

### Requirement: REQ-ANA-12 — Recientes

La solapa MUST mostrar los análisis terminados más recientes y abrir cualquiera sin volver a gastar. El inicio MUST mostrar los 4 últimos en "Análisis recientes", con estado vacío; cada uno MUST abrir `instagram.html#analisis-<id>`.

---

### Requirement: REQ-ANA-13 — Compartir

"Texto para WhatsApp" MUST ser el informe institucional con los temas editados; si pasa los 4.000 caracteres MUST avisarlo. "Copiar" MUST copiar ese texto. "Descargar CSV" MUST estar deshabilitado sin reclamos y llevar la fecha de Argentina en el nombre.

---

### Requirement: REQ-ANA-14 — Interrumpidos

Al arrancar el servidor, un análisis que quedó "en curso" MUST pasar a "interrumpido". Solo el servidor MUST hacerlo (no la carga de `db.js`).

---

### Requirement: REQ-ANA-15 — Gasto atado

Cada llamada a Apify de un análisis MUST quedar en `apify_calls` con su `analisis_id`. La fila del análisis MUST guardar el usd de Apify y el del modelo.

---

### Requirement: REQ-ANA-16 — X

`x.html` MUST seguir con su pantalla. Enter con un análisis en curso MUST NOT disparar otro (en las dos solapas).

---

### Requirement: REQ-ANA-17 — La pantalla

La solapa MUST seguir la maqueta con los tokens del sistema visual y sus tintas, todo dato por `textContent`, sin librerías nuevas, y `prefers-reduced-motion` MUST apagar el movimiento. MUST verse bien a 1366 y 375 px y en oscuro.

---

### Requirement: REQ-ANA-18 — Fixture real

Un análisis real autorizado por el dueño MUST guardar los ítems crudos de Apify como fixture anonimizado (sin usuarios ni textos reales), y la suite MUST probar la normalización contra él.
