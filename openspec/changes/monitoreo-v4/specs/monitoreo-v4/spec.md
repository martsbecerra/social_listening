# Spec: monitoreo-v4

La solapa Monitoreo de Instagram del diseño v4 (`design/social-listening-v4.html`), con datos reales. No cambia el ciclo, Apify, el LLM, la forma de `/api/analyze` ni la de `/api/monitoring/posts`; X conserva su layout salvo el recuadro de progreso.

---

## ADDED Requirements

### Requirement: REQ-MV4-01 — Período

La cabecera MUST ofrecer Hoy, 7 días y 30 días; sin nada guardado MUST valer Hoy y la elección MUST quedar en `localStorage` (`sl.monitoreo.periodo`, con try/catch). El período MUST filtrar por `posted_at` en hora de Argentina (Hoy: desde las 00:00 de hoy; N días: desde las 00:00 de N − 1 días antes) los KPI, las fuentes, el flujo, "Se despegaron", la lista y su contador. Si el período no tiene ninguna publicación, la lista y el flujo MUST decir "Todavía no hay publicaciones de hoy · ver 7 días" (o el equivalente de 7 días) con un enlace que cambia al período siguiente.

#### Scenario: Mañana sin corridas

- GIVEN Hoy elegido y ninguna publicación de hoy
- WHEN se abre el Monitoreo
- THEN la lista dice "Todavía no hay publicaciones de hoy · ver 7 días" y el enlace pasa a 7 días

---

### Requirement: REQ-MV4-02 — KPI

MUST haber cuatro KPI del período, que suben de 0 (sin movimiento con `prefers-reduced-motion`): publicaciones, con sparkline de 12 tramos y la variación contra el período anterior del mismo largo; tono neto (positivos − negativos sobre los clasificados, en puntos) con anillo; "Se despegaron" (`top.level === 'alto'`) con "la mayor: N,NN× en <métrica>, de @cuenta"; conversación (likes + comentarios). Ningún texto MUST decir "N veces lo habitual" con la razón del alcance.

---

### Requirement: REQ-MV4-03 — Búsquedas, palabras clave y hashtags

Cada fuente MUST ser un chip con la cantidad de publicaciones del período que trajo (búsqueda: `matched_reason` "Búsqueda: <término>"; palabra o hashtag: escrita en el título o el texto, sin mayúsculas ni acentos) y una barrita con su tono. Un clic MUST filtrar la lista por esa fuente (otro clic, o la ✕ de la pastilla, lo saca); la ✕ del chip MUST pedir "¿Sacar «x»? Sí / No" en el mismo lugar antes de llamar al endpoint de siempre. El "+" del encabezado MUST abrir el campo de agregar (mismos endpoints). Palabras clave y hashtags MUST mostrar 8 y 6, con "Ver las N →" que despliega en la misma caja. Instagram MUST NOT tener los modales "Ver todas".

---

### Requirement: REQ-MV4-04 — Cuentas seguidas

MUST mostrar 4 cuentas (las de más publicaciones del período) con "Ver las N →", "+" para agregar y ✕ con la misma confirmación.

---

### Requirement: REQ-MV4-05 — Pulso del tono

MUST dibujar en SVG las publicaciones por hora del día (Argentina) de los últimos 7 días, apiladas por tono, con la línea del pico y un tooltip por hora con los números de esa hora.

---

### Requirement: REQ-MV4-06 — Flujo en vivo

MUST mostrar una línea por publicación del período, la última detectada arriba, con la foto chiquita, "@cuenta · título" con el término de su búsqueda resaltado, el punto del tono, el tema, el alcance y "hace N". MUST mostrar las que entran sin agrandar la tarjeta. Al terminar "Actualizar ahora" las nuevas MUST entrar arriba de a una con "ahora"; con el mouse encima MUST esperar. Un clic MUST abrir el pop-up recorriendo el flujo.

---

### Requirement: REQ-MV4-07 — Pipeline

`GET /api/monitoring/status?plataforma=` MUST sumar `lastRun: { finishedAt, durationSec, fetched, newCandidates, saved, highlighted, usd }` de la última corrida terminada de esa red (null si nunca corrió) y `model`. `monitoring_runs.new_candidates` MUST guardar los nuevos sin repetidos del ciclo (null en las corridas anteriores). El Pipeline MUST mostrar traídas, nuevas (con el modelo) y relevantes, "—" donde no hay dato, y "todavía no corrió" sin corridas.

#### Scenario: Corrida anterior a la columna

- GIVEN la última corrida sin `new_candidates`
- WHEN se abre el Monitoreo
- THEN "nuevas" dice "—" y traídas y relevantes muestran sus números

---

### Requirement: REQ-MV4-08 — Alertas

MUST evaluar, sobre las publicaciones de hoy: volumen ≥ 1,5 × la mediana diaria de los 30 días anteriores; la de mayor razón con alcance alto ("Se despegó @cuenta"); un tema con 2 o más negativas. Un clic MUST filtrar la lista (período Hoy) y bajar a ella. Sin ninguna: "Nada fuera de lo habitual hoy."

---

### Requirement: REQ-MV4-09 — Filtros de la lista

MUST haber ocho controles con nombre: Buscar, Tono (con Sin clasificar), Alcance, Tema (los de `temas` de `/api/monitoring/config`), Cuenta (desplegable propio con buscador y la cantidad del período por cuenta), Desde, Hasta y Orden (más recientes, mayor alcance, más likes, más comentarios). MUST valer para Feed y Tabla; en la Tabla, Orden MUST quedar deshabilitado con el aviso de que se ordena por encabezado. La línea MUST decir "Mostrando N de M publicaciones del período"; "Limpiar filtros" MUST verse solo con algún filtro, la fuente o el orden puestos, y MUST NOT tocar el período.

---

### Requirement: REQ-MV4-10 — Recuadro de progreso

MUST seguir dibujando las líneas de `/api/monitoring/progress`, con un punto por estado, cada línea del ancho de su texto (sin cortar el término). Al terminar bien MUST decir "✓ Corrida terminada · HH:MM · duración", sumar el resultado y ocultarse a los 9 s (no con el mouse o el foco encima). Si falla MUST quedar hasta "Ocultar". Vale para Instagram y X.

---

### Requirement: REQ-MV4-11 — Feed en filas completas

MUST mostrar 3 filas según las columnas reales; si hay más, la última celda MUST ser "+N · Ver 12 más" (otra tanda de filas). Otro filtro u orden MUST volver a 3 filas. Las tarjetas MUST conservar su estructura; con alcance alto MUST llevar "N,NN× se despegó" sobre la foto.

---

### Requirement: REQ-MV4-12 — "Se despegaron"

MUST mostrar hasta cuatro tiras del período con alcance alto, de mayor razón primero, con la razón grande y su métrica, el título, "@cuenta, hora, N <métrica> contra M", el selector de tono y el medidor. Sin ninguna: "Ninguna publicación del período se despegó de lo habitual de su cuenta."

---

### Requirement: REQ-MV4-13 — Pop-up

MUST abrirse sobre la lista de donde vino (el feed entero, el flujo o las tiras) con contador "N / M", flechas y ← →, y Esc para cerrar; los datos MUST salir de la fila del posteo, haya o no tarjeta. MUST tener alto fijo `min(720px, 92vh)` con la foto a todo lo alto, desplazar solo el texto (con degradé cuando sigue y con la rueda sobre la foto) y un pie fijo con el tono, "Ignorar", "Analizar comentarios" (cierra, abre Análisis con el link en el campo, sin analizar) y "Abrir en Instagram ↗". Ignorar MUST pasar al siguiente. En celular MUST apilarse.

---

### Requirement: REQ-MV4-14 — Medidor de alcance

El alcance MUST verse con el `.reach` de cinco barras: alto en el color de acento, latiendo, con la razón; medio en ámbar; bajo gris; "—" sin referencia; con el cálculo en el tooltip.
