# Proposal: analisis-v4

## Intent

Fase E del rediseño v4 (`design/social-listening-v4.html`): la solapa
"Análisis de publicación" de Instagram. Hoy el análisis responde todo al
final, con una barra de progreso simulada, no guarda nada y muestra el
informe como texto plano. La maqueta lo dibuja como un cuadro (la
publicación, el tono, los temas, cuándo se comentó, los comentarios y el
informe para compartir) con los análisis anteriores a mano; acá todo eso
sale de datos reales: cada análisis se guarda, corre en el servidor con
su progreso real y dice cuántos comentarios analizó de verdad.

## Scope

### In Scope

- Tabla `analisis` en `src/db.js`: la publicación, el estado, los números
  (traídos, únicos, analizados de verdad, por tono), el resultado del
  modelo, los temas con su conteo, los comentarios con su tono, "Cuándo
  comentaron", el informe, el CSV, el gasto y la foto
- `POST /api/analyze` devuelve el id y el análisis sigue en el servidor
  (`src/analysisJob.js`); `GET /api/analyze/progress?id=` con los pasos
  reales (`src/analysisProgress.js`); `GET /api/analisis` (recientes y
  "¿ya se analizó este link?"), `GET /api/analisis/:id`,
  `PATCH /api/analisis/:id/temas` y la foto (`src/analysisRoutes.js`)
- Topes: `COMMENTS_LIMIT` y `COMMENTS_ANALYSIS_LIMIT` a 300 por defecto
  (configurables en el `.env`); la clasificación del tono va en tandas de
  100 comentarios por llamada al modelo y una llamada de síntesis arma los
  temas (con los comentarios de cada uno) y la lectura
- "Analizados N de M" con el número real: los que el modelo clasificó, de
  los que tiene la publicación
- "Cuándo comentaron" solo con al menos 10 comentarios con fecha y la
  fecha de la publicación
- La foto de la publicación sin ningún pedido nuevo a Apify
- `apify_calls.analisis_id`: el gasto de Apify atado a cada análisis
- Re-analizar no pisa el estado ni el geocodificado de los reclamos
- La solapa de la maqueta (`public/js/analysis.js` reescrito) y "Análisis
  recientes" en el inicio (`dashboard.js`)
- Un análisis real autorizado por el dueño para guardar un fixture
  anonimizado de los comentarios

### Out of Scope

- El análisis de X (`x.html`, `x-analysis.js`, `/api/x/analyze`): queda
  como está, salvo el arreglo del Enter doble y que sus reclamos tampoco
  pierdan la gestión al re-analizar
- El formato del informe institucional de 8 puntos (sigue igual)
- El arreglo de `src/geocode.js` (no aceptar (0,0)): PR chico después
- Backfills de análisis viejos: no quedaron guardados en ningún lado

## Approach

El trabajo pesado pasa al servidor: el pedido valida el link, crea la
fila y responde el id; el análisis corre aparte y deja cada paso en un
estado en memoria por id que la pantalla consulta cada segundo. Al
terminar todo queda en la fila: la pantalla, los recientes y el inicio
leen de ahí, sin volver a gastar. La clasificación se parte en tandas de
100 para no chocar con el tope de salida del modelo, y una llamada más
resume todo lo clasificado. La pantalla es un script clásico (prefijo
`ana`) que dibuja con nodos y SVG; todo dato entra por `textContent`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/db.js` | Modified | Tabla `analisis`, `apify_calls.analisis_id`, `upsertReclamo` con `conservarGestion` |
| `src/apify.js` | Modified | Publicación y comentarios con aviso propio; fecha, id, código y foto de la publicación; likes sin dato en null; topes 300 |
| `src/commentSample.js`, `src/prompt.js`, `src/analysisSchema.js`, `src/userPrompt.js`, `src/validateAnalysis.js`, `src/analyzeComments.js`, `src/reportBuilder.js`, `src/sentimentAggregate.js` | Modified | Tandas de 100, síntesis, conteo real, temas con conteo, tonos simples |
| `src/commentTimeline.js`, `src/analysisProgress.js`, `src/analysisJob.js`, `src/analysisRoutes.js` | New | "Cuándo comentaron", progreso, el trabajo y las rutas |
| `src/usageContext.js`, `src/apifyCost.js`, `src/concurrencyLimiter.js` | Modified | El id del análisis en cada llamada; aviso de espera de cupo |
| `server.js` | Modified | Las rutas nuevas; los análisis "en curso" de un arranque anterior pasan a "interrumpido" |
| `public/instagram.html`, `public/js/analysis.js` | Modified | La solapa de la maqueta |
| `public/dashboard.html`, `public/js/dashboard.js` | Modified | "Análisis recientes" |
| `public/js/monitoringFeedPopup.js`, `public/js/x-analysis.js` | Modified | La precarga; el Enter doble de X |
| `public/css/styles.css` | Modified | Bloque "Análisis de publicación de Instagram (diseño v4, fase E)", todo bajo `.ana4` |
| `test/*.test.js` | New | Tabla, tandas, síntesis, progreso, rutas, "Cuándo comentaron", el fixture |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Una tanda del modelo falla | Med | Se sigue con las demás; "analizados" cuenta solo lo clasificado y la pantalla lo dice |
| Gasto: 300 comentarios ≈ US$ 0,70 de Apify por análisis | Med | Aviso de "ya analizado" antes de gastar; el mismo link en curso no se repite; los topes se bajan en el `.env` |
| El proceso se cae a mitad de un análisis | Low | Al arrancar, los "en curso" pasan a "interrumpido"; la pantalla lo dice |
| Los comentarios no traen fecha | Med | "Cuándo comentaron" no aparece; nunca una curva inventada |
| Temas con índices que no existen | Med | Se validan contra la muestra; el conteo es de los válidos |

## Rollback Plan

Revertir el merge de la rama `analisis-v4`. La tabla `analisis` y la
columna `apify_calls.analisis_id` quedan en la base sin uso (no las lee
nada de antes). Los topes vuelven a 100 y 150 con el código de antes; un
`.env` que los fije sigue mandando.

## Success Criteria

- [ ] Un análisis se ve paso a paso con datos reales y queda guardado
- [ ] "Analizados N de M" coincide con los comentarios que clasificó el modelo
- [ ] Con 300 comentarios, tres tandas y una síntesis, sin chocar con el tope de salida
- [ ] "Cuándo comentaron" solo aparece con fechas
- [ ] Re-analizar conserva el estado y el geocodificado de los reclamos
- [ ] La solapa y el inicio se ven bien a 1366 y 375 px, en oscuro y con movimiento reducido
- [ ] Suite verde con `IG_ACTOR=apidojo` y `apify`
