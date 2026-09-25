# Design: clasificacion-contexto

## Technical Approach

`src/classifier.js` pasa a tener una sola función, `clasificarPosteo(caption,
{ platformLabel, pista })`, que le pide al modelo de análisis una respuesta
con schema (`relevant`, `title`, `sentiment`, `motivo`) vía
`llm.requestStructuredAnalysis`. `src/monitor.js` (`evaluateRelevance`) arma
la pista con cómo llegó el posteo y decide por lo que responde el modelo; el
resto del orquestador no cambia.

## Architecture Decisions

- **Structured outputs, no texto + regex.** Los dos proveedores ya
  implementan `requestStructuredAnalysis` con schema (es lo que usa el
  análisis de publicación). Se le agrega `maxTokens` opcional (default 8000,
  sin cambio para el análisis). JSON válido y enum de sentimiento
  garantizados; los dos intentos del proveedor ya existen.
- **La keyword es pista, no veredicto.** `evaluateRelevance` sigue buscando
  la coincidencia literal, pero la pasa como `pista.termino` en una línea
  `CONTEXTO:` del mensaje de usuario (junto con cuenta trackeada, hashtag o
  búsqueda). El system prompt queda fijo. El prompt dice que el término es
  una señal fuerte a favor y la cuenta trackeada una señal débil, y que
  ninguna garantiza relevancia.
- **Un modelo.** `providerConfig.js` deja de conocer la tarea `classifier`:
  `getAnalysisModel` es el único modelo y `requestText` (reclamos,
  importador) lo usa. `warnObsoleteModelVars()` avisa al arrancar si
  `CLASSIFIER_MODEL` u `OPENROUTER_CLASSIFIER_MODEL` siguen en el `.env`.
- **Fallos como hoy.** API caída, schema inválido o `relevant` no booleano
  → `{ relevant: true, title: null, sentiment: null, unclassified: true }`:
  el posteo se guarda "sin clasificar" con el motivo base más
  `— sin clasificar (falló el clasificador, relevancia sin verificar)`. Un
  `relevant: false` del modelo sí descarta: es una respuesta.
- **X en stand by.** `sourceType 'keyword'` (búsquedas por término de X)
  entra directo como antes: se usan título y sentimiento y se ignora
  `relevant`. Sin motivo en ese camino: el modelo no decidió nada ahí.
- **Trazabilidad.** `matched_reason` = motivo base de siempre + ` · <motivo>`.
  Un descarte se loguea `[clasificador] descartado (<red>) @cuenta <url>:
  <motivo>`. El backfill completa título, sentimiento y motivo; si el modelo
  dice que un posteo ya guardado no es relevante, no lo borra: deja el
  motivo con el prefijo `no relevante según el modelo:` y avisa.
- **Sin cambio de esquema.** Todo cabe en columnas existentes.

## Risks

- El modelo decide también sobre posteos con keyword literal: puede
  descartar alguno que antes entraba. Es el objetivo; el motivo queda en el
  log para auditarlo.
- Sonnet en reclamos e importador: más caro por token que Haiku; pocas
  llamadas, en lotes.
