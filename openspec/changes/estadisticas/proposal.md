# Proposal: estadisticas

## Intent

Fase C del rediseño v4 (`design/social-listening-v4.html`): la solapa
Estadísticas de Instagram, que hasta ahora estaba en la píldora con
"pronto". La maqueta la dibuja con datos de ejemplo calculados en el
navegador; acá los números salen de un endpoint nuevo que los cuenta en la
base, todos sobre el mismo período, y la pantalla solo los dibuja. Un clic
en una palabra o un tema lleva al Monitoreo con ese período y exactamente
esas publicaciones.

## Scope

### In Scope

- `GET /api/monitoring/stats?plataforma&desde&hasta` (`src/stats.js`,
  `src/statsRoutes.js`, `src/stopwords.js`): período en hora de Argentina y
  el anterior del mismo largo; resumen con tendencias, por día, lo habitual
  y los picos, por día y hora, palabras, menciones por término de búsqueda,
  tramos, temas, cuentas y ranking
- Lecturas nuevas en `src/db.js` (posteos del período con su motivo,
  ignorados, descartados por término, primer posteo, seguidores)
- `search_seen` se purga a los 100 días (era 30), para contar los
  descartados en períodos de hasta 90 días
- `temaSinDato` en `/api/monitoring/config`
- La solapa: período 7 / 30 / 90 o Desde → Hasta; cinco KPI; nube
  (Volumen / Positivos reales); menciones por búsqueda y dona; temas con
  badge; mapa de día y hora; tono neto por tramo; cuentas y ranking
- `public/js/kpi.js`: las tarjetas KPI salen del panel del Monitoreo para
  compartirlas
- El Monitoreo toma el período de Estadísticas como rango temporal al
  llegar por un clic, y filtra la palabra por los posteos que contó la nube
- `--muted` oscuro más claro (mismo tono) para pasar 4,5:1
- El pie: Estadísticas pasa a ser un enlace

### Out of Scope

- X: no tiene Estadísticas (el endpoint responde igual, sin alcance)
- Caché del endpoint (no hizo falta: ~50 ms con 30 días)
- Guardar el alcance o cualquier agregado en la base
- Inicio y login (fase D), análisis (fase E)
- Corridas reales, backfills, Apify o el LLM

## Approach

Una respuesta con todos los bloques, así todos muestran el mismo recorte.
El backend cuenta con funciones puras por bloque (testeables sin base) y
`armarEstadisticas` lee la base; el alcance se calcula al armar la
respuesta con la misma función del listado. La pantalla es un script
clásico más (`stats.js`, prefijo `stats`) que dibuja con nodos y SVG, todo
dato por `textContent`, y usa lo que ya existe (tooltip, pop-up, KPI,
`showInMonitoring`).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/stats.js`, `src/statsRoutes.js`, `src/stopwords.js` | New | El endpoint y sus bloques |
| `src/db.js` | Modified | Lecturas por período, ignorados, descartados, primer posteo, seguidores |
| `src/monitor.js` | Modified | `SEARCH_SEEN_TTL_DAYS` 100 |
| `server.js` | Modified | Monta la ruta; `temaSinDato` en la config |
| `public/instagram.html` | Modified | La píldora activa y el panel `#tab-stats` |
| `public/js/stats.js`, `public/js/kpi.js` | New | La solapa y las tarjetas KPI compartidas |
| `public/js/monitoring.js`, `monitoringPanel.js`, `monitoringFlow.js` | Modified | Rango temporal, filtro por palabra, tema sin dato, KPI de `kpi.js` |
| `public/js/main.js`, `public/js/footer.js` | Modified | Abre la solapa y le avisa; el enlace del pie |
| `public/css/styles.css` | Modified | Parte `04b-estadisticas` y `--muted` oscuro |
| `test/stats.test.js`, `test/searchEnrichment.test.js` | New / Modified | Bloques, endpoint y la purga |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Que Estadísticas y el Monitoreo den números distintos | Med | Misma regla del alcance; el clic lleva el período y los ids de la palabra; verificado con la base real (55 de 296; 24 temas y 60 palabras iguales) |
| La respuesta crece con los ids de las palabras | Low | ~90 KB con 30 días; sin caché hace falta poco |
| Comparaciones engañosas con el período anterior | Med | `*Anterior` en null sin datos ("sin datos", no 0); el período efectivo arranca en el primer día con datos |

## Rollback Plan

Revertir el merge de la rama `estadisticas`: el endpoint y la solapa son
nuevos, y lo que tocan del Monitoreo (rango, filtro por palabra, tema sin
dato) solo se activa desde Estadísticas o con "Coyuntura / Otros". La purga
de 100 días no borra nada que la de 30 no hubiera borrado.

## Success Criteria

- [x] El endpoint arma los bloques del período con la base real en ~50 ms
- [x] "Se despegaron" da lo mismo en el Monitoreo y en Estadísticas para el
      mismo período
- [x] Un clic en una palabra o un tema muestra en el Monitoreo el mismo
      número que la tarjeta
- [x] La solapa se ve bien a 1366 y 375 px, en oscuro y con movimiento
      reducido
- [x] Suite verde con `IG_ACTOR=apidojo` y `apify`
