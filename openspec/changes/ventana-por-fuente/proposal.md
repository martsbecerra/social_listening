# Proposal: ventana-por-fuente

## Intent

Que una búsqueda que falla o se corta no deje un hueco en la detección, y que
lo que la app ya pagó en Apify no se pierda:

- cada fuente de la detección (en Instagram, cada búsqueda) guarda su propia
  última detección exitosa y retoma desde ahí;
- una corrida de Apify que la app deja de esperar no se pierde: su id queda
  guardado y el resultado se levanta en la corrida siguiente;
- lo que el clasificador descartó queda anotado con su búsqueda y no se
  vuelve a clasificar;
- una búsqueda que llena su tope pide más en vez de cortar;
- una corrida con búsquedas caídas no figura como "ok".

**Por qué.** Lo que pasó entre el 4 y el 16 de noviembre de 2026 (corridas
#54 a #57 del piloto):

- #55 (6/11, ventana de 2 días, tope 100): cuatro de las ocho búsquedas se
  cortaron a los 300 s (`TIMEOUT`). #56 (16/11, después de diez días con el
  piloto apagado; ventana de 10 días, tope 500): seis de ocho se cortaron
  (cuatro `TIMEOUT`, dos con un 502 en el seguimiento del run).
- En las dos la detección se dio por exitosa: un `TIMEOUT` y un 502 son
  "falló una fuente", no un error de plataforma, y la marca
  `detection_last_success:instagram` (una sola por red) avanzó igual. La
  corrida siguiente ya no volvió a pedir esos días. Quedó un hueco del 4/11
  al 15/11 para cuatro búsquedas y del 6/11 al 15/11 para otras dos.
- Las corridas cortadas terminaron bien en Apify (`SUCCEEDED`, de 347 a 811
  s) y se cobraron: US$ 1,5775 que no figuraban en `apify_calls`, porque la
  app corta con un `Promise.race` que no guarda el id del run.
- De los 67 resultados nuevos de la #57, 42 fueron descartados por el
  clasificador y ninguno quedó anotado: `search_seen` solo anotaba si se
  había pagado el detalle, y las búsquedas ya traen el texto. Cada corrida
  volvía a clasificar los mismos descartados.
- La #57 (manual, 1 h 24 min después de la #56) usó una ventana de 1 día: la
  marca estaba en el inicio de la #56, la ventana se redondea a días con
  mínimo 1 y al actor le llega solo `until` (un día UTC); después el adapter
  recorta en "ahora menos 24 h".

**Lo que la rama no arregla** y queda medido en `design.md`: con una ventana
de 1 día el actor devuelve una fracción mínima de lo publicado (sonda del
16/11/2026). La ventana mínima queda configurable (`MONITOR_MIN_WINDOW`,
default 1 día) para decidirlo aparte.

## Scope

### In Scope

- `search_seen` anota toda decisión del clasificador sobre un resultado de
  búsqueda, con todos los términos que lo trajeron, el motivo, el costo de
  la clasificación, la corrida y la fecha de publicación; lo ya decidido no
  se vuelve a clasificar
- Costo de las búsquedas de apidojo sin posteos incluidos (lo medido), y
  `apify_calls` con estado, tope pedido y `until`
- Flujo asincrónico de `src/apify.js`: el id del run se guarda apenas Apify
  lo devuelve; el seguimiento se reintenta; al vencer la espera el run queda
  "esperando" con su id; un run cortado por Apify entrega lo que dejó
- Tabla `monitoring_run_sources` (una fila por consulta de detección) y
  `src/runStatus.js`: estado de la corrida por red (`ok` | `incompleta` |
  `cortada` | `en curso` | `interrumpida`) y qué falló
- Las búsquedas esperan hasta `SEARCH_WAIT_MS` (15 min) para TODA la fase
  de detección; lo que no terminó se levanta al empezar la corrida siguiente
- Marca de detección por fuente en `refresh_state`, con mínimo
  `MONITOR_MIN_WINDOW` y techo `MONITOR_LOOKBACK_MAX`; migración desde la
  marca de la red
- `applyWindow` de apidojo corta por el día de `until` (no tira lo pagado)
- Tope por término según su volumen medido, y segunda consulta cuando el
  tope se llena, con techo de gasto por corrida
- Pantalla: recuadro de "Actualizar ahora", barra superior, inicio y
  Pipeline muestran la corrida incompleta y qué falló
- Estadísticas: un día cuya única corrida no detectó nada no cuenta como día
  con corridas
- Reportes: `npm run gastos` con el rendimiento por término;
  `scripts/costo-apify.js` lista lo pendiente y asienta el costo de corridas
  cortadas que la app no registró
- Tests, README, CLAUDE.md y `.env.example`

### Out of Scope

- Importar a la base los resultados recuperados de las corridas cortadas de
  #55 y #56 (decisión del dueño: el hueco del 5 al 15/11 queda sin cubrir)
- Cambiar la ventana mínima por defecto, o una corrida "honda" por día
  (depende de la decisión sobre la sonda)
- Techo de clasificaciones por corrida; cola persistente para los pendientes
  de detalle; adoptar automáticamente un run cuyo arranque devolvió 5xx
- Prompt caching del clasificador
- X: su prompt, su análisis y sus fuentes no cambian; solo pasa a tener marca
  por fuente como el resto

## Capabilities

### New Capabilities

- `ventana-por-fuente`: detección por fuente que no pierde corridas ni
  publicaciones, con registro de lo que falló

## Approach

Trece pasos, un commit cada uno (ver `tasks.md`). El orden importa: primero
lo que no depende de nada y corta gasto (descartados), después el run id y
el registro por fuente, recién ahí la espera larga y la marca por fuente (la
marca por fuente sin recuperación de corridas haría crecer la ventana y
cortarse otra vez a los 300 s), y al final la pantalla y los reportes.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/db.js` | Modificado | columnas de `search_seen` y `apify_calls`; tabla `monitoring_run_sources`; `error_code` en `monitoring_runs`; lecturas y escrituras nuevas, todas por plataforma |
| `src/monitor.js` | Modificado | `guardarEvaluado`, `procesarCandidatos`, ventana y marca por fuente, recuperación de corridas pendientes, tope y segunda consulta, registro por fuente |
| `src/apify.js` | Modificado | flujo asincrónico con id inmediato, reintentos del seguimiento, plazo propio, parciales, dataset paginado, lecturas de un run |
| `src/apifyCost.js` | Modificado | búsqueda sin incluidos, `maxUsdForSearch`, fila abierta y cerrada, conciliación de filas viejas con run conocido |
| `src/platforms/instagramApidojo.js` | Modificado | `scrapeSearch` por el asincrónico con espera, `recoverSearchRun`, `applyWindow` por `until`, meta de la consulta |
| `src/platforms/instagram.js`, `index.js` | Modificado | exponen `recoverSearchRun`; contrato |
| `src/runStatus.js` | Nuevo | estado de la corrida, puro |
| `src/busquedaTope.js` | Nuevo | tope por término y techo del excedente, puro |
| `src/scheduler.js` | Modificado | cierre del ciclo con estado y línea de costo ampliada |
| `src/monitoringProgress.js` | Modificado | estado `wait`, nota de cierre, estado de la corrida |
| `src/lastRun.js`, `src/inicioRoutes.js`, `server.js` | Modificado | estado y fuentes fallidas en `/status`, `/api/inicio` y `run-now`; validación de variables |
| `src/stats.js` (vía `db.js`) | Modificado | menciones por fecha de publicación; días con corridas |
| `public/js/*` , `public/css/styles.css`, `instagram.html`, `x.html`, `dashboard.html` | Modificado | textos y estados de la corrida incompleta |
| `scripts/gastos.js`, `scripts/costo-apify.js` | Modificado | rendimiento por término; pendientes, huérfanas y asiento de corridas cortadas |
| `test/` | Nuevo / Modificado | ver `tasks.md` |
| `README.md`, `CLAUDE.md`, `.env.example` | Modificado | documentación |

## Risks

| Riesgo | Mitigación |
|--------|------------|
| Esperar 15 min alarga el ciclo y "Actualizar ahora" | la espera es UNA para toda la detección, no por búsqueda; lo que no termina se levanta en la corrida siguiente; `SEARCH_WAIT_MS` configurable |
| Un run que se dejó de esperar sigue ocupando cupo en Apify | `SEARCH_RUN_TIMEOUT_SECS` (3600) lo corta en Apify; un 402 por runs simultáneos ya se reintenta |
| Avanzar la marca con el tope lleno pierde publicaciones a sabiendas | queda registrado (`tope_lleno`) y a la vista (corrida incompleta); sin avanzar, la ventana crecería sin fin |
| Las migraciones corren al cargar `db.js`, también desde un script | idempotentes y en transacción; probadas sobre una copia |
| Volver a `main`: la primera corrida amplía todas las búsquedas hasta la marca de la red | documentado; la marca de la red solo avanza cuando todas las fuentes avanzaron |
| La primera corrida después del deploy dispara una búsqueda de muchos días | la migración arranca cada fuente en la marca de la red (lo que habría usado el código anterior), nunca más atrás |

## Rollback Plan

Revertir el merge. Las columnas y la tabla nuevas quedan en la base sin uso
(el código anterior no las lee). La marca de la red sigue existiendo y el
código anterior la usa como siempre.

## Dependencies

Ninguna librería nueva. La API de Apify: `POST /acts/{id}/runs` (con
`timeout`), `GET /actor-runs/{id}`, `GET /datasets/{id}/items` (paginado).

## Success Criteria

- [ ] Una búsqueda cortada por tiempo deja su id y su resultado entra en la corrida siguiente, sin duplicar ni volver a clasificar
- [ ] Una búsqueda que falla retoma desde su última detección exitosa, con el techo de `MONITOR_LOOKBACK_MAX`
- [ ] Un descartado no se vuelve a clasificar y `npm run gastos` muestra el rendimiento de cada término
- [ ] Una búsqueda que llena su tope pide más, dentro del techo de gasto, o queda marcada
- [ ] Una corrida con búsquedas caídas figura "incompleta" en la base, el log y la pantalla
- [ ] Suite verde con `IG_ACTOR=apidojo` y `IG_ACTOR=apify`
