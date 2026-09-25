# Spec: clasificacion-contexto

Clasificación del monitoreo en una sola llamada con contexto, un solo modelo y desambiguación geográfica.

---

## ADDED Requirements

### Requirement: REQ-CLC-01 — Una sola función

`src/classifier.js` MUST exponer una única función `clasificarPosteo(caption, { platformLabel, pista })` que devuelve `{ relevant, title, sentiment, motivo, unclassified }` en una sola llamada al LLM, con structured outputs (schema estricto: `relevant` boolean, `title` string, `sentiment` ∈ positivo | neutral | negativo, `motivo` string). `classifyPost` y `classifyRelevance` MUST NOT existir.

#### Scenario: Respuesta válida

- GIVEN un caption con texto
- WHEN el modelo responde `{ relevant: true, title: "…", sentiment: "negativo", motivo: "…" }`
- THEN la función devuelve eso tal cual, sin `unclassified`

---

### Requirement: REQ-CLC-02 — La keyword literal es una pista

Una coincidencia literal con una keyword MUST NOT dar por relevante el posteo. `evaluateRelevance` MUST pasar la coincidencia como `pista.termino` (y la cuenta trackeada, el hashtag o la búsqueda como pista de origen) en una línea `CONTEXTO:` del mensaje de usuario, y decidir por `relevant` del modelo.

#### Scenario: Keyword literal de otra ciudad

- GIVEN keywords `["jefe de gobierno"]` y un caption "La Jefa de Gobierno Clara Brugada anunció obras en la Ciudad de México"
- WHEN el modelo responde `relevant: false`
- THEN el posteo se descarta

---

### Requirement: REQ-CLC-03 — Un solo modelo

Todo el LLM (análisis, clasificador del monitoreo, reclamos, importador) MUST usar el modelo de análisis (`CLAUDE_MODEL` / `OPENROUTER_MODEL`). `CLASSIFIER_MODEL` y `OPENROUTER_CLASSIFIER_MODEL` MUST NOT tener efecto; si están en el `.env`, el arranque MUST avisar y seguir.

#### Scenario: Variable obsoleta

- GIVEN `CLASSIFIER_MODEL=claude-haiku-4-5` en el `.env`
- WHEN arranca el server
- THEN imprime un aviso de que ya no se usa y arranca igual

---

### Requirement: REQ-CLC-04 — Fallos visibles

Si el LLM falla, responde algo que no cumple el schema o `relevant` no es booleano, el posteo MUST guardarse con `title` y `sentiment` en null y `matched_reason` terminado en `— sin clasificar (falló el clasificador, relevancia sin verificar)`. MUST NOT descartarse en silencio.

#### Scenario: API caída

- GIVEN el proveedor tira un error con `isApiFailure`
- WHEN el ciclo evalúa un posteo con caption
- THEN se guarda sin clasificar y el backfill lo reintenta

---

### Requirement: REQ-CLC-05 — Desambiguación geográfica

El system prompt MUST decir que el objetivo es Jorge Macri, Jefe de Gobierno de CABA, y su gestión; que "Jefe de Gobierno" también es el título del titular de la Ciudad de México y ese contenido no es relevante; que los términos ambiguos (PDLC, "gobierno de la ciudad", alcalde, intendente) solo cuentan en contexto porteño; las señales a favor y las de alerta; que una señal de alerta NO descarta por sí sola; que se descarta Mauricio Macri sin relación con Jorge ni la gestión porteña, y la política nacional argentina que no toque a Jorge Macri ni a la Ciudad; y que la cuenta trackeada es una señal débil.

#### Scenario: Figura mexicana y Jorge Macri

- GIVEN un caption que menciona a Sheinbaum y critica a Jorge Macri
- WHEN el modelo aplica la regla clave
- THEN es relevante

---

### Requirement: REQ-CLC-06 — X sin cambios

Un posteo con `sourceType 'keyword'` (búsqueda por término de X) MUST entrar directo con el título y el sentimiento del modelo, ignorando `relevant`, y su `matched_reason` MUST ser el de siempre (sin motivo).

#### Scenario: Búsqueda de X

- GIVEN un tuit que llegó por la búsqueda "Jorge Macri"
- WHEN el modelo responde `relevant: false`
- THEN el tuit se guarda igual con `Búsqueda por palabra clave: "Jorge Macri"`

---

### Requirement: REQ-CLC-07 — Trazabilidad

`matched_reason` de un posteo decidido por el modelo MUST terminar en ` · <motivo>`. Un descarte MUST loguearse con red, cuenta, url y motivo. El backfill MUST completar el motivo y, si el modelo dice no relevante, MUST NOT borrar la fila: deja `no relevante según el modelo: <motivo>` y avisa.

#### Scenario: Posteo aceptado

- GIVEN un posteo de cuenta trackeada con coincidencia "pdlc"
- WHEN el modelo responde `relevant: true, motivo: "habla de la Policía de la Ciudad en CABA"`
- THEN `matched_reason` es `Cuenta trackeada: @cuenta (coincidencia: "pdlc") · habla de la Policía de la Ciudad en CABA`
