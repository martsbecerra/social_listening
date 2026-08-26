# Spec: x-platform

Análisis de publicaciones de X con Grok como fuente de datos y reporte armado en código. Monitoreo y mapa quedan para fases posteriores.

---

## ADDED Requirements

### Requirement: REQ-X-01 — URL de publicación X

`POST /api/x/analyze` MUST aceptar un link de posteo de X (`x.com` o `twitter.com`, path `/…/status/{id}`). Un link que no sea de X MUST responder 400.

#### Scenario: Link válido

- GIVEN `https://x.com/usuario/status/123`
- WHEN se llama `POST /api/x/analyze`
- THEN el servidor intenta traer el hilo (no responde 400 por la URL)

#### Scenario: Link de Instagram

- GIVEN `https://www.instagram.com/p/AAA/`
- WHEN se llama `POST /api/x/analyze`
- THEN la respuesta es 400

---

### Requirement: REQ-X-02 — Fetch con Grok, no Apify

La extracción del hilo MUST usar Grok X Search (OpenRouter con modelo `x-ai/*`, o la API directa de xAI). MUST NOT llamar a Apify. QTs que citan a otro QT MUST descartarse. Números con sufijo K/M MUST normalizarse a enteros. Si el post no trae métricas, MUST responder 422 sin inventar.

#### Scenario: QT de QT

- GIVEN un item `kind=quote` cuyo `quotedId` no es el post original
- WHEN se normaliza el hilo
- THEN ese item no entra al análisis

---

### Requirement: REQ-X-03 — Reporte armado en código

Grok MUST NOT redactar el WhatsApp final. El LLM MUST devolver JSON de clasificación. KPIs, sentimiento (+5% solo en X) y Top 6 MUST calcularse en código. La plantilla MUST seguir el Prompt Grok (Likes, RTs, QTs, Respuestas, Guardados, visualizaciones, insights 1–8, Top 6).

#### Scenario: Insight sin evidencia

- GIVEN una categoría 3–8 sin items reales del hilo
- WHEN se arma el reporte
- THEN esa categoría dice exactamente `Sin registros en esta categoría`

---

### Requirement: REQ-X-04 — KPIs X distintos de Instagram

Visualizaciones e interacciones MUST evaluarse por separado. Interacciones = likes + RTs + QTs + respuestas (sin guardados). Umbrales de vistas: &lt;45000 Bajo, 45000–60000 Medio, 60001–100000 Alto, &gt;100000 Muy Alto. Umbrales de interacciones: &lt;600 Bajo, 600–1500 Medio, 1501–2500 Alto, &gt;2500 Muy Alto. El +5% de sentimiento positivo MUST aplicarse solo en X.

#### Scenario: Niveles independientes

- GIVEN 80.000 vistas y 500 interacciones
- WHEN se calculan los KPI
- THEN visualizaciones = Alto AND interacciones = Bajo

---

### Requirement: REQ-X-05 — Padrón ANTIK-PRO en SQLite

Los dos CSV MUST mergearse por handle normalizado y persistirse en `x_influencers`. Un handle del padrón MUST forzar `accountType` oficial en el análisis.

#### Scenario: Dedupe

- GIVEN `@cbuteler` en ambos CSV
- WHEN se importa
- THEN hay una sola fila y los seguidores preferidos son los del archivo numérico

---

### Requirement: REQ-X-06 — CSV de reclamos X y persistencia

La descarga MUST usar columnas `Direccion_o_Ubicacion,Tematica,Link_Comentario,Usuario_Perfil`. Solo ubicación literal. Los reclamos MUST guardarse con `plataforma = 'x'` y el link del comentario.

---

### Requirement: REQ-X-07 — UI espejo, fases 2–3 visibles

La página X MUST tener las tres solapas de Instagram. Análisis MUST funcionar. Monitoreo y mapa MUST mostrar “próximamente”, no una tabla vacía. El dashboard MUST enlazar a `x.html`. Instagram MUST seguir igual.

---

### Requirement: REQ-X-08 — Instagram intacto

`/api/analyze`, umbrales de `sentimentAggregate.js` y el prompt de Instagram MUST NOT cambiar de comportamiento.
