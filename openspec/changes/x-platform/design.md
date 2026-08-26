# Design: x-platform

## Technical Approach

Instagram ya separó scrape (Apify) de clasificación (LLM structured) y de métricas (código). X copia ese corte, cambiando solo la fuente: Grok con X Search (OpenRouter, o xAI directo).

Grok **no** redacta el WhatsApp. El Prompt Grok se parte en: (1) instrucciones de fetch, (2) system prompt de clasificación, (3) fórmulas y plantilla en código.

## Architecture Decisions

- **Fetch y clasificación de X = Grok vía OpenRouter.** Misma `OPENROUTER_API_KEY`, modelo `OPENROUTER_X_MODEL` (default `x-ai/grok-4.6`). El fetch usa `openrouter:web_search` (X Search nativo). La clasificación fuerza `provider: 'openrouter'` + ese modelo y no lee `LLM_PROVIDER` / `CLAUDE_MODEL` / `OPENROUTER_MODEL`. Instagram no se toca. Respaldo de fetch: `XAI_API_KEY` + `x_search` si no hay clave de OpenRouter. Si Grok no soporta `json_schema`, se reintenta con `json_object`.
- **Schema opcional** en `requestStructuredAnalysis`. Default = Instagram. X pasa el suyo. Evita duplicar proveedores.
- **`OPENROUTER_API_KEY` no aborta el boot por X.** Instagram tiene que seguir levantando. El 502 de `/api/x/analyze` explica si no hay ni OpenRouter ni `XAI_API_KEY`.
- **Padrón en SQLite, no JSON.** El usuario pidió ingerir los dos CSV y guardarlos en DB. `lista` deja lugar a oposición/periodistas después.
- **Handle ANTIK-PRO → `accountType` oficial (Wc 2.5).** Cruce de identidad del prompt. `con_identidad` solo prioriza links de insights.
- **KPIs X no reusan `sentimentAggregate.js`.** Umbrales y el +5% son distintos; Instagram no se toca.
- **Monitoreo/mapa: UI “próximamente”, spec de fase 2/3.** `detected_posts` todavía no tiene `plataforma`; se agrega cuando se implemente el monitor.

## Data Flow

```
URL X
  → validar x.com|twitter.com /status/{id}
  → grokFetch (x_search) → JSON { post, items }
  → parse K/M, tirar QT cuyo quotedId ≠ post.id
  → sample (tope COMMENTS_ANALYSIS_LIMIT, prioriza RTs + padrón)
  → Grok structured vía OpenRouter (sentiment, accountType, reclamosGeo, insights 3–8)
  → forzar oficial si handle está en x_influencers
  → KPIs independientes (vistas vs interacciones) + sentimiento +5%
  → Top 6 pos/neg por RTs (código; el original puede entrar)
  → WhatsApp + CSV X
  → upsertReclamo plataforma=x
```

## Fetch contract (Grok)

Preferencia: OpenRouter Chat Completions (`OPENROUTER_API_KEY`)

- model: `OPENROUTER_X_MODEL` o `XAI_MODEL` o `x-ai/grok-4.6`
- tools: `[{ type: "openrouter:web_search" }]` (en Grok esto activa X Search nativo)

Respaldo: POST `https://api.x.ai/v1/responses` si no hay clave de OpenRouter

- model: `XAI_MODEL` o `grok-4.6`
- tools: `[{ type: "x_search" }]`
- input: pedir JSON del hilo (post + replies + QTs), no el reporte

Post-proceso: enteros, descarte QT→QT, 422 si faltan métricas del post.

## Influencers merge

1. Parsear `config/x-influencers/antik-pro.csv` (números enteros).
2. Parsear `antik-pro-extra.csv` (`Mil` / `millones`).
3. Unión por handle normalizado. Preferir seguidores del archivo numérico.
4. `163,2 Mil` = 163200 (Mil nunca es millón).

## Report template

Plantilla de Prompt Grok: Likes, RTs, QTs, Respuestas, Guardados, visualizaciones, insights 1–8, Top 6. CSV: `Direccion_o_Ubicacion,Tematica,Link_Comentario,Usuario_Perfil`. Insights 3–8 vacíos → `Sin registros en esta categoría`. Insight 7 sin el prefijo de audiencia orgánica.

## Phase 2 — Monitoreo (no implementar ahora)

Misma UI que Instagram. Fuente Grok `x_search`. Config aparte o namespaced. Columna `plataforma` en `detected_posts`. Counts dashboard `counts.x`.

## Phase 3 — Mapa (no implementar ahora)

Reusar Leaflet. `GET /api/reclamos?plataforma=x`. Las filas ya se escriben en fase 1.

## Test Plan

- Parse/merge CSV (Mil vs millones, handles rotos, dedupe)
- KPIs y +5%
- Descarte QT→QT
- Top 6 y “Sin registros…”
- URL X
- `upsertReclamo` con `plataforma=x`

## Open Questions

Ninguna. Decisiones validadas con el usuario (alcance, pipeline, padrón en DB, monitoreo después).
