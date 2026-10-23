# Spec: estadisticas

La solapa Estadísticas de Instagram del diseño v4 (`design/social-listening-v4.html`) y el endpoint que la alimenta. No cambia el ciclo, Apify, el LLM, la forma de `/api/monitoring/posts` ni la de `/api/analyze`; X no tiene la solapa.

---

## ADDED Requirements

### Requirement: REQ-EST-01 — Endpoint

`GET /api/monitoring/stats?plataforma=&desde=AAAA-MM-DD&hasta=AAAA-MM-DD` MUST devolver en una sola respuesta todos los bloques del período, con el mismo control de acceso que el resto de `/api/monitoring` (plataforma obligatoria). Sin fechas MUST valer los últimos 30 días hasta hoy. MUST responder 400 con un mensaje para la persona si viene una sola fecha, una fecha mal escrita, "desde" posterior a "hasta" o más de 366 días. MUST NOT escribir nada en la base.

#### Scenario: Una sola fecha

- GIVEN un pedido con `desde` y sin `hasta`
- WHEN llega al endpoint
- THEN responde 400 "Mandá "desde" y "hasta" juntas, o ninguna (últimos 30 días)."

---

### Requirement: REQ-EST-02 — Período y anterior

El período MUST resolverse en hora de Argentina y el anterior MUST tener el mismo largo, pegado antes. El período efectivo MUST arrancar en el primer día con datos de la plataforma y terminar hoy; si el anterior queda entero fuera de los datos, cada campo `*Anterior` del resumen y `temas[].anterior` MUST ir en null.

#### Scenario: Base nueva

- GIVEN la primera publicación guardada es del 29/7 y se piden 90 días hasta el 23/10
- WHEN se arma la respuesta
- THEN `periodo.desdeEfectivo` es el 29/7 y `relevantesAnterior` es null

---

### Requirement: REQ-EST-03 — Qué cuenta

MUST contar los posteos visibles (`ignored = 0`) por `posted_at`. Un posteo sin sentimiento MUST contar como neutral y uno sin tema como "Coyuntura / Otros" (la categoría de respaldo de `config/categorias-reclamos.json`).

---

### Requirement: REQ-EST-04 — Alcance

"Se despegó" MUST ser `top.level === 'alto'` con `accountStats.classifyPostAgainstBenchmark`, calculado al armar la respuesta como en el listado. Para el mismo período MUST dar el mismo número que el KPI del Monitoreo. Las razones de alcance MUST viajar sin redondear; ningún texto MUST decir "N veces lo habitual" con ellas. La razón de un pico (publicaciones del día / la mediana diaria) MAY decirlo.

---

### Requirement: REQ-EST-05 — Resumen, días y picos

`resumen` MUST traer relevantes, se despegaron, % negativo, % positivo y conversación (likes + comentarios), cada uno con su anterior, y 12 cubetas de tendencia (un porcentaje de una cubeta vacía, null). `porDia` MUST tener los días del período efectivo, con los que no tuvieron publicaciones en cero; `habitual` es su mediana; `picos`, hasta 3 días con el doble de lo habitual o más, con la publicación que lo explica. `porHora` MUST ser 7 × 24, lunes primero.

---

### Requirement: REQ-EST-06 — Palabras

`palabras` MUST traer las 60 más usadas en título y texto, contando posteos. Las frases de las palabras clave y búsquedas de la plataforma, y "Buenos Aires", MUST contar enteras; después, palabras de 3 letras o más que no sean palabras vacías; hashtags, menciones, links y números MUST NOT contar salvo que estén en la lista. Cada una MUST traer `n`, `positivas`, `negativas` e `ids` (los posteos contados).

#### Scenario: "Macri" dentro de "Jorge Macri"

- GIVEN "Jorge Macri" en las listas y un posteo que dice "Jorge Macri en la plaza"
- WHEN se cuentan las palabras
- THEN ese posteo está en los `ids` de "Jorge Macri" y no en los de "Macri"

---

### Requirement: REQ-EST-07 — Menciones por búsqueda

`menciones` MUST tener una fila por término de búsqueda con algo en el período (el de "Búsqueda: <término>" del motivo), con `detectadas` (relevantes + ignorados del período + descartados de `search_seen` por `first_seen_at`), `relevantes` y `positivas`. Lo que no llegó por una búsqueda MUST NOT entrar. `search_seen` MUST purgarse a los 100 días.

---

### Requirement: REQ-EST-08 — Tramos y temas

`semanas` MUST ser por día hasta 14 días y, si no, de 7 días contados hacia atrás desde "hasta" (el corto, primero). `temas` MUST traer por tema su cantidad, su tono, su cuenta por tramo, `anterior` (null sin datos del anterior) y `destacada` (la de mayor razón; a igual razón, la más nueva; null sin ninguna con referencia).

---

### Requirement: REQ-EST-09 — Cuentas y ranking

`cuentas` MUST traer por cuenta las publicaciones, el impacto (likes + comentarios), los seguidores (null sin dato), cuántas se despegaron, la mejor razón y el tono. `ranking` MUST traer las 10 de mayor razón con la métrica que decidió, su valor y la mediana usada.

---

### Requirement: REQ-EST-10 — Solapa y carga

Estadísticas MUST ser la cuarta solapa de `instagram.html` (tecla 4, `#tab-stats`) y el pie MUST enlazarla. MUST pedir los datos la primera vez que se abre y al cambiar el período (7 / 30 / 90 días hasta hoy o Desde → Hasta, recordado en `sl.stats.periodo`, con try/catch; sin nada, 30). Mientras llegan, lo anterior MUST quedar tenue; una respuesta de un período que ya no es el elegido MUST descartarse; un error MUST mostrar un aviso con "Reintentar". Si cambian los posteos de la tabla del Monitoreo (una corrida, ignorar, otro tono), MUST volver a pedirlos. Un Desde → Hasta mal escrito MUST avisarse sin pedir nada.

---

### Requirement: REQ-EST-11 — KPI

MUST haber cinco KPI (publicaciones relevantes, se despegaron, negativo, positivo, conversación) con las tarjetas de `kpi.js`: número que sube de 0, trazo de las 12 cubetas y la comparación con el anterior ("sin datos" si es null).

---

### Requirement: REQ-EST-12 — Nube

La nube MUST ubicar las palabras de dos publicaciones o más sin pisarse, con tamaño por cantidad y color por el tono que predomina; "Positivos reales" MUST ordenar y medir por las positivas. Cada palabra MUST ser un botón con su tooltip.

---

### Requirement: REQ-EST-13 — Menciones y dona

MUST mostrar por término las barras de detectadas, relevantes y positivas con sus porcentajes, y la dona con lo que se lleva cada búsqueda de las relevantes.

---

### Requirement: REQ-EST-14 — Temas

MUST mostrar los 9 temas con más publicaciones con su badge: ninguno si el anterior no tiene datos; Nuevo si antes tuvo 0 y ahora 3 o más; Pico si tiene 5 o más y al menos el doble que antes; En alza con más de +20 %; Baja con menos de −20 %; si no, Estable. MUST mostrar su tono, su evolución por tramo y la cita de la que más se despegó con "N,NN× en <métrica>".

---

### Requirement: REQ-EST-15 — Horas, tono neto, cuentas y ranking

MUST mostrar el mapa de día y hora, el tono neto por tramo (positivos − negativos sobre el total, sin punto en un tramo sin publicaciones), las 10 cuentas por impacto, publicaciones o seguidores, y las 6 que más se despegaron; una de esas MUST abrir el pop-up del posteo recorriendo las 6.

---

### Requirement: REQ-EST-16 — Del clic al Monitoreo

Un clic en una palabra o un tema MUST abrir el Monitoreo con el período de Estadísticas como rango temporal ("24/9 → 23/10", con una ✕ que vuelve a Hoy / 7 / 30; no se guarda), los demás filtros en blanco, y bajar a la lista. El rango MUST valer para los KPI (con el mismo anterior que Estadísticas), las fuentes, el flujo, "Se despegaron" y la lista. La palabra MUST filtrar por sus `ids` (y, desde "Positivos reales", también por tono positivo); el tema, con el filtro Tema, que al elegir "Coyuntura / Otros" MUST traer también los posteos sin tema. La lista MUST mostrar el mismo número que la tarjeta.

#### Scenario: La palabra "Macri"

- GIVEN la nube de 30 días con "Macri" en 33 publicaciones
- WHEN se hace clic en "Macri"
- THEN el Monitoreo muestra "24/9 → 23/10", la pastilla "palabra de la nube Macri" y "Mostrando 33 de 296"

---

### Requirement: REQ-EST-17 — Datos, movimiento y contraste

Todo dato MUST entrar por `textContent`; los gráficos MUST armarse con nodos (`createElementNS`). Con `prefers-reduced-motion: reduce` MUST NOT haber movimiento. El texto de los badges MUST pasar 4,5:1 en los dos temas, y `--muted` oscuro MUST pasar 4,5:1 sobre `--surface` y `--surface2`.
