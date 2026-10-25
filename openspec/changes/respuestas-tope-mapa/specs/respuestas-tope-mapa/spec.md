# Spec: respuestas-tope-mapa

## ADDED Requirements

### Requirement: REQ-G-01 — Respuestas con su comentario padre

Los comentarios MUST traerse con `apify/instagram-comment-scraper` e `includeNestedComments`. Cada respuesta MUST guardarse con el número del comentario al que responde (si está en el análisis) y el usuario, marcada como respuesta, y MUST clasificarse igual que un comentario. Las respuestas de la propia cuenta MUST NOT ir al modelo ni contar en tono, postura, temas o "hablan del posteo".

#### Scenario: La cuenta contesta un reclamo

- GIVEN @gcba publicó y @vecina comentó "¿Y el bache de Corrientes?"
- WHEN @gcba le responde
- THEN la respuesta aparece en "¿La cuenta respondió?" con el comentario de @vecina, y no suma al tono

---

### Requirement: REQ-G-02 — Debates y "¿La cuenta respondió?"

La vista MUST traer los 6 comentarios con más respuestas (con el tono de sus respuestas) y a cuántos comentarios contestó la cuenta, con cuáles. La pantalla MUST mostrar "Más likes / Más respuestas" en "Los que más pegaron", la tarjeta "¿La cuenta respondió?" debajo de "Verificados y figuras", "↳ responde a @usuario" y el filtro "Respuestas" en la lista; el informe lo MUST decir en "Quién habló". Un análisis sin respuestas MUST decir "No disponible en análisis anteriores".

---

### Requirement: REQ-G-03 — Tope con confirmación

Los topes MUST valer 3.000 ítems (comentarios más respuestas). Con más de 1.000 comentarios según Instagram, el análisis MUST esperar la confirmación antes de traer los comentarios, mostrando el costo estimado de "Analizar todo" (o "Analizar 3.000") y "Analizar 1.000". La publicación MUST traerse una sola vez.

#### Scenario: Una publicación de 5.200 comentarios

- GIVEN Instagram dice 5.200 comentarios
- WHEN se analiza
- THEN se trae la publicación, el análisis espera y la pantalla ofrece "Analizar 3.000 (~US$ X)" y "Analizar 1.000 (~US$ Y)"; al confirmar, se traen los comentarios sin volver a pedir la publicación

---

### Requirement: REQ-G-04 — Login, mapa y estado

"Revisá tu correo" MUST ofrecer el webmail del dominio del correo cuando lo conoce. El Mapa de reclamos MUST usar los mosaicos de Google con Mapa / Satélite y volver solo a OpenStreetMap si no cargan. El estado de los reclamos MUST NOT verse en la pantalla; la columna MUST quedar en la base.
