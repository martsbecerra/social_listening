# Design: ventana-por-fuente

## Technical Approach

La detección de Instagram son ocho búsquedas que hoy comparten una sola
marca ("la última detección exitosa de la red") y un solo tope de espera
(300 s, cortado con un `Promise.race` que no guarda nada). El cambio baja
las dos cosas al nivel de la fuente:

1. cada consulta de detección deja una fila propia (`monitoring_run_sources`)
   con su estado, su ventana, su tope y el id de su corrida en Apify;
2. la marca de detección es por fuente y avanza solo cuando esa fuente
   respondió y sus posteos quedaron procesados;
3. una corrida de Apify que no terminó a tiempo queda "esperando" con su id
   y se levanta al empezar el ciclo siguiente, como una fuente más;
4. todo candidato, venga de la búsqueda del ciclo o de una corrida
   levantada, pasa por la misma tubería (`procesarCandidatos`: dedupe →
   detalle → clasificación → `guardarEvaluado`), que anota en `search_seen`
   lo que decidió el modelo.

## Evidencia (16/11/2026, sobre una copia de la base del piloto)

**Corridas.** #54 (4/11 16:00): las 8 búsquedas ok. #55 (6/11 12:00,
ventana de 2 días, tope 100): `TIMEOUT` a los 300 s en macri, "gobierno de
la ciudad", "gobierno porteño" y jorgemacri. El piloto estuvo apagado hasta
el 16/11. #56 (16/11 12:00, ventana de 10 días, tope 500): ok solo blacri y
blackri; `TIMEOUT` en cuatro, 502 en el `GET` de seguimiento en dos. #57
(manual, 13:24, ventana de 1 día, tope 50): las 8 ok, 105 resultados, 67
nuevos (24 guardados, 42 descartados, 1 sin texto).

**Las corridas cortadas siguieron en Apify.** Leído de la API (solo
lecturas): las diez búsquedas cortadas terminaron `SUCCEEDED`. #56: 500, 500,
500, 500, 456 y 388 resultados, de 347 a 805 s, US$ 1,5085. #55: 4, 3, 2 y 0
resultados, de 372 a 811 s, US$ 0,0625; más una consulta de perfil del
benchmark (443 s, US$ 0,0065). Total sin registrar: US$ 1,5775. La duración
no depende solo de la cantidad: en #55 las búsquedas que sí respondieron
tardaron de 272 a 294 s con 0 a 4 resultados.

**El actor.** Entrada: `keywords` o `startUrls`, `maxItems` y `until`
("solo posteos más nuevos que esta fecha", `AAAA-MM-DD`). No hay fecha de
fin, cursor ni offset: una búsqueda no se puede partir en tramos de fechas.
Los resultados no vienen ordenados por fecha (en la sonda, la mitad de los
pares vecinos están en orden descendente: azar): con el tope lleno no queda
afuera "lo más viejo", queda afuera una parte de cada día. Entran al dataset
de a poco (unos 0,4 a 1 por segundo) y se pueden leer con el run en curso.

**Costo medido de apidojo.** Búsqueda: 0,015 más 0,0005 por posteo desde el
primero (388 búsquedas conciliadas: estimado 5,84 contra 6,22 real, 6,1 %
menos, con 20 posteos "incluidos" que no existen). Perfil con 15 posteos:
0,0075 a 0,008 real.

**Subcaptura con ventanas cortas (sonda autorizada, US$ 0,43).** Seis
corridas a las 15:15 del 16/11, `maxItems` 400:

| Búsqueda | `until` | Resultados | De las últimas 24 h | Segundos | US$ |
|---|---|---|---|---|---|
| macri | 15/11 (1 día) | 4 | 3 | 27 | 0,0165 |
| macri | 13/11 (3 días) | 19 | 7 | 62 | 0,0245 |
| macri | 9/11 (7 días) | 400 (tope) | 49 | 408 | 0,2135 |
| GCBA | 15/11 (1 día) | 11 | 9 | 84 | 0,0205 |
| GCBA | 13/11 (3 días) | 1 | 1 | 20 | 0,015 |
| GCBA | 9/11 (7 días) | 252 | 35 | 666 | 0,14 |

Juntando la sonda con los resultados de la #56, de las últimas 24 h se
conocen al menos 70 publicaciones de macri y 47 de GCBA: la ventana de 1 día
trajo el 4 % y el 19 %; la de 3 días no mejora (10 % y 2 %); la de 7, el 70 %
y el 74 %. Por cruce entre dos pasadas independientes (la #56, con `until` de
10 días, y la de 7 de la sonda, sobre el mismo período): cada pasada honda
trae del 70 al 83 % de lo que existe, y dos juntas del 91 al 95 %. Ninguna
ventana trae todo en una pasada. Hipótesis (no verificada): el actor deja de
recorrer cuando encuentra posteos anteriores a `until`, y con un `until`
cercano eso pasa enseguida.

Esta rama NO cambia la ventana mínima: `MONITOR_MIN_WINDOW` (default 1 día,
lo de hoy) queda para decidirlo aparte. Una búsqueda honda tarda de 7 a 11
minutos: sin la espera larga de esta rama se cortaría a los 300 s.

## Architecture Decisions

### 1. `search_seen` anota lo que decidió el modelo

- Columnas nuevas (anulables): `posted_at`, `motivo`, `llm_usd`, `run_id`,
  `terminos` (JSON; el primero es `term`, el del motivo).
- `monitor.guardarEvaluado(post, evaluation, …)` es el final de la tubería:
  guarda y marca `guardado`; marca `descartado` si había texto y el modelo
  dijo que no. Solo para `sourceType 'search'` (X no escribe en la tabla).
  Sin texto no hubo decisión: no se anota (lo anota el detalle cuando lo
  paga, como antes).
- En el ciclo, un posteo que ya estaba en `search_seen` al empezar no se
  vuelve a evaluar: solo se le suman los términos que lo trajeron esta vez.
  El total de "Clasificando relevancia" es la cantidad de nuevos.
- `classifier.clasificarPosteo(caption, { onUsage })`: el costo viaja por un
  aviso; el resultado no cambia de forma.
- Estadísticas cuenta los descartados por `COALESCE(posted_at,
  first_seen_at)`.

### 2. Costo de las búsquedas y `apify_calls` con estado

- `APIDOJO_INCLUDED_SEARCH` pasa a 0 por defecto. `maxUsdForSearch(maxItems)`
  = consulta + tope × posteo: el techo de lo que puede costar una búsqueda.
- `apify_calls` suma `estado`, `max_items` y `until`. Estados: `en_curso`
  (la fila se abrió cuando Apify devolvió el run), `ok`, `error`,
  `esperando` (se dejó de esperar; el run sigue en Apify y alguien lo va a
  levantar), `parcial` (Apify cortó el run y se usó lo que dejó),
  `recuperada`, `perdida`. NULL en las filas anteriores, que se leen por
  `ok`. Al recuperar una fila pasa a `ok = 1` con sus resultados: todas las
  sumas de siempre (fallidas, resultados, usd) siguen valiendo sin cambios;
  la historia de que se cortó vive en `monitoring_run_sources`.
- La conciliación del costo real no cambia: ya toma toda fila con run
  conocido y sin costo real. Alcanza con que la fila cortada tenga su run.

### 3. El id del run nunca se pierde (`src/apify.js`)

- El `POST` que arranca el run va sin espera; apenas vuelve, la fila de
  `apify_calls` se abre con el id (`en_curso`) y se avisa a quien llamó
  (`onRunStarted`). Si el proceso muere ahí, el gasto ya quedó anotado.
- El seguimiento (`GET /actor-runs/{id}` con `waitForFinish`) tiene plazo
  propio. Un 5xx, 408, 429, corte de red o tiempo agotado de ESA lectura se
  reintenta a los 5, 10, 20 y 30 s (la #56: dos 502 en el seguimiento
  tiraron búsquedas cuyo run siguió y terminó bien). Un 401, 403 o 404 no.
- Al vencer el plazo: error `TIMEOUT` con `apifyRunId` y `runPending`. No se
  aborta el run.
- Un run que termina `FAILED`, `ABORTED` o `TIMED-OUT` entrega lo que dejó en
  el dataset (`err.partialItems`).
- El dataset se baja con el mismo reintento; si igual no se puede, el run
  terminado queda pendiente como uno que no se llegó a esperar.
- El `POST` nunca se reintenta por su cuenta (crearía otro run pago); el
  único reintento es el del 402 por runs simultáneos, que no creó nada.
- `withTimeout` queda como guarda contra un cuelgue, 30 s después del plazo,
  y si salta con el run ya creado conserva el id.
- El actor oficial sigue por el endpoint sincrónico, sin cambios.
- Lecturas nuevas, sin cola ni fila: `fetchRun`, `fetchDatasetItems`.

### 4. Registro por fuente y estado de la corrida

- Tabla `monitoring_run_sources`: `run_id`, `plataforma`, `tipo` (busqueda |
  cuenta | hashtag | keyword | detalle | plataforma), `fuente`, `clave`,
  `intento` (2 = la segunda consulta por tope lleno), `estado` (en curso |
  ok | esperando | parcial | fallo | recuperada | perdida | sin_fuente),
  `motivo` (código corto: TIMEOUT, HTTP_502, RED, AUTH_INVALID,
  QUOTA_EXCEEDED, RATE_LIMITED, RUN_FAILED, NO_LANZADA, …), `detalle` (hasta
  200 caracteres, solo para el log y los scripts: nunca sale por la API),
  `actor`, `apify_run_id`, `desde_iso`, `until`, `tope`, `items`, `nuevos`,
  `tope_lleno`, `hueco_desde`, `recuperada_en`, `recuperada_at`,
  `started_at`, `finished_at`, `duracion_ms`.
- `monitoring_runs.error_code`: el código si el ciclo entero tiró.
- `src/runStatus.js` (puro, como `reachRule.js`): `estadoCorrida(run,
  fuentes)` por red: `en curso` o `interrumpida` > `cortada` (cuota) >
  `incompleta` > `ok`. Incompleta: alguna fuente en fallo, esperando,
  parcial, recuperada o perdida; una fila `plataforma` (no se buscó nada);
  un tope lleno sin cubrir; un hueco por el techo; o `error_code`. Una
  corrida sin filas (anterior a la tabla) da `ok`, como hoy. Las fallas del
  benchmark, el refresco o las fotos no la marcan.
- Las corridas anteriores se completan UNA vez desde `apify_calls` (marca
  `fuentes_por_corrida_backfill`): una fila por búsqueda, `fallo` si
  `ok = 0`.
- `/api/monitoring/status`, `/api/inicio` y `run-now` devuelven el estado y
  la lista de fuentes fallidas (fuente, motivo en texto para una persona);
  nunca el `detalle` ni el error crudo.

### 5. Espera larga y recuperación

- `SEARCH_WAIT_MS` (15 min, piso 1 s) es UNA espera para toda la fase de
  detección de la red, no por búsqueda: todas las búsquedas comparten el
  mismo vencimiento, también la segunda consulta por tope lleno. Una
  búsqueda que todavía no consiguió cupo al vencer no se lanza (`NO_LANZADA`,
  su marca no avanza). Así la detección dura como mucho `SEARCH_WAIT_MS`
  aunque haya más búsquedas que cupos.
- `SEARCH_RUN_TIMEOUT_SECS` (3600) viaja en el `POST` como `timeout`: Apify
  corta el run ahí, para que uno que nadie espera no quede corriendo.
- Al empezar la detección de cada red, bajo el candado del ciclo,
  `recoverPendingSearchRuns` relee cada fila `esperando` (y las `en curso`
  de ciclos anteriores, que el proceso dejó abiertas):
  - `SUCCEEDED`: sus posteos entran como candidatos; la fila pasa a
    `recuperada`; la búsqueda de este ciclo arranca desde el momento en que
    esa corrida se lanzó (`cubiertoHasta`);
  - sigue corriendo: ese término se saltea en este ciclo (no se paga dos
    veces);
  - cortada por Apify: entra lo que dejó; `parcial`;
  - 404: `perdida`, con su línea de log;
  - no se pudo leer: se reintenta en el ciclo siguiente; pasados 7 días,
    `perdida`;
  - el término ya no está configurado: `sin_fuente`, sin clasificar nada.
- No hay limitador propio para las búsquedas: no anidan llamadas (el
  deadlock documentado es de una capa que retiene cupo y llama a otra que
  pide el mismo). La recuperación son lecturas, sin cola.
- La recuperación elige el proveedor por el actor de la fila, no por
  `IG_ACTOR`.

### 6. Ventana y marca por fuente

- Clave: `detection_last_success:<red>:<tipo>:<clave>`, con la clave
  normalizada como la config (trim, minúsculas, sin `@` ni `#`).
- `detectionWindowFor(red, { tipo, fuente, now, cubiertoHasta })`: base =
  max(marca, cubiertoHasta) o, sin marca, ahora − `MONITOR_LOOKBACK`; desde
  = max(ahora − `MONITOR_LOOKBACK_MAX`, min(base, ahora −
  `MONITOR_MIN_WINDOW`)). Devuelve además `origen` (primera | marca | minimo
  | techo) y, si el techo recortó, desde dónde quedó el hueco.
- Avance, al final de la detección de la red y antes de cualquier throw:
  ok → inicio del ciclo; fallo o esperando → no avanza (una fuente sin marca
  que falla queda con la marca en el inicio de su ventana: el reintento pide
  más); recuperada → max(marca, lanzamiento de esa corrida); parcial → no
  avanza la primera vez y sí la segunda seguida (queda registrado); tope
  lleno sin cubrir → avanza y queda registrado.
- La marca de la red (`detection_last_success:<red>`) se sigue escribiendo,
  solo cuando todas las fuentes avanzaron: es lo que usa el código anterior
  si se vuelve atrás.
- Migración: la primera vez (marca `detection_por_fuente:<red>` ausente)
  cada fuente configurada arranca en la marca de la red, que es exactamente
  lo que habría usado el código anterior: la primera corrida después del
  deploy no pide más atrás que la que habría corrido sin el cambio. Si el
  valor guardado en `detection_por_fuente:<red>` no coincide con la marca de
  la red, corrió código anterior en el medio: cada fuente pasa a max(su
  marca, la de la red).
- Sacar una fuente, o darla de alta de nuevo, borra su marca. Las marcas de
  fuentes que ya no están se limpian al empezar el ciclo.
- En X, cuentas, hashtags y keywords pasan a la misma regla.

### 7. `applyWindow` por el día de `until`

- `until` se calcula una vez por consulta, desde el `sinceIso` de la ventana
  (el día UTC en que arranca). `applyWindow(posts, until)` se queda con todo
  lo publicado desde las 00:00 UTC de ese día: es lo que se pagó. Antes
  recortaba en "ahora menos N días", calculado al volver la respuesta, y
  tiraba lo anterior ya cobrado.
- Va después de la decisión 1: sin ella, cada ciclo volvería a clasificar el
  solapamiento.
- La respuesta de `scrapeSearch` lleva una meta no enumerable `{ rawItems,
  maxItems, until, apifyRunId }`.

### 8. Tope por término y segunda consulta

- `src/busquedaTope.js` (puro). Tope de una búsqueda = min(`SEARCH_RESULTS_MAX`
  (2000), max(el de hoy: `raiseLimitForWindow(base, días)`, 2 × tasa ×
  horas pedidas)), con la tasa = el máximo de resultados por hora de las
  últimas 6 consultas buenas de ese término (el doble si esa consulta llenó
  su tope). Nunca menor que el de hoy.
- Con el tope lleno: una segunda consulta de la misma ventana con 4 × el
  tope (hasta el máximo), si entra en `SEARCH_EXTRA_MAX_USD_PER_CYCLE`
  (2,00), que cubre solo esas segundas consultas. Sin lugar: `tope_lleno`,
  la marca avanza y la corrida queda incompleta.

### 9. Pantalla

Textos aprobados por el dueño (16/11/2026); ver `tasks.md`, fase 10. El
frontend no calcula el estado: lo recibe.

### 10. Reportes

- `npm run gastos`: la tabla por término suma nuevos, guardados,
  descartados y el costo del modelo (de `search_seen`).
- `scripts/costo-apify.js --conciliar` lista las corridas que siguen
  esperando. `--asentar <archivo.json>` anota en `apify_calls` el run y el
  costo real de corridas que la app cortó sin registrar (las once de #55 y
  #56), sin importar publicaciones; sin `--si` solo informa.

## Cuánto puede durar un ciclo

Con `APIFY_MAX_CONCURRENT` 10 las ocho búsquedas corren a la vez. Peor caso
de la detección: `SEARCH_WAIT_MS` (15 min), compartido con las segundas
consultas. Después: detalle (hasta 5 min), clasificación (unos 2 s por
posteo nuevo, sin techo) y benchmark y refresco como hoy. Si un ciclo sigue
corriendo a la hora del siguiente, el cron lo saltea (ya era así).

## Lo que queda afuera

- La importación de los resultados recuperados de #55 y #56.
- La ventana mínima por defecto y una corrida honda por día.
