# Proposal: x-platform

## Intent

Sumar la plataforma X al producto, con la misma interfaz que Instagram (tres solapas). El análisis de una publicación trae el hilo con Grok (`x_search` de xAI), no con Apify. El LLM clasifica; el código calcula KPIs, sentimiento y el reporte WhatsApp según la metodología de `data/X/Prompt Grok.txt`. Monitoreo en vivo y mapa de reclamos quedan especificados y se construyen después.

## Scope

### In Scope

- Página X (`public/x.html`) con las tres solapas y el chrome de Instagram
- Análisis de publicación: URL de X → Grok fetch → clasificación LLM → reporte + CSV
- Padrón ANTIK-PRO en SQLite, ingerido desde los dos CSV
- Reclamos geolocalizables guardados con `plataforma = 'x'` (el mapa X se implementa en una fase posterior)
- OpenSpec (este cambio) y tests de parseo, KPIs y URLs

### Out of Scope (esta implementación)

- Monitoreo en vivo de X (cron, Tabulator, mail, `detected_posts` con plataforma)
- Solapa mapa de reclamos de X (Leaflet + filtro `plataforma=x`)
- Apify / Twitter API oficial como fuente
- Cambiar Instagram (umbrales, prompt, `/api/analyze`)
- Que Grok escriba el texto final del reporte

## Capabilities

### New Capabilities

- `x-platform`: página, análisis de publicación y padrón de actores de X

### Modified Capabilities

- Dashboard: la tarjeta X deja de ser un placeholder
- Tabla `reclamos`: empieza a recibir filas de análisis X (el mapa de Instagram no filtra por plataforma hoy; ver design)

## Approach

1. Fetch: xAI Responses API + tool `x_search`.
2. Clasificación: `LLM_PROVIDER` actual, schema X (no el de Instagram).
3. Reporte: código (`src/x/kpis.js` + `src/x/reportBuilder.js`) con la plantilla del Prompt Grok.
4. Actores: merge de ambos CSV → `x_influencers`.
5. UI: clonar solapas de Instagram; monitoreo y mapa muestran “Próximamente”.

## Affected Areas

- `openspec/changes/x-platform/` — este SDD
- `src/x/` — fetch, prompt, schema, KPIs, reporte, influyentes
- `src/db.js` — tabla `x_influencers`
- `src/llm/` — schema opcional en structured output
- `server.js` — `POST /api/x/analyze`
- `public/x.html`, `public/js/x-analysis.js`, `public/dashboard.html`
- `config/x-influencers/` — CSV canónicos
- `.env.example`, `README.md`, `test/`

## Risks

- `x_search` no es un scrape exhaustivo: el reporte declara muestra parcial y no inventa métricas.
- Costo xAI por tool calls: un fetch por request, usage en logs.
- El padrón es solo ANTIK-PRO: insights de oposición salen del LLM hasta que exista otra lista.
- El mapa de Instagram lista todos los reclamos; al analizar X pueden aparecer puntos nuevos ahí. Aceptable hasta la fase del mapa X (filtro por plataforma).

## Rollback Plan

Revertir el cambio de código. La tabla `x_influencers` y filas `reclamos` con `plataforma = 'x'` pueden quedar (aditivas).

## Dependencies

- `OPENROUTER_API_KEY` para el fetch de X (Grok); `XAI_API_KEY` solo como respaldo. No aborta el arranque si ambas faltan (Instagram sigue). El 502 de `/api/x/analyze` explica la falta.
- `LLM_PROVIDER` ya existente para clasificar

## Success Criteria

- [ ] Pegar un link `x.com/.../status/id` genera un reporte con la plantilla X
- [ ] No se usa Apify en ese flujo
- [ ] KPIs, % de sentimiento (+5%) y Top 6 se calculan en código
- [ ] Los dos CSV quedan mergeados en SQLite
- [ ] Instagram sigue igual
- [ ] Solapas monitoreo/mapa de X dicen próximamente
