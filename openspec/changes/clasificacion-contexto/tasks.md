# Tasks: clasificacion-contexto

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-CLC-*)

## Phase 1: una función, un modelo (cambio 1)

- [x] 1.1 `clasificarPosteo` en `src/classifier.js` con schema y pista de contexto (REQ-CLC-01, REQ-CLC-02, REQ-CLC-04)
- [x] 1.2 `maxTokens` en `requestStructuredAnalysis` (index, anthropic, openrouter); `requestText` con el modelo de análisis (REQ-CLC-03)
- [x] 1.3 `providerConfig.js` sin tarea `classifier`; `warnObsoleteModelVars` en `server.js`; `scripts/import-reclamos.js` (REQ-CLC-03)
- [x] 1.4 `evaluateRelevance` y `backfillClassification` en `src/monitor.js`; X sin cambios (REQ-CLC-02, REQ-CLC-04, REQ-CLC-06)
- [x] 1.5 `.env.example`; stubs de los tests existentes; `test/clasificarPosteo.test.js`

## Phase 2: prompt geográfico (cambio 2)

- [x] 2.1 System prompt con objetivo, términos ambiguos, señales a favor, señales de alerta, regla clave y descartes (REQ-CLC-05)
- [x] 2.2 Tests con captions de ejemplo (modelo stubeado)

## Phase 3: trazabilidad (cambio 3)

- [x] 3.1 `motivo` en el schema, en `matched_reason`, en el log de descartes y en el backfill (REQ-CLC-07)

## Phase 4: docs

- [x] 4.1 README y `CLAUDE.md`

## Pendiente (fuera del código)

- [ ] Reinicio de la app y merge cuando el dueño lo confirme
