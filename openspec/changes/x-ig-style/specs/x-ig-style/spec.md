# Spec: x-ig-style

Temas emergentes en el análisis de publicación (Instagram y X), geo de X alineada a Instagram, mapa de X y monitoreo de X al estilo Instagram. Las fases 2 y 3 de `x-platform` quedan cubiertas acá.

---

## ADDED Requirements

### Requirement: REQ-TEMAS-01 — Temas emergentes en el JSON de clasificación

El structured output de `/api/analyze` y `/api/x/analyze` MUST incluir `temasConversacion`: array de 0 a 8 objetos `{ titulo, texto }`. El modelo MUST agrupar patrones recurrentes del hilo, no inventar, no usar `@` ni URLs, no copiar el formato de los buckets 3–8. Cero ítems MUST ser válido.

#### Scenario: Hilo con varios ejes de queja

- GIVEN comentarios que reiteran celular, coimas y zonas sin patrullaje
- WHEN corre el análisis
- THEN `temasConversacion` tiene entre 3 y 8 ítems con título corto y 1–2 oraciones cada uno

#### Scenario: Hilo sin patrón temático

- GIVEN comentarios sueltos sin eje repetido
- WHEN corre el análisis
- THEN `temasConversacion` es `[]` y el reporte no incluye la sección de temas

---

### Requirement: REQ-TEMAS-02 — Ubicación en el reporte WhatsApp

La sección `🗣️ TEMAS DE LA CONVERSACIÓN` MUST ir después del insight 2 (KPI) y antes del insight 3 (apoyo de funcionarios). Los insights 1–8 MUST conservar numeración y copy actuales (X: plantilla Prompt Grok + Top 6; Instagram: plantilla actual). Sin markdown `**`.

#### Scenario: Hay temas

- GIVEN `temasConversacion` con al menos un ítem
- WHEN se arma el reporte
- THEN el texto contiene el encabezado de temas entre el bloque 2️⃣ y el bloque 3️⃣

#### Scenario: No hay temas

- GIVEN `temasConversacion` vacío
- WHEN se arma el reporte
- THEN no aparece el encabezado de temas ni líneas en blanco extra entre 2️⃣ y 3️⃣

---

### Requirement: REQ-TEMAS-03 — Edición solo de temas, sin persistir

El front de análisis (IG y X) MUST dejar editar título y texto de los temas (agregar hasta 8, quitar). El resto del reporte MUST NO ser editable. Copiar y WhatsApp MUST usar los temas editados. Recargar la página MUST volver a los temas del último análisis en memoria de esa respuesta, no a un registro en DB. MUST NOT existir PATCH de temas.

#### Scenario: Analista corrige un título

- GIVEN un análisis con 4 temas
- WHEN el analista cambia el título del tema 1 y pulsa Copiar
- THEN el portapapeles incluye el título nuevo y el resto del reporte (métricas, 3–8, Top 6 si aplica) igual al generado

#### Scenario: Analista agrega un tema a mano

- GIVEN un análisis con 0 temas
- WHEN el analista agrega uno y comparte por WhatsApp
- THEN el texto compartido incluye la sección de temas con ese ítem

---

### Requirement: REQ-TEMAS-04 — Instagram intacto salvo temas

`/api/analyze` MUST seguir usando Apify + `LLM_PROVIDER`. Umbrales de `sentimentAggregate.js`, buckets 3–8 y CSV de reclamos IG MUST NOT cambiar de comportamiento. Solo se suma el contrato de temas y `reportParts`.

#### Scenario: Análisis IG sin tocar métricas

- GIVEN un post de Instagram con comentarios clasificables
- WHEN responde `/api/analyze`
- THEN el reporte sigue teniendo ❤️ 💬 👁️, insights 1️⃣–8️⃣ con el copy actual, y además `temas` / `reportParts` en el JSON

---

### Requirement: REQ-GEO-01 — Geo de X alineada a Instagram

El prompt y el schema de X MUST usar ubicación accionable (`calle_altura`, `cruce`, `tramo`, `lugar_nombrado`) y el árbol de `config/categorias-reclamos.json`. Barrio, comuna o ciudad solos MUST producir `reclamosGeo []`. Tras clasificar, X MUST llamar `asignarSubcategorias` y persistir `precision` (`lugar_nombrado` → `aproximada`). El prompt MUST NOT listar las 9 categorías viejas.

#### Scenario: Barrio solo

- GIVEN un reply “esto pasa en Palermo”
- WHEN se clasifica el hilo
- THEN ese ítem no genera fila en `reclamos`

#### Scenario: Calle y altura

- GIVEN un reply “hay un bache en Salta 250”
- WHEN se clasifica y se upserta
- THEN hay un reclamo `plataforma=x` con `tipoUbicacion` equivalente `calle_altura` y subcategoría del árbol (o vacía si el paso 2 no asigna)

---

### Requirement: REQ-MAP-01 — Mapa de X

La solapa “Mapa de reclamos” de `x.html` MUST montar el mismo Leaflet que Instagram (filtros, leyenda, popup de estado, CSV). MUST pedir `plataforma=x`. MUST NOT mostrar “Próximamente”.

#### Scenario: Reclamo X geocodificado

- GIVEN un reclamo `plataforma=x` con `geo_status=ok`
- WHEN el usuario abre la solapa mapa en X
- THEN el pin aparece en el mapa de X y no en el de Instagram

---

### Requirement: REQ-MAP-02 — Cada mapa filtra su plataforma

`GET /api/reclamos` y el export CSV MUST exigir `plataforma=instagram` o `plataforma=x`. El mapa de Instagram MUST enviar `instagram`. Sin `plataforma` MUST responder 400. El ranking de colores MUST calcularse sobre esa plataforma.

#### Scenario: GET sin plataforma

- GIVEN `/api/reclamos` sin query `plataforma`
- WHEN se llama
- THEN la respuesta es 400

#### Scenario: Instagram no mezcla X

- GIVEN reclamos de ambas plataformas
- WHEN el mapa de Instagram carga
- THEN solo se listan filas `plataforma=instagram`

---

### Requirement: REQ-MON-01 — UI de monitoreo X

La solapa “Monitoreo en vivo” de `x.html` MUST dejar de ser “Próximamente” y MUST mostrar la misma superficie que Instagram: cuentas, keywords, actualizar ahora, tabla, ignorar, filtros. Cuentas y keywords MUST leer y escribir `config/monitoring-x.json`, no `config/monitoring.json`.

#### Scenario: Agregar cuenta en X

- GIVEN la solapa monitoreo de X
- WHEN se agrega `usuario`
- THEN queda en `monitoring-x.json` y no aparece en la config de Instagram

---

### Requirement: REQ-MON-02 — Fuente Grok, no Apify

El ciclo de monitoreo de X MUST usar Grok X Search. MUST NOT llamar a Apify. Posts ya vistos por URL MUST no reinsertarse. Filas nuevas MUST guardarse con `plataforma=x`.

#### Scenario: Corrida X

- GIVEN keywords configuradas en X
- WHEN corre el ciclo X
- THEN los posts nuevos se insertan con `plataforma=x` sin invocar actores de Apify

---

### Requirement: REQ-MON-03 — Listados y counts namespaced

`listDetectedPosts` y `countRecentPosts` MUST filtrar por `plataforma`. El dashboard MUST exponer `counts.x`. Ignorar un posteo de X MUST no afectar la tabla de Instagram.

#### Scenario: Counts

- GIVEN 3 posts IG y 2 posts X en los últimos 7 días (no ignorados)
- WHEN `GET /api/monitoring/counts`
- THEN `instagram` es 3 y `x` es 2

---

### Requirement: REQ-MON-04 — Cron y run-now

El cron MUST correr IG y después X en el mismo `runCycle`, un ciclo a la vez. “Actualizar ahora” desde `x.html` MUST correr solo X. “Actualizar ahora” desde Instagram MUST correr solo IG. X MUST NOT enviar mails de alerta.

#### Scenario: Run-now X no scrapea Instagram

- GIVEN el botón en `x.html`
- WHEN el usuario dispara actualizar ahora
- THEN no se llama al scraper de Apify de cuentas de Instagram
