# Design: x-ig-style

## Technical Approach

Cuatro cortes, en este orden de implementación:

1. **Temas emergentes** en el JSON de clasificación (IG y X) + sección editable en el front.
2. **Geo de X = geo de Instagram** (prompt, schema, `tipoUbicacion`, subcategoría).
3. **Mapa de X** reusando Leaflet; filtro `plataforma` en API y en el mapa de IG.
4. **Monitoreo de X** (después): misma UI, Grok, config namespaced.

Grok sigue sin redactar el WhatsApp. Los temas salen del structured output; el código los formatea; el humano puede retocar solo esa sección.

## Architecture Decisions

- **Temas suman, no reemplazan.** 1–2 (sentimiento/KPI) y 3–8 (buckets de actores) no se renumeran. Nueva sección entre 2 y 3.
- **Las dos plataformas.** Mismo contrato `{ titulo, texto }[]` en ambos schemas. El prompt pide 3–8 si hay evidencia, 0 si no; máximo 8; prohibido inventar y prohibido copiar el estilo de los buckets (`@usuario — cita`).
- **Edición solo de temas, sin persistir.** El backend devuelve el reporte partido (`beforeTemas`, `afterTemas`) más `temas[]`. El front renderiza dos `<pre>` (o equivalentes) no editables y un bloque de inputs. Copiar / WhatsApp concatenan `before + formatTemas(editados) + after`. F5 pierde los retoques.
- **Plantilla X intacta salvo el inserto.** Likes, RTs, QTs, respuestas, guardados, vistas, KPIs separados, buckets 3–8, Top 6 se quedan. Instagram igual, más el inserto.
- **Geo X estricta.** Copiar de `src/prompt.js` la regla de ubicación accionable (`calle_altura` / `cruce` / `tramo` / `lugar_nombrado`). Barrio/comuna solos → `reclamosGeo []`. Categorías inyectadas desde `config/categorias-reclamos.json`. Paso 2: `asignarSubcategorias` (usa `LLM_PROVIDER`, no Grok).
- **Mapas separados por plataforma.** `GET /api/reclamos?plataforma=instagram|x` obligatorio desde cada solapa. `contarReclamosPorCategoria` también filtra, para que los 12 colores no se contaminen. Sin query de plataforma: 400 (no volver al “listar todo”).
- **Config de monitoreo de X propia.** `config/monitoring-x.json` `{ accounts, keywords }`. No seedea desde Instagram. Endpoints existentes aceptan `plataforma` (default `instagram` para no romper el front actual).
- **`detected_posts.plataforma`.** Filas actuales = `instagram`. Unique de `url` se mantiene (las URLs de X e IG no colisionan). `listDetectedPosts` / `countRecentPosts` filtran por plataforma.
- **Mails:** no. Instagram ya no notifica por mail; X tampoco.
- **Cron:** un solo `runCycle`. Primero IG (Apify, como hoy), después X (Grok). Mismo `cycleInProgress`. Si X falla, IG no se revierte.
- **Este SDD sucede las fases 2–3 de `x-platform`.** No se reescribe ese folder.

## Data Flow

### Análisis (IG y X) + temas

```
URL
  → scrape / grokFetch (sin cambio de fuente)
  → sample
  → LLM structured (schema + temasConversacion[])
  → validate (temas: 0–8, titulo+texto no vacíos, recortar a 8)
  → [X] geo estricta + asignarSubcategorias + upsertReclamo
  → [IG] igual que hoy + temas en el reporte
  → reportParts { beforeTemas, afterTemas, temas }
  → front: pre | editor de temas | pre
  → Copiar/WA: string reconstruido
```

### Mapa

```
x.html data-platform=x  →  GET /api/reclamos?plataforma=x
instagram.html data-platform=instagram  →  GET /api/reclamos?plataforma=instagram
```

### Monitoreo X (fase posterior)

```
cron / “Actualizar ahora”
  → runMonitoringCycle() IG
  → runXMonitoringCycle()
       Grok x_search por cuenta y por keyword
       normalizar posts
       skip si url conocida (cualquier plataforma)
       clasificar título/sentimiento (Grok o classifier; ver abajo)
       insert detected_posts plataforma=x
  → geoWorker (igual)
  → dashboard counts.x = countRecentPosts(7, 'x')
```

Clasificación de relevancia/título del monitor X: Grok structured, no Apify y no `LLM_PROVIDER`, para no mezclar el pipeline. Si el costo duele, se puede caer a Haiku en un follow-up; no es el default.

## Temas: contrato

```json
"temasConversacion": {
  "type": "array",
  "maxItems": 8,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "titulo": { "type": "string" },
      "texto": { "type": "string" }
    },
    "required": ["titulo", "texto"]
  }
}
```

Prompt (las dos plataformas):

- Agrupar quejas/apoyos **recurrentes** del hilo, no un tema por comentario.
- `titulo`: 2–6 palabras, sin número, sin markdown.
- `texto`: 1–2 oraciones, tono de informe, sin `@`, sin URLs, sin “el usuario dijo”.
- 3–8 si el hilo da; menos está bien; 0 si no hay patrón real.
- No repetir el `posteoSobre` ni los buckets 3–8.

WhatsApp (sin markdown; WhatsApp no renderiza `**`):

```
🗣️ TEMAS DE LA CONVERSACIÓN

1. Uso excesivo del celular: Muchas quejas de vecinos que observan a los policías distraídos con sus teléfonos…

2. Represión y violencia institucional: Fuertes críticas y acusaciones de que la policía se utiliza para reprimir…
```

Si `temas.length === 0` y el analista no agregó ninguno: se omite el título de sección y las líneas en blanco extra. Si el analista borra todos, igual.

UI del editor:

- Una fila por tema: input título, textarea texto, botón quitar.
- “Agregar tema” hasta 8.
- Vacío de entrada + 0 del modelo: se muestra el bloque vacío con CTA “Agregar tema” (para redactar a mano).
- No hay Guardar; no hay endpoint PATCH.

`buildWhatsAppReport` expone:

```js
{
  report,          // string completo con temas generados (fallback / tests)
  csv,
  meta,
  temas,           // [{ titulo, texto }]
  reportParts: { beforeTemas, afterTemas }
}
```

El JSON al browser incluye `temas` y `reportParts`. `report` se sigue mandando por si un cliente viejo solo lee el string.

## Geo X alineada

Hoy el prompt de X lista 9 categorías viejas y acepta barrio; el schema ya pide las 26. Eso se corrige.

Cambios:

- `src/x/prompt.js`: copiar el bloque 3 de `src/prompt.js` (accionable / no accionable / `tipoUbicacion` / categorías inyectadas).
- `src/x/analysisSchema.js`: `RECLAMO_GEO_SCHEMA` = el de Instagram (`direccionNormalizada`, `tipoUbicacion`, `listCategorias()`).
- `src/x/validate.js`: sanitizar igual que `validateAnalysis.js`.
- `src/x/reclamosFromAnalysis.js`: `subcategoria: ''`, `precision` por `tipoUbicacion` (`lugar_nombrado` → `aproximada`).
- `src/x/analyze.js`: `asignarSubcategorias` antes del upsert, mismo patrón que `analyzeComments.js`.
- CSV de X: se puede dejar el header actual; no es el mapa. El mapa usa SQLite.

`geoWorker` no cambia: ya respeta `precision === 'aproximada'`.

## Mapa

- `parseReclamosFilters`: `plataforma` requerido cuando viene del front de plataforma. Valores `instagram` | `x`.
- `listReclamosFiltered` + `contarReclamosPorCategoria`: `AND plataforma = @plataforma`.
- `claimsMap.js`: lee `document.body.dataset.platform` (default `instagram`). Lo agrega a cada fetch y al CSV.
- `instagram.html` / `x.html`: `<body data-platform="…">`.
- `x.html`: quitar el card “Próximamente”; copiar el markup de la solapa mapa de IG; cargar Leaflet + `claimsMap.js`.
- Empty state de X: mismo componente, copy “cuando analices un posteo de X…”.

Export CSV del mapa respeta el mismo filtro.

## Monitoreo X (fase posterior)

UI: clonar el markup de IG en `x.html` (config, runbar, destacados, filtros, Tabulator, modal ignorar). `monitoring.js` lee `data-platform` y manda `plataforma` en todos los fetches.

Backend:

- `config/monitoring-x.json` creado vacío o con `accounts: []`, `keywords: []`.
- `GET/POST/DELETE /api/monitoring/{config,accounts,keywords,posts,run-now}` : query o body `plataforma`. Default `instagram`.
- `run-now` desde `x.html` dispara **solo** el ciclo X (no re-scrapea IG). El cron corre los dos.
- Tabla: columnas actuales + `retweets` / `views` nullable (ALTER). En IG quedan null y no se muestran. En X, `comments` mapea a replies si no hay comments de post.
- “Se despegaron”: benchmark X es follow-up aceptable v1 con umbral simple (RTs o vistas vs mediana de la cuenta). Si `account_stats` no tiene sentido para X en v1, ocultar destacados hasta tener n suficiente. No bloquear el listado.
- Grok fetch de monitor: un search por cuenta (`from:handle`) y uno por keyword, tope de N posts/corrida (constante env, default 30 por fuente). QT→QT se descarta igual que en análisis.

Dashboard: `GET /api/monitoring/counts` → `{ instagram, x }`. Facebook/TikTok siguen sin clave.

## Test Plan

- Validate temas: recorte a 8, drop de `{titulo:""}`, 0 ítems no rompe el reporte (sección omitida).
- `formatTemas` + `reportParts`: roundtrip before + temas + after === report cuando no hay edición.
- Geo X: barrio solo → `reclamosGeo []`; “Salta 250” → entra con `tipoUbicacion=calle_altura`; categoría fuera de lista → fallback del config.
- `listReclamosFiltered({ plataforma: 'x' })` no devuelve filas instagram y viceversa. GET sin plataforma → 400.
- `listDetectedPosts({ plataforma: 'x' })` no lista IG. Insert X no aparece en counts.instagram.
- Config X no lee ni escribe `monitoring.json`.
- Instagram `/api/analyze` sigue devolviendo buckets 3–8 y métricas actuales (más temas y reportParts).

## Open Questions

Ninguna. Cerradas con el usuario:

| Tema | Decisión |
|------|----------|
| Relación con 3–8 | Suman; no reemplazan |
| Plataformas de temas | X e Instagram |
| Edición | Solo temas; no persistir |
| Mapas | Cada uno filtra su plataforma |
| Config monitoreo X | Propia, no seedeada |
| Alcance | 3 solapas + temas; tasks por fases (insights/geo/mapa primero, monitoreo después) |
| Geo X | Alineada completa a IG |
| Plantilla X | Se conserva + bloque de temas |
| Ubicación de temas | Después de 1–2, antes de 3–8 |
