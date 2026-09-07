# Proposal: x-ig-style

## Intent

Acercar X al producto de Instagram en sus tres solapas, y sumar un bloque de **temas emergentes** en el análisis de publicación (X e Instagram). El analista puede editar solo esos temas antes de copiar/WhatsApp. Monitoreo y mapa de X dejan de ser “próximamente”: el mapa reusa Leaflet filtrado por plataforma; el monitoreo usa Grok y config propia.

Este cambio continúa y reemplaza las fases 2 y 3 de `openspec/changes/x-platform` (monitoreo y mapa). La fase 1 de X (análisis Grok + plantilla Prompt Grok) queda; no se unifica el WhatsApp de X con el de Instagram.

## Scope

### In Scope

- Temas emergentes (título + 1–2 oraciones) en el análisis de **X e Instagram**, sección propia entre sentimiento/KPI (1–2) y buckets de actores (3–8)
- Edición en pantalla **solo de esos temas**; el resto del reporte no se toca; no se persiste
- Alinear geo de X a Instagram: dirección accionable, `tipoUbicacion`, 26 categorías del cliente + subcategoría
- Solapa mapa de X con Leaflet, `GET /api/reclamos?plataforma=x`
- Mapa de Instagram filtrado a `plataforma=instagram` (deja de mezclar puntos de X)
- Monitoreo en vivo de X: misma UI que Instagram, fuente Grok `x_search`, cuentas/keywords **propias**
- Columna `plataforma` en `detected_posts`; `counts.x` en el dashboard
- OpenSpec (este cambio) y tests de temas, geo X, filtro de mapa y monitoreo namespaced

### Out of Scope

- Unificar la plantilla WhatsApp de X con la de Instagram (se conservan RTs, QTs, guardados, KPIs separados, Top 6)
- Editar el reporte entero, ni guardar el texto final en DB
- Reemplazar los buckets 3–8 (apoyo / oposición / vecinos / medios / etc.)
- Apify o Twitter API oficial como fuente de X
- Que Grok (o Claude) escriba el WhatsApp final
- Config compartida de cuentas/keywords entre IG y X
- Mails de alerta de monitoreo (Instagram ya no los manda; X tampoco)
- Facebook / TikTok
- UI para listar o deshacer ignorados

## Capabilities

### New Capabilities

- `thematic-insights`: temas emergentes en el análisis, editables, no persistidos
- `x-live-monitoring`: monitoreo en vivo de X al estilo Instagram

### Modified Capabilities

- `x-platform`: geo alineada a Instagram; mapa de X; tabs dejan de ser placeholders
- Mapa de reclamos: filtro obligatorio por `plataforma`
- Dashboard: `counts.x` deja de ser “Sin datos todavía” cuando haya detecciones

## Approach

1. Schema + prompt de análisis (IG y X): array `temasConversacion` `{ titulo, texto }`, 0–8 ítems. El `reportBuilder` inserta la sección entre 2 y 3. El front parte el reporte y deja editar solo esa sección.
2. Prompt/schema/reclamos de X copian la regla de dirección accionable, `tipoUbicacion` y el árbol de `config/categorias-reclamos.json`. Segundo paso `asignarSubcategorias` como en Instagram.
3. `claimsMap.js` y `GET /api/reclamos` reciben `plataforma`. `x.html` monta la misma solapa.
4. `detected_posts.plataforma`, `config/monitoring-x.json`, ciclo Grok, UI parametrizada. Se implementa **después** de análisis/geo/mapa.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/analysisSchema.js`, `src/prompt.js`, `src/reportBuilder.js`, `src/validateAnalysis.js` | Modified | Temas emergentes en Instagram |
| `src/x/analysisSchema.js`, `src/x/prompt.js`, `src/x/reportBuilder.js`, `src/x/validate.js` | Modified | Temas + geo alineada |
| `src/x/reclamosFromAnalysis.js`, `src/x/analyze.js` | Modified | `tipoUbicacion`, subcategoría |
| `public/js/analysis.js`, `public/js/x-analysis.js` | Modified | Sección de temas editable |
| `public/x.html` | Modified | Mapa y monitoreo reales (dejan “próximamente”) |
| `public/js/claimsMap.js`, `src/db.js`, `server.js` | Modified | Filtro `plataforma` |
| `src/monitor.js` / nuevo `src/x/monitor.js` | New/Modified | Ciclo X con Grok |
| `config/monitoring-x.json` | New | Cuentas y keywords de X |
| `public/js/monitoring.js`, `public/js/dashboard.js` | Modified | Plataforma + counts.x |
| `test/` | New/Modified | Temas, geo X, mapa, monitoreo |
| `openspec/changes/x-platform/` | Unchanged | Este SDD lo sucede para fases 2–3; no se reescribe |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Temas inventados o que duplican los buckets 3–8 | Med | Prompt: solo evidencia del hilo; 0 ítems válido; no citar @ ni roles |
| Editar temas desincroniza el string de Copiar/WhatsApp | Med | El front reconstruye el reporte al copiar; no se edita el `<pre>` entero |
| Geo estricta de X baja la cantidad de pines | Med | Aceptable: un barrio suelto ensucia el mapa. Misma regla que IG |
| `x_search` no es scrape exhaustivo | High | UI declara muestra / cobertura parcial; no fingir paridad con Apify |
| Mezclar puntos X en el mapa IG hasta el filtro | Low | El filtro `plataforma` es requisito de la fase mapa, no opcional |
| Ciclo X + ciclo IG en el mismo cron se pisan | Med | Un `cycleInProgress` compartido; X corre en serie después de IG o en el mismo `runCycle` |
| Costo Grok del monitor (cuentas × keywords × 4 h) | Med | Tope de resultados por corrida; config corta al inicio |

## Rollback Plan

Revertir el código. Columnas aditivas (`detected_posts.plataforma`, campos geo de X) pueden quedar. Filas `reclamos` con `plataforma=x` y `monitoring-x.json` son aditivas. Instagram vuelve a listar todos los reclamos solo si se revierte el filtro (no es el default deseado).

## Dependencies

- `OPENROUTER_API_KEY` (Grok) para fetch/clasificación/monitor de X. Instagram sigue en `LLM_PROVIDER`.
- `asignarSubcategorias` reusa el LLM de Instagram (`LLM_PROVIDER`): es taxonomía, no voz del reporte.
- Leaflet / Tabulator ya están en Instagram; X los carga en las solapas que correspondan.

## Success Criteria

- [ ] Un análisis de IG o X incluye “TEMAS DE LA CONVERSACIÓN” entre 1–2 y 3–8 cuando hay evidencia; si no hay, se omite la sección
- [ ] El analista edita título/texto de un tema y Copiar/WhatsApp reflejan el texto editado; el resto del reporte no es editable
- [ ] Los buckets 3–8, métricas X y Top 6 siguen iguales
- [ ] Un reclamo de X con solo “en Palermo” no entra al mapa; uno con “Salta 250” sí, con categoría/subcategoría del árbol del cliente
- [ ] El mapa de X muestra solo X; el de Instagram solo Instagram
- [ ] El monitoreo de X tiene cuentas/keywords propias y no lee `config/monitoring.json`
- [ ] Instagram `/api/analyze`, umbrales y plantilla (salvo el bloque de temas) no cambian de comportamiento
