# Proposal: refresco-url

## Intent

Cambiar el refresco de métricas de Instagram (`src/metricsRefresh.js`) de
"consultar el PERFIL de cada cuenta" a "consultar cada PUBLICACIÓN por su
URL" con el actor oficial `apify/instagram-scraper`, reusando
`instagram.fetchPostDetails` (el mismo camino del detalle de los resultados
de búsqueda): un run por ciclo con todas las URLs que tocan, 0,0023 usd por
posteo, decidido por publicación y no por cuenta.

**Por qué.** La consulta de perfil de apidojo trae los últimos 15 posteos
de la cuenta (0,0065 usd). Un posteo de 2 a 7 días de un medio que publica
mucho ya no está entre esos 15: se paga y no se actualiza. Reconstruido
desde la base para las corridas #9 y #14 (septiembre 2026): de 79 y 97
posteos a refrescar se actualizaron ~18 y ~30 (23 % y 31 %); el resto se
pagó sin tocarlo. El 84 % de las cuentas del pool tiene un solo posteo a
refrescar: se pagan 15 resultados para actualizar 1. Con las 16 corridas
reales #17 a #32 (28/09 al 2/10): perfil 3,27 usd contra 1,52 por URL como
techo (los posteos que no vienen en el perfil siguen vencidos y se vuelven
a contar; por URL se actualizan y salen de la cola), y por URL se actualiza
el 100 % de lo pedido.

## Scope

### In Scope

- Interruptor `REFRESH_MODE` (`url` default | `perfil`), validado al
  arrancar como `IG_ACTOR`; `perfil` es el código actual sin cambios
- Selección POR PUBLICACIÓN con los mismos tramos y cadencias de hoy
  (caliente / tibio / frío, marcas de pase en `refresh_state`)
- Orden: tramo primero (caliente, tibio, frío) y, dentro de cada tramo, lo
  más atrasado primero; tope `REFRESH_MAX_POSTS` (150) por ciclo, el resto
  queda para el ciclo siguiente
- Un run por ciclo con todas las URLs; lotes de hasta 100 URLs por run (el
  endpoint sincrónico de Apify corta a los 300 s), lanzados por
  `refreshLimiter`
- Solo URLs con shortcode (`/p/<code>/`, `/reel/<code>/`); nunca una URL
  armada con el id numérico (el actor no la acepta)
- Regla única de métricas en `src/db.js`: un likes o comentarios ausente,
  null o negativo NUNCA pisa lo guardado, aunque falte solo uno de los dos;
  apidojo con `isLikeAndViewCountsDisabled` deja likes en null, no 0
- Publicaciones borradas o privadas: contador `refresh_misses` y freno
  `refresh_stopped_at` en `detected_posts`; a los `REFRESH_MISSES_TO_STOP`
  (2) intentos seguidos sin respuesta dejan de refrescarse, con registro
- Costo registrado como hasta ahora (fase `refresco`, `query_type` `post`,
  actor oficial): `npm run gastos` y `npm run costo` lo muestran sin cambios
- `.env.example`, README, CLAUDE.md, este SDD

### Out of Scope

- X (`src/platforms/x.js`): el camino por URL corre solo en plataformas con
  `capabilities.metricsRefresh` y `fetchPostDetails`
- El benchmark (`src/accountStats.js`): sigue por perfil, y es quien trae
  los seguidores
- El detalle de los resultados de búsqueda (`monitor.enrichSearchResults`):
  se reusa, no se toca
- El frontend: las columnas nuevas no se muestran
- Bajar `BENCHMARK_RECALC_DAYS` para que los seguidores se actualicen más
  seguido (decisión aparte del dueño)

## Capabilities

### New Capabilities

- `refresco-url`: refresco de métricas por URL con el actor oficial,
  interruptor `REFRESH_MODE`, tope por publicaciones, freno a borrados

### Modified Capabilities

- Escritura de métricas (`db.applyMetricsRefresh`,
  `db.updatePostMetricsIfChanged`): conservan por campo lo guardado ante un
  valor ausente, null o negativo
- Seguidores: dejan de llegar por el refresco (el actor oficial no los trae
  por posteo); siguen por el benchmark (`BENCHMARK_RECALC_DAYS`) y la
  validación de cuentas

## Approach

1. `src/db.js`: regla única de métricas; columnas `refresh_misses` y
   `refresh_stopped_at`; `listPostsDueForRefresh` (por posteo, con ventana
   de edad y cadencia; un posteo nunca refrescado cuenta desde
   `detected_at`); `registerRefreshMiss`.
2. `src/refreshMode.js`: `REFRESH_MODE`, calcado de `igActor.js`;
   `server.js` lo valida antes de cargar módulos y lo muestra en el banner.
3. `src/metricsRefresh.js`: la lógica de tramos y marcas se comparte; el
   camino URL arma la cola (tramo primero, atraso dentro), aplica
   `skipAccounts` y el tope, pide el detalle en lotes de hasta 100 URLs con
   `platform.fetchPostDetails` bajo `refreshLimiter`, cruza por id y
   después por código de la URL, escribe con `applyMetricsRefresh`, detecta
   saltos, anota los sin respuesta y avanza las marcas solo con pase
   completo. El camino perfil queda intacto.
4. Tests con `instagram.fetchPostDetails` stubeado y el fixture real
   `test/fixtures/apify/post-details-2urls.json`; los tests del camino
   perfil fijan `REFRESH_MODE=perfil`.

## Affected Areas

- `openspec/changes/refresco-url/` — este SDD
- `src/db.js`, `src/refreshMode.js` (nuevo), `src/metricsRefresh.js`
- `src/platforms/instagramApidojo.js` — likes ocultos a null
- `src/monitor.js` — exporta `postCodeOf` (sin cambios de lógica)
- `server.js` — validación de `REFRESH_MODE`, banner
- `test/refreshPorUrl.test.js` (nuevo), `test/metricasConservadas.test.js`
  (nuevo), `test/refreshTramos.test.js`, `test/parallelRefresh.test.js`,
  `test/apifyCosts.test.js`, `test/apidojoProvider.test.js`
- `.env.example`, `README.md`, `CLAUDE.md`

## Risks

- Un run con muchas URLs puede superar los 300 s del endpoint sincrónico
  (el detalle de 17 URLs tardó 19 s). Mitigado con lotes de hasta 100 URLs;
  `APIFY_CALL_TIMEOUT_MS` corta lo que se cuelgue y ese lote se reintenta
  por cadencia.
- No está documentado si el actor cobra los items de error (posteo borrado
  o privado); el README del proyecto los da por cobrados. El freno a los 2
  intentos acota el gasto a 0,0046 por posteo borrado. CONFIRMADO en la
  corrida real del 2026-10-06: el item `not_found` se escribe en el dataset
  y se cobra como un resultado (0,0023).
- El pase frío (hoy 278 posteos vencidos) supera el tope: se reparte en 2
  o 3 ciclos seguidos; mientras tanto puede postergar lo tibio un ciclo.
  El tramo caliente va siempre primero.
- Los seguidores pasan a actualizarse con la cadencia del benchmark (hasta
  30 días para las cuentas que reaparecen): antes el pase tibio diario los
  traía de rebote.

## Rollback Plan

`REFRESH_MODE=perfil` en el `.env` y reiniciar: el refresco vuelve a la
consulta de perfil exacta de antes. Las columnas nuevas y la regla de
métricas son aditivas y pueden quedar.

## Dependencies

- `APIFY_API_TOKEN` con acceso a `apify/instagram-scraper` (ya se usa para
  el detalle de búsqueda y el análisis).

## Success Criteria

- [x] Con `REFRESH_MODE=perfil` la suite pasa y el refresco se comporta como antes
- [x] Con `url`, cada ciclo pide por URL exactamente los posteos vencidos por tramo y cadencia, en lotes de hasta 100, en la fase `refresco`
- [x] Un valor ausente, null o negativo nunca pisa un likes o comentarios guardado
- [x] Un posteo sin respuesta en 2 intentos seguidos deja de pedirse y queda registrado
- [x] `npm run gastos` muestra el refresco por URL con el actor oficial
- [x] Corrida real chica autorizada por el dueño (2026-10-06, US$ 0,0115: 5 de 5 publicaciones actualizadas, costo real igual al estimado)
