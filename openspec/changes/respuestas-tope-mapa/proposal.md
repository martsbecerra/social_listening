# Proposal: respuestas-tope-mapa

## Intent

Fase G. El análisis de publicación de Instagram suma las respuestas a los
comentarios (los debates y si la cuenta contestó) y deja de cortar en 300:
analiza hasta 3.000 y, cuando la publicación tiene más de 1.000, pide
confirmación con el costo estimado antes de gastar. Además, cuatro cambios
chicos de pantalla: "Abrir Gmail" en el login, los mosaicos de Google en el
Mapa de reclamos (con respaldo en OpenStreetMap) y el estado de los
reclamos fuera de la pantalla. El (0,0) de USIG y el reintento de los
reclamos sin punto fueron un PR aparte, antes (#31).

## Scope

### In Scope

- Comentarios con `apify/instagram-comment-scraper` e
  `includeNestedComments` (el único actor con respuestas; mismo precio por
  resultado). Cada respuesta se guarda con su comentario padre y se
  clasifica igual que un comentario, marcada como respuesta. Las de la
  propia cuenta no van al modelo: solo en "¿La cuenta respondió?".
- Pantalla: "Más likes / Más respuestas" en "Los que más pegaron", la
  tarjeta "¿La cuenta respondió?" debajo de "Verificados y figuras", "↳
  responde a @usuario" y el filtro "Respuestas" en la lista; en el informe,
  dentro de "Quién habló".
- `COMMENTS_LIMIT` y `COMMENTS_ANALYSIS_LIMIT` en 3.000. Hasta 1.000
  (según Instagram) analiza directo; con más, la pantalla pide
  confirmación con el costo estimado ("Analizar todo" o "Analizar 3.000",
  y "Analizar 1.000"). La publicación se trae una sola vez.
- Login: un botón al webmail del dominio del correo en "Revisá tu correo".
- Mapa de reclamos (Instagram y X, el mismo componente): mosaicos de
  Google con Mapa / Satélite; si no cargan, OpenStreetMap solo.
- El estado de los reclamos sale del pop-up y de los filtros (la columna y
  la API quedan).

### Out of Scope

- X (su análisis, su monitoreo y su informe).
- Borrar o migrar la columna `estado` de `reclamos`.

## Approach

Ver `design.md`.

## Affected Areas

| Archivo | Impacto | Descripción |
|---------|---------|-------------|
| `src/apify.js`, `src/apifyCost.js` | Modified | El actor de comentarios, las respuestas, los topes, el tiempo de espera largo, la tarifa |
| `src/analysisCost.js` | New | El costo estimado de un análisis |
| `src/analysisJob.js`, `src/analysisProgress.js`, `src/analysisRoutes.js` | Modified | Publicación primero, la confirmación, el paso nuevo |
| `src/analyzeComments.js`, `src/userPrompt.js`, `src/prompt.js`, `src/commentSample.js` | Modified | Las respuestas en la tanda, las de la cuenta afuera |
| `src/analysisMetrics.js`, `src/reportBuilder.js` | Modified | Debates, "¿La cuenta respondió?", informe y CSV |
| `public/js/analysis*.js`, `public/instagram.html`, `public/css/styles.css` | Modified | La confirmación, los bloques nuevos |
| `public/index.html`, `public/js/login.js` | Modified | El botón al webmail |
| `public/js/claimsMap.js`, `public/x.html` | Modified | Mosaicos de Google con respaldo; sin estado |
| `test/` | Modified/New | Respuestas, costo, confirmación, métricas |

## Risks

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| El actor no trae todas las respuestas | Pasó (sonda: 6 de 10) | "Analizados N de M" dice lo que llegó; la pantalla no promete el total |
| El tope no cuenta las respuestas | Pasó (sonda: 10 + 6) | Se le pide el tope dividido por un factor de respuestas (1,6, configurable) |
| Una publicación grande tarda más de 5 min en Apify | Alta con 3.000 | Tiempo de espera propio de 30 min para los comentarios |
| Google corta los mosaicos (no se usan por su API) | Media | Respaldo automático en OpenStreetMap |

## Rollback Plan

Revertir el merge. Los análisis guardados con respuestas se siguen
abriendo con la versión anterior (las respuestas cuentan como comentarios).
