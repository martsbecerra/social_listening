# Tasks: x-platform

## Phase 0: SDD

- [x] 0.1 `proposal.md`, `design.md`, `tasks.md`, spec (REQ-X-*)

## Phase 1: Análisis de publicación (implementar ahora)

- [x] 1.1 Tabla `x_influencers` + parser/merge de ambos CSV + script de import (REQ-X-05)
- [x] 1.2 `grokFetch` + normalización K/M + descarte QT→QT (REQ-X-02)
- [x] 1.3 Prompt/schema/KPIs/reportBuilder X + `POST /api/x/analyze` + reclamos `plataforma=x` (REQ-X-01, REQ-X-03, REQ-X-04, REQ-X-06)
- [x] 1.4 `public/x.html` + dashboard; tabs monitoreo/mapa próximamente (REQ-X-07)
- [x] 1.5 Tests, `.env.example`, README (REQ-X-08)

## Phase 2: Monitoreo en vivo (después)

- [ ] 2.1 Grok `x_search` por cuentas/keywords, cron 4 h
- [ ] 2.2 `plataforma` en `detected_posts`; UI Tabulator + ignorar + mail
- [ ] 2.3 `counts.x` en el dashboard

## Phase 3: Mapa de reclamos (después)

- [ ] 3.1 Solapa Leaflet filtrada `plataforma=x`
- [ ] 3.2 Filtro de plataforma en el mapa de Instagram (si hace falta no mezclar)
