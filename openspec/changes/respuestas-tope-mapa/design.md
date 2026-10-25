# Design: respuestas-tope-mapa

## La sonda (25/10/2026, autorizada, US$ 0,0368)

`apify/instagram-comment-scraper` con `includeNestedComments` y
`resultsLimit` 10 sobre la publicación de la corrida de la fase F:

- 16 ítems: 10 comentarios de primer nivel y 6 respuestas. **El tope cuenta
  solo los de primer nivel**; las respuestas llegan aparte.
- Cada respuesta es un ítem propio con `parentCommentUrl`
  (`…/c/<id del padre>/`) y un `commentUrl` que termina en `/r/…`. El padre
  trae `repliesCount` (las que declara Instagram); `replies` viene siempre
  null.
- **No llegan todas**: los tres padres declaraban 8, 1 y 1 respuestas y
  llegaron 6, todas del primero.
- El orden de los de primer nivel no es por fecha (el otro actor los traía
  del más nuevo al más viejo).

## Respuestas

1. `fetchAnalysisComments` corre `apify~instagram-comment-scraper` con
   `{ directUrls, resultsLimit, includeNestedComments: true }` por
   `runActorSync` (flujo asincrónico: id del run y costo real), con un
   tiempo de espera propio (`ANALISIS_COMMENTS_TIMEOUT_MS`, 30 min).
2. `normalizeComments` le pone a cada ítem `parentApifyId` (el id del padre,
   de `parentCommentUrl`), `esRespuesta` y `respuestasDeclaradas`
   (`repliesCount`).
3. Los comentarios de la propia cuenta (el usuario es el dueño de la
   publicación) no van al modelo ni ocupan el tope: se guardan con
   `deLaCuenta: true` y sin tono. El resto va en las tandas como cualquier
   comentario; cada respuesta, detrás de su comentario (las de uno mismo,
   de la más vieja a la más nueva) y con la línea `N. @usuario ↳ responde
   a @padre: «principio del comentario de arriba»` (hasta 140 caracteres;
   "(la cuenta que publicó)" si responde a la cuenta). No va el número del
   padre: la tanda numera solo su lista, y el de arriba puede estar en
   otra. El prompt suma la regla E (se clasifica la respuesta; si solo le
   da la razón, lleva el tono y la postura de lo que respalda; la
   @mención del principio no es una etiqueta). El schema no cambia. Dos
   respuestas iguales a comentarios distintos ("¡Gracias!") no se toman
   como repetidas.
4. Cada comentario guardado suma `respondeA` (el número del padre, o null),
   `respondeAUsuario`, `esRespuesta`, `deLaCuenta` y
   `respuestasDeclaradas`. `resultado.respuestas: true` marca un análisis
   con respuestas.
5. Al leer (`analysisMetrics.js`): las de la cuenta quedan fuera de tono,
   postura, temas, "hablan del posteo", ruido y "sin clasificar"; `debates`
   son los 6 comentarios con más respuestas traídas (con el tono de sus
   respuestas); `laCuentaRespondio` dice a cuántos comentarios contestó la
   cuenta y cuáles. Una respuesta que empieza con "@usuario" (la mención de
   Instagram al responder) no cuenta esa mención en "A quién etiquetan".
   Un análisis sin respuestas (antes de la G) los trae como no disponibles.
6. "Analizados N de M": N, los comentarios y respuestas clasificados; M, el
   total de Instagram (que cuenta las respuestas).

## Tope y confirmación

- `COMMENTS_LIMIT` y `COMMENTS_ANALYSIS_LIMIT` valen 3.000 (tope 5.000).
  Cuentan ítems: comentarios más respuestas.
- El trabajo trae primero la publicación (una corrida). Con el número de
  Instagram N:
  - N = 0: "sin comentarios", sin la segunda corrida;
  - N ≤ `ANALISIS_CONFIRMAR_DESDE` (1.000) o sin el número: directo;
  - N > 1.000: el paso "Esperando confirmación" (en memoria, con la
    publicación ya guardada en la fila) muestra el costo estimado de cada
    opción. `POST /api/analyze/:id/confirmar { alcance: 'todo' | '1000' }`
    sigue con esa publicación; `{ alcance: 'cancelar' }` lo termina. A los
    30 min sin respuesta, o con un reinicio, queda "sin confirmar" /
    "interrumpido".
- Al actor se le pide, para un tope de T ítems: todo lo de la publicación si
  N ≤ T (`resultsLimit` = N, que no es menos que los de primer nivel), y si
  no, `resultsLimit` = T / `ANALISIS_FACTOR_RESPUESTAS` (1,6, de la sonda),
  para que comentarios más respuestas den unos T.
- Costo estimado (`src/analysisCost.js`, puro): ítems × 0,0023 (la tarifa
  de Apify del plan) + ítems × `ANALISIS_USD_POR_COMENTARIO` (0,0021) +
  `ANALISIS_USD_FIJO` (0,06), de lo medido en la repetición del 24/10
  (tres tandas de 50: US$ 0,305; síntesis: US$ 0,048).

## Login

En "Revisá tu correo", un enlace "Abrir Gmail" (u Outlook, Yahoo, iCloud,
Proton) según el dominio del correo, en otra pestaña. Otro dominio: sin
botón.

## Mapa de reclamos

- Capas `https://mt{0-3}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}` (mapa) y
  `lyrs=s` (satélite) con un selector Mapa / Satélite (recordado en
  `localStorage`, `sl.mapa.capa`). Si los mosaicos de Google fallan (los
  primeros no cargan o se juntan errores), el mapa pasa solo a
  OpenStreetMap y lo dice; el selector se apaga.
- El estado de cada reclamo sale del pop-up (el selector y su PATCH) y el
  filtro "Estado" sale de los filtros, en `instagram.html` y `x.html` (el
  mismo componente). La API y la columna no cambian.

## Testing Strategy

| Capa | Qué | Cómo |
|------|-----|------|
| Apify | El input del actor, las respuestas con su padre, el tiempo de espera, la tarifa | `test/analisisApify.test.js`, fetch simulado; fixture de la sonda, anonimizado |
| Costo | Las estimaciones | `test/analisisCosto.test.js`, puro |
| Trabajo | Directo, la espera, confirmar, cancelar, vencer, sin comentarios | `test/analisisTrabajo.test.js` |
| Modelo | Las respuestas en la tanda, las de la cuenta afuera | `test/analisisModelo.test.js` |
| Métricas | Debates, la cuenta, tono sin la cuenta, etiquetas | `test/analisisMetricas.test.js` |
