# Spec: monitoreo-progreso-lista

Recuadro de progreso de "Actualizar ahora" en el Monitoreo: qué se está haciendo, la barra y las últimas líneas del ciclo. No cambia el ciclo, la base ni Apify.

---

## ADDED Requirements

### Requirement: REQ-PROG-01 — Cabecera y barra

Mientras corre un ciclo lanzado con "Actualizar ahora", el recuadro MUST mostrar arriba la fase en curso con su contador ("Clasificando relevancia · 3 de 11") y, debajo, la barra a todo el ancho con el porcentaje real. En la detección la cabecera MUST decir "Buscando posteos nuevos · N de T listas", con N las fuentes que ya terminaron, y MUST NOT nombrar una fuente sola (corren en paralelo). El texto de la cabecera MUST NOT cortarse: si no entra, sigue en el renglón de abajo.

#### Scenario: Búsquedas en paralelo

- GIVEN 8 búsquedas configuradas, 5 ya terminadas
- WHEN se consulta el progreso
- THEN la cabecera dice "Buscando posteos nuevos · 5 de 8 listas"

---

### Requirement: REQ-PROG-02 — Una línea por fuente

Cada fuente de la detección (búsqueda, cuenta, hashtag o keyword) MUST tener una línea: en curso mientras se consulta ("«término» · buscando…") y, al terminar, "«término» · X encontrados, Y nuevos", "· X encontrados, ninguno nuevo", "· sin resultados" o "· falló". X y Y MUST contar posteos distintos. Una fuente que falla MUST NOT frenar a las demás ni al ciclo. Armar el texto de una línea MUST NOT frenar el ciclo.

#### Scenario: Una búsqueda falla

- GIVEN cuatro búsquedas, una de las cuales tira un error
- WHEN termina la detección
- THEN hay tres líneas con su resultado y una "· falló", y el ciclo sigue

---

### Requirement: REQ-PROG-03 — Un resumen por fase

Cada fase distinta de la detección MUST dejar, al terminar, una línea de resumen escrita para una persona ("Relevancia · 4 relevantes, 7 descartados", "Métricas · 148 actualizadas, 2 sin respuesta", "Fotos · 11 guardadas, 1 no disponible", "Benchmark de cuentas · 3 cuentas"). Una fase sin resumen propio MUST dejar uno genérico con su contador. Una fase que falló entera MUST verse como fallida. Una fase sin trabajo MUST NOT dejar ninguna línea.

#### Scenario: Fase sin trabajo

- GIVEN un ciclo sin posteos nuevos que clasificar
- WHEN termina
- THEN no hay línea de "Relevancia"

---

### Requirement: REQ-PROG-04 — Las últimas líneas

El recuadro MUST mostrar como mucho 6 líneas: primero lo que terminó, en el orden en que terminó, y abajo lo que sigue en curso. Lo que está en curso MUST ocupar como mucho 3 líneas: si hay más, las dos primeras y "y N más · buscando…". El lugar que sobra MUST ser para lo último que terminó. Las líneas MUST llegar ya elegidas desde el backend; el frontend MUST NOT armarlas ni recortarlas, y MUST insertarlas como texto, nunca como HTML.

#### Scenario: Ocho en curso

- GIVEN ocho búsquedas recién lanzadas
- WHEN se consulta el progreso
- THEN hay tres líneas: las dos primeras búsquedas y "y 6 más · buscando…"

#### Scenario: Tres terminadas y cinco en curso

- GIVEN tres búsquedas terminadas y cinco en curso
- WHEN se consulta el progreso
- THEN hay seis líneas: las tres terminadas, las dos primeras en curso y "y 3 más · buscando…"

---

### Requirement: REQ-PROG-05 — "Nuevos", un solo significado

"Nuevo" MUST querer decir lo mismo en toda la pantalla: un posteo que no estaba guardado ni se había evaluado antes. El resultado del ciclo MUST incluir, por plataforma, cuántos posteos nuevos distintos encontró (`newCandidates`), contados antes de pedir el detalle. El resumen de relevancia MUST contar solo posteos nuevos.

#### Scenario: El mismo posteo por dos búsquedas

- GIVEN un posteo nuevo que devuelven dos búsquedas
- WHEN termina el ciclo
- THEN cuenta como nuevo en la línea de cada búsqueda y una sola vez en `newCandidates`

---

### Requirement: REQ-PROG-06 — El final queda a la vista

Al terminar bien, el recuadro MUST quedar visible con "✓ Listo: N relevantes guardados de M nuevos" (N los guardados, M los nuevos del ciclo), la barra llena y las últimas líneas, incluido el resumen de la última fase. Si falla, MUST quedar visible con "✕ Error: …", la barra donde llegó y las líneas que hubo. En los dos casos MUST haber un botón "Ocultar". Al lanzar otro ciclo el recuadro MUST empezar vacío: MUST NOT mostrar líneas del ciclo anterior.

#### Scenario: Sin nada nuevo

- GIVEN un ciclo que no encontró posteos nuevos
- WHEN termina
- THEN la cabecera dice "Listo: no hubo posteos nuevos"

#### Scenario: Segundo ciclo seguido

- GIVEN un ciclo terminado, con su final a la vista
- WHEN se aprieta "Actualizar ahora" otra vez
- THEN la lista arranca vacía y se va llenando con las líneas del ciclo nuevo
