# Spec: ventana-por-fuente

Detección por fuente que no pierde corridas de Apify ni publicaciones: marca de detección por búsqueda, corridas que se levantan después, descartados anotados con su búsqueda, tope que pide más y corridas incompletas a la vista.

---

## ADDED Requirements

### Requirement: REQ-VPF-01 — Lo que decidió el clasificador queda anotado con su búsqueda

Todo resultado de búsqueda (`sourceType 'search'`) evaluado por el clasificador MUST quedar en `search_seen` con su decisión (`guardado` | `descartado`), se haya pagado o no su detalle, con todos los términos que lo trajeron (`terminos`, el primero es `term`), el motivo del modelo, el costo estimado de la clasificación, la corrida y la fecha de publicación. Un resultado sin texto no evaluado MUST NOT anotarse. Las plataformas que no buscan por `searches` MUST NOT escribir en la tabla. Anotar otra vez un resultado MUST sumar términos y MUST NOT pisar `first_seen_at`, `term` ni un dato guardado con uno ausente.

#### Scenario: Descartado con texto, sin detalle pagado

- GIVEN una búsqueda que devuelve un posteo con caption que no habla de la Ciudad
- WHEN corre el ciclo
- THEN el posteo no se guarda y queda en `search_seen` como `descartado`, con su término, el motivo y el costo

#### Scenario: Dos búsquedas traen el mismo posteo

- GIVEN "macri" y "gobierno porteño" devuelven el mismo posteo
- WHEN corre el ciclo
- THEN se clasifica una sola vez y `terminos` tiene los dos, con "macri" primero

---

### Requirement: REQ-VPF-02 — Lo ya decidido no se vuelve a clasificar

Un posteo que al empezar el ciclo ya está en `search_seen` MUST NOT volver a pasar por el clasificador ni contar como nuevo; si otra búsqueda lo trae, MUST sumarse ese término.

#### Scenario: La corrida siguiente

- GIVEN un posteo descartado en la corrida anterior
- WHEN una búsqueda lo vuelve a traer
- THEN no hay llamada al modelo y la corrida informa 0 nuevos por ese posteo

---

### Requirement: REQ-VPF-03 — Costo de una búsqueda

El costo estimado de una búsqueda de apidojo MUST ser la tarifa de la consulta más la tarifa por posteo desde el primero, salvo que `APIDOJO_INCLUDED_SEARCH` diga otra cosa. `apify_calls` MUST guardar el tope pedido (`max_items`) y el `until` de cada consulta.

#### Scenario: Búsqueda con 50 resultados

- GIVEN las tarifas por defecto
- WHEN se registra una búsqueda con 50 resultados
- THEN el estimado es 0,015 + 50 × 0,0005 = 0,04

---

### Requirement: REQ-VPF-04 — El id del run nunca se pierde

En el flujo asincrónico, la fila de `apify_calls` MUST existir con el `apify_run_id` apenas Apify devuelve el run. Un fallo pasajero del seguimiento (5xx, 408, 429, red, tiempo de esa lectura) MUST reintentarse sin dar la llamada por caída. Al vencer el plazo, el error MUST llevar el id del run y decir que sigue pendiente, y el run MUST NOT abortarse. Un run que Apify cortó MUST entregar lo que dejó. El arranque del run MUST NOT reintentarse salvo por el 402 de runs simultáneos.

#### Scenario: 502 en el seguimiento

- GIVEN un run en curso y un `GET` de seguimiento que responde 502
- WHEN se reintenta y el run termina `SUCCEEDED`
- THEN la llamada devuelve sus resultados y deja una sola fila, ok

#### Scenario: Vence el plazo

- GIVEN un run que sigue `RUNNING` al vencer el plazo
- WHEN la llamada corta
- THEN la fila queda con `apify_run_id`, error `TIMEOUT` y estado `esperando` (si alguien lo va a levantar) o `error`

---

### Requirement: REQ-VPF-05 — Una fila por consulta de detección

Cada consulta de detección de un ciclo MUST dejar una fila en `monitoring_run_sources` con su tipo, su fuente, su estado, su motivo si falló, su ventana, su tope, lo que trajo y el run de Apify si lo hubo. Las funciones que la leen o escriben MUST exigir la plataforma. El texto crudo del error MUST NOT salir por la API.

#### Scenario: Seis de ocho caídas

- GIVEN un ciclo con seis búsquedas que fallan y dos que responden
- WHEN termina
- THEN hay ocho filas, seis en `fallo` con su motivo y dos en `ok`

---

### Requirement: REQ-VPF-06 — Estado de la corrida

El estado de una corrida para una red MUST calcularse al leer: `en curso` o `interrumpida`, si no `cortada` (cuota), si no `incompleta`, si no `ok`. MUST ser `incompleta` si alguna fuente quedó en fallo, esperando, parcial, recuperada o perdida, si no se buscó nada, si un tope se llenó sin cubrirse, si el techo de la ventana dejó un hueco o si el ciclo tiró. Las fallas del benchmark, el refresco o las fotos MUST NOT marcarla. Una corrida anterior a la tabla, sin filas, MUST dar `ok`.

#### Scenario: Corrida con una búsqueda esperando

- GIVEN una corrida terminada con una búsqueda que sigue en Apify
- WHEN se pide su estado
- THEN es `incompleta` y la lista de fallidas la nombra

---

### Requirement: REQ-VPF-07 — Espera de las búsquedas

Las búsquedas de un ciclo MUST compartir un vencimiento (`SEARCH_WAIT_MS` desde el inicio de la detección de la red). Lo que no terminó al vencer MUST quedar `esperando` con su run; lo que no llegó a lanzarse MUST quedar en `fallo` sin run. La detección MUST NOT durar más que esa espera por más búsquedas que haya.

#### Scenario: Búsqueda de 11 minutos

- GIVEN `SEARCH_WAIT_MS` de 15 minutos y una búsqueda que tarda 11
- WHEN corre el ciclo
- THEN sus resultados entran en ese mismo ciclo

---

### Requirement: REQ-VPF-08 — Las corridas pendientes se levantan

Al empezar la detección de una red, cada corrida `esperando` MUST releerse: terminada, sus posteos MUST pasar por la misma tubería que cualquier candidato (sin duplicar ni volver a clasificar lo ya decidido) y la fila MUST pasar a `recuperada`; si sigue corriendo, ese término MUST saltearse en este ciclo; con un 404 MUST quedar `perdida`; si Apify la cortó MUST entrar lo que dejó (`parcial`). Los posteos se filtran por la ventana con la que se lanzó la corrida, nunca por la hora de la recuperación.

#### Scenario: Recuperada en el ciclo siguiente

- GIVEN una búsqueda que quedó esperando y terminó bien en Apify
- WHEN arranca el ciclo siguiente
- THEN sus posteos se evalúan, la fila queda `recuperada` y la búsqueda de este ciclo arranca desde el lanzamiento de aquella

---

### Requirement: REQ-VPF-09 — Marca de detección por fuente

Cada fuente MUST tener su marca. La ventana de una fuente MUST ir desde su marca (o `MONITOR_LOOKBACK` si no tiene), nunca menos que `MONITOR_MIN_WINDOW` ni más que `MONITOR_LOOKBACK_MAX`. La marca MUST avanzar solo si la fuente respondió y sus posteos se procesaron; MUST NOT avanzar si falló o quedó esperando. La marca de la red MUST escribirse solo si todas las fuentes avanzaron.

#### Scenario: Una búsqueda falla dos corridas seguidas

- GIVEN "macri" falla el lunes y el martes y las demás responden
- WHEN corre el miércoles
- THEN "macri" pide desde su última detección exitosa (3 días) y las demás, 1 día

#### Scenario: Caída larga

- GIVEN una fuente cuya marca tiene 45 días
- WHEN corre el ciclo
- THEN pide `MONITOR_LOOKBACK_MAX` (30 días) y la fila registra desde dónde quedó el hueco

---

### Requirement: REQ-VPF-10 — Migración de las marcas

La primera vez, cada fuente configurada MUST arrancar en la marca de la red. La primera corrida después del cambio MUST NOT pedir más atrás de lo que habría pedido el código anterior. Si la marca de la red cambió por fuera (corrió código anterior), cada fuente MUST quedar en el máximo entre su marca y la de la red. Sacar una fuente o darla de alta de nuevo MUST borrar su marca.

#### Scenario: Deploy con el piloto al día

- GIVEN la marca de la red en la corrida de hace 4 horas y búsquedas que no responden desde hace 10 días
- WHEN corre la primera corrida con el cambio
- THEN todas las búsquedas piden 1 día

---

### Requirement: REQ-VPF-11 — No se tira lo pagado

El adapter de apidojo MUST quedarse con todo lo que el actor devolvió desde las 00:00 UTC del día de `until`, y MUST calcular `until` una sola vez por consulta desde el inicio de la ventana. Un posteo sin fecha MUST descartarse. Sin `until` (benchmark, refresco) MUST pasar todo.

#### Scenario: Corrida a media tarde

- GIVEN una ventana que arranca ayer a las 16:00 y un posteo de ayer a las 9:00
- WHEN vuelve la búsqueda
- THEN el posteo queda entre los candidatos

---

### Requirement: REQ-VPF-12 — Tope por término y segunda consulta

El tope de una búsqueda MUST ser al menos el de hoy y MUST subir con el volumen medido de ese término, hasta `SEARCH_RESULTS_MAX`. Si una búsqueda llena su tope, MUST hacerse una segunda consulta de la misma ventana con un tope mayor mientras entre en `SEARCH_EXTRA_MAX_USD_PER_CYCLE`; si no entra, la fila MUST quedar con `tope_lleno` y la corrida `incompleta`. El techo MUST NOT recortar las consultas normales.

#### Scenario: Tope lleno con presupuesto

- GIVEN una búsqueda con tope 50 que devuelve 50
- WHEN hay lugar en el techo del excedente
- THEN se lanza otra con tope 200 y se juntan las respuestas sin repetidos

---

### Requirement: REQ-VPF-13 — La corrida incompleta se ve

El recuadro de progreso, la barra superior, el inicio y el Pipeline MUST decir cuándo la última corrida fue incompleta o cortada y qué fuentes fallaron, con textos para una persona. Una corrida ok MUST verse como antes. El frontend MUST NOT calcular el estado.

#### Scenario: Seis de ocho

- GIVEN la última corrida con seis búsquedas caídas
- WHEN se abre el Monitoreo
- THEN la barra dice "incompleta" y el Pipeline dice "Fallaron 6 de 8 búsquedas"

---

### Requirement: REQ-VPF-14 — Día sin detección

Un día cuya única corrida no tuvo ninguna fuente que respondiera MUST NOT contar como día con corridas en Estadísticas.

#### Scenario: Corrida caída entera

- GIVEN un día con una corrida terminada en la que fallaron todas las búsquedas
- WHEN se cuentan los días con corridas del período
- THEN ese día no cuenta

---

### Requirement: REQ-VPF-15 — Rendimiento por término

`npm run gastos` MUST mostrar por término de búsqueda las consultas, los resultados, los nuevos, los guardados, los descartados, el costo en Apify y el costo del modelo, y MUST marcar las corridas incompletas.

#### Scenario: Un término que no rinde

- GIVEN un término con 400 resultados, 300 descartados y 0 guardados
- WHEN se corre el reporte
- THEN su fila lo muestra con lo que costó

---

### Requirement: REQ-VPF-16 — Asentar corridas cortadas

`scripts/costo-apify.js --asentar <archivo>` MUST anotar el run y el costo real en la fila fallida que corresponde (por corrida y objetivo), sin crear filas ni publicaciones, y MUST recalcular el total de la corrida. Sin `--si` MUST informar sin escribir. Una segunda pasada MUST NOT cambiar nada.

#### Scenario: Once corridas cortadas

- GIVEN un archivo con once corridas y sus costos
- WHEN se corre con `--si`
- THEN las once filas quedan con su run y su costo real, y la suma coincide

---

### Requirement: REQ-VPF-17 — Corridas hondas por hora

Con `MONITOR_DEEP_HOURS` configurada, la corrida PROGRAMADA que cae en una de esas horas MUST ser honda: la ventana mínima de todas las búsquedas es `MONITOR_DEEP_WINDOW` (default 7 días) en vez de `MONITOR_MIN_WINDOW`. Si pasaron más de 24 h desde la última corrida honda terminada, o no hubo ninguna, la próxima corrida programada MUST ser honda aunque no sea su hora. Una corrida manual ("Actualizar ahora") MUST ser corta. Sin `MONITOR_DEEP_HOURS` el sistema MUST comportarse como antes. Un valor mal escrito MUST abortar el arranque. La pantalla MUST NOT cambiar.

#### Scenario: Honda por la hora

- GIVEN `MONITOR_DEEP_HOURS=8,16` y todas las búsquedas con su marca de hace 4 horas
- WHEN corre la corrida programada de las 8
- THEN cada búsqueda pide desde hace 7 días y la corrida queda registrada como honda

#### Scenario: Corta fuera de hora

- GIVEN la misma configuración y una honda terminada hace 4 horas
- WHEN corre la corrida programada de las 12
- THEN cada búsqueda pide desde hace 1 día

#### Scenario: Honda atrasada

- GIVEN la última honda terminó hace más de 24 horas
- WHEN corre la corrida programada de las 20
- THEN es honda

#### Scenario: Actualizar ahora

- GIVEN una hora honda
- WHEN alguien aprieta "Actualizar ahora"
- THEN la corrida es corta y no cuenta como honda

---

### Requirement: REQ-VPF-18 — La corrida dice si es honda y cuánto cuesta

Con las corridas hondas activas, cada corrida MUST dejar en el log si es honda o corta y el costo estimado de sus búsquedas, con el máximo posible. El estimado MUST salir de las consultas recientes de cada término de una ventana parecida a la que se pide.

#### Scenario: Con historia

- GIVEN un término cuya última consulta de 7 días trajo 400 resultados
- WHEN arranca una corrida honda
- THEN el estimado de ese término es el de 400 resultados
