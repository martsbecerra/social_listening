# Tasks: x-ig-style

Implementación en fases. 1–3 primero (análisis / geo / mapa). 4 después (monitoreo).

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-TEMAS-*, REQ-GEO-*, REQ-MAP-*, REQ-MON-*)
- [x] 0.2 Decisiones cerradas con el usuario (temas suman, ambas plataformas, edición solo temas, mapas filtrados, config X propia, geo alineada, plantilla X conservada)

## Phase 1: Temas emergentes (IG + X) — implementar primero

- [ ] 1.1 Schema + prompt + validate de Instagram (`temasConversacion`, 0–8)
- [ ] 1.2 Schema + prompt + validate de X (mismo contrato)
- [ ] 1.3 `reportBuilder` IG y X: sección entre 2️⃣ y 3️⃣; omitir si vacío; devolver `temas` + `reportParts`
- [ ] 1.4 JSON de `/api/analyze` y `/api/x/analyze` incluye `temas` y `reportParts`
- [ ] 1.5 Front IG y X: editor solo de temas (editar / agregar / quitar, máx. 8); Copiar y WhatsApp reconstruyen el string
- [ ] 1.6 Tests de validate, omisión de sección vacía y roundtrip `before + temas + after`

## Phase 2: Geo de X alineada a Instagram — implementar primero

- [ ] 2.1 Prompt X: regla accionable + categorías desde `categorias-reclamos.json` (sacar las 9 viejas)
- [ ] 2.2 Schema / validate X: `direccionNormalizada`, `tipoUbicacion`, enum de categorías del config
- [ ] 2.3 `reclamosFromAnalysis` X: `precision`, `subcategoria`; `analyze.js` llama `asignarSubcategorias`
- [ ] 2.4 Tests: barrio solo no upserta; calle+altura sí; categoría inválida cae al fallback

## Phase 3: Mapas por plataforma — implementar primero

- [ ] 3.1 `listReclamosFiltered` / `contarReclamosPorCategoria` / export CSV filtran por `plataforma`; GET sin plataforma → 400
- [ ] 3.2 `claimsMap.js` lee `data-platform` y lo manda en cada fetch
- [ ] 3.3 `instagram.html`: `data-platform="instagram"` (el mapa deja de mezclar X)
- [ ] 3.4 `x.html`: solapa mapa real (Leaflet + markup), sin “Próximamente”
- [ ] 3.5 Tests de filtro y 400

## Phase 4: Monitoreo en vivo de X — después

- [ ] 4.1 `detected_posts.plataforma` (filas existentes = instagram); list/count/ignore filtrados
- [ ] 4.2 `config/monitoring-x.json` + endpoints de config/posts/run-now con `plataforma`
- [ ] 4.3 Ciclo Grok `x_search` (cuentas y keywords); no Apify; tope por corrida
- [ ] 4.4 `x.html`: solapa monitoreo real; `monitoring.js` parametrizado; columnas X (RTs/vistas) si aplican
- [ ] 4.5 Cron: IG y luego X en el mismo `runCycle`; run-now X solo X; sin mails
- [ ] 4.6 Dashboard `counts.x`
- [ ] 4.7 Tests de namespace, no-mezcla de configs y counts

## Phase 5: Cierre

- [ ] 5.1 README: temas editables, mapas por plataforma, monitoreo X
- [ ] 5.2 `.env.example` si aparece tope de Grok del monitor
