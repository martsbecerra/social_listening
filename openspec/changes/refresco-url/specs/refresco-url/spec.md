# Spec: refresco-url

Refresco de métricas de Instagram por URL de publicación con el actor oficial `apify/instagram-scraper`, decidido por publicación, con tope por ciclo, freno a publicaciones borradas y una regla única para no pisar métricas guardadas.

---

## ADDED Requirements

### Requirement: REQ-RURL-01 — Interruptor `REFRESH_MODE`

El refresco de métricas MUST usar el modo que indique `REFRESH_MODE`: `url` (default) o `perfil`. Con `perfil` el comportamiento MUST ser el anterior al cambio (consulta de perfil por cuenta, `MAX_ACCOUNTS_PER_REFRESH`, `BENCHMARK_POST_LIMIT`). Un valor desconocido MUST abortar el arranque con un mensaje claro. El modo `url` MUST aplicarse solo a plataformas con `capabilities.metricsRefresh` y `fetchPostDetails`.

#### Scenario: Volver atrás

- GIVEN `REFRESH_MODE=perfil`
- WHEN corre la fase de refresco
- THEN se consulta el perfil de cada cuenta con posteos vencidos, como antes

#### Scenario: Valor inválido

- GIVEN `REFRESH_MODE=posteo`
- WHEN arranca el server
- THEN aborta indicando los valores válidos

---

### Requirement: REQ-RURL-02 — Selección por publicación

En modo `url`, el refresco MUST decidir por publicación: entran los posteos no ignorados ni frenados cuyo `posted_at` cae en la ventana del tramo y cuya última escritura de métricas (`metrics_updated_at`, o `detected_at` si nunca se refrescó) es anterior a la cadencia del tramo. Los tramos y cadencias MUST ser los de hoy: caliente (< `REFRESH_HOT_HOURS`) cada `REFRESH_HOT_EVERY_HOURS`; tibio (hasta `REFRESH_WARM_DAYS`) con marca de pase `warm_last_pass_at` cada `REFRESH_WARM_EVERY_HOURS` más cadencia por posteo; frío (hasta `REFRESH_COLD_MAX_DAYS`) con marca `cold_last_pass_at` cada `REFRESH_COLD_EVERY_DAYS` más cadencia por posteo; más viejo, congelado. Un posteo recién detectado MUST NOT pedirse en el mismo ciclo en que se detectó.

#### Scenario: Caliente recién detectado

- GIVEN un posteo de hace 2 horas detectado en este ciclo (`metrics_updated_at` null)
- WHEN corre el refresco
- THEN no se pide; entra cuando pasen `REFRESH_HOT_EVERY_HOURS` desde su detección

#### Scenario: Tibio vencido

- GIVEN un posteo de hace 3 días refrescado hace 30 horas y el pase tibio vencido
- WHEN corre el refresco
- THEN se pide su URL

---

### Requirement: REQ-RURL-03 — Orden y tope

Los posteos vencidos MUST ordenarse por tramo (caliente, tibio, frío) y, dentro de cada tramo, por última escritura de métricas ascendente (lo más atrasado primero). MUST pedirse a lo sumo `REFRESH_MAX_POSTS` (150) por ciclo; el resto queda para el ciclo siguiente sin anotar nada. Las marcas de pase de tibio y frío MUST avanzar solo si no quedó nada afuera, ningún lote falló y no se cortó por cuota.

#### Scenario: Tope con pase frío

- GIVEN `REFRESH_MAX_POSTS=3`, 2 posteos calientes y 3 fríos vencidos
- WHEN corre el refresco
- THEN se piden los 2 calientes y el frío más atrasado, 2 quedan para el ciclo siguiente y `cold_last_pass_at` no avanza

#### Scenario: Pase completo

- GIVEN 5 posteos tibios vencidos y tope 150
- WHEN corre el refresco y todos responden
- THEN `warm_last_pass_at` avanza y en el ciclo siguiente no se pide ninguno

---

### Requirement: REQ-RURL-04 — Un run por ciclo, en lotes

Las URLs pedidas MUST enviarse a `platform.fetchPostDetails` en lotes de hasta 100 URLs (un solo run si entran todas), lanzados a través de `refreshLimiter` (nunca `apifyLimiter`), dentro de la fase `refresco`. Un `QUOTA_EXCEEDED` MUST cortar los lotes todavía no lanzados. Un lote que falla MUST NOT contar como respuesta ni como falta para sus posteos: se reintentan por cadencia.

#### Scenario: Dos lotes

- GIVEN 150 posteos pedidos
- WHEN corre el refresco
- THEN hay 2 runs, uno de 100 URLs y otro de 50

#### Scenario: Lote caído

- GIVEN el run responde 500
- WHEN corre el refresco
- THEN ningún posteo del lote cambia ni suma falta, y las marcas de pase no avanzan

---

### Requirement: REQ-RURL-05 — URL con shortcode

Solo MUST pedirse una publicación cuya URL tenga código (`/p/<code>/`, `/reel/<code>/`, `/reels/<code>/`, `/tv/<code>/`). MUST NOT armarse una URL con el id numérico. Un posteo sin código MUST saltearse y contarse en el log. El cruce de la respuesta MUST hacerse por id y, de respaldo, por el código de la URL.

#### Scenario: Sin código

- GIVEN un posteo guardado con `url` del perfil
- WHEN corre el refresco
- THEN no se pide y el log dice cuántos quedaron sin refrescar por eso

---

### Requirement: REQ-RURL-06 — Regla única de métricas

Al escribir métricas de un posteo guardado (`applyMetricsRefresh`, `updatePostMetricsIfChanged`), un valor undefined, null o negativo MUST conservar el valor guardado de ESE campo y MUST NOT contar como cambio; un número mayor o igual a 0 MUST pisarlo. `applyMetricsRefresh` MUST avanzar `metrics_updated_at` igual. El adapter apidojo MUST dejar likes en null cuando `isLikeAndViewCountsDisabled` es true.

#### Scenario: Falta un solo campo

- GIVEN un posteo con 50 likes y 7 comentarios guardados
- WHEN llega `{ likes: null, comments: 9 }`
- THEN queda con 50 likes y 9 comentarios, y cuenta como cambio

#### Scenario: Centinela

- GIVEN el mismo posteo
- WHEN llega `{ likes: -1, comments: -1 }`
- THEN conserva 50 y 7, no cuenta como cambio y `metrics_updated_at` avanza

#### Scenario: Likes ocultos en apidojo

- GIVEN un item de perfil con `likeCount: 0` e `isLikeAndViewCountsDisabled: true`
- WHEN se normaliza
- THEN `likes` es null y `comments` conserva su valor

---

### Requirement: REQ-RURL-07 — Sin respuesta: contador y freno

Si un lote terminó bien y un posteo pedido no volvió (ausente o item con `error`), MUST sumarse 1 a `detected_posts.refresh_misses`. Al llegar a `REFRESH_MISSES_TO_STOP` (2) intentos seguidos sin respuesta, MUST escribirse `refresh_stopped_at`, el posteo MUST dejar de pedirse y MUST registrarse en el log (cuenta y URL) y en el resumen del ciclo. Una respuesta válida MUST volver el contador a 0 y levantar el freno. Las métricas del posteo frenado MUST conservar su último valor.

#### Scenario: Borrado

- GIVEN un posteo que no vuelve en dos intentos seguidos
- WHEN termina el segundo
- THEN `refresh_stopped_at` queda escrito, el log lo nombra y en el ciclo siguiente no se pide

#### Scenario: Respuesta intermitente

- GIVEN un posteo con una falta anotada
- WHEN en el intento siguiente vuelve con métricas
- THEN `refresh_misses` vuelve a 0 y sigue en la cola

---

### Requirement: REQ-RURL-08 — Seguidores por el benchmark

En modo `url` el refresco MUST NOT escribir seguidores. Los seguidores MUST seguir actualizándose por el benchmark (`computeAccountStats`) con la cadencia `BENCHMARK_RECALC_DAYS` y por la validación de cuentas.

#### Scenario: Benchmark

- GIVEN una cuenta que reaparece con un posteo nuevo 31 días después de su último benchmark
- WHEN corre el ciclo
- THEN su benchmark se recalcula y sus seguidores se actualizan en `account_followers` y en sus posteos

---

### Requirement: REQ-RURL-09 — Registro de costo

Cada run del refresco por URL MUST quedar en `apify_calls` con fase `refresco`, `query_type` `post`, actor `apify~instagram-scraper` y `usd` = resultados × tarifa del plan, de modo que `npm run gastos` lo muestre en la fila "refresco" de la corrida.

#### Scenario: Fila

- GIVEN un ciclo que pidió 40 URLs en un run
- WHEN se registra la llamada
- THEN `phase` es `refresco`, `query_type` es `post` y `usd` es 40 × 0,0023 = 0,092

---

### Requirement: REQ-RURL-10 — Solo Instagram

El camino por URL MUST correr solo en plataformas con `capabilities.metricsRefresh` y `fetchPostDetails`. X MUST NOT verse afectada en ningún modo.

#### Scenario: X

- GIVEN `REFRESH_MODE=url` y un ciclo de X
- WHEN corre la fase de refresco
- THEN no se hace ninguna llamada por X
