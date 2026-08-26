# Spec: ignore-detected-post

Cambio de la cruz de cada fila de "Monitoreo en vivo": ignorar en vez de borrar.

---

## ADDED Requirements

### Requirement: REQ-IGNORE-01 — Confirmación al ignorar

La cruz al final de una fila de la tabla de posteos detectados MUST pedir confirmación antes de ignorar. El copy MUST hablar de ignorar, no de borrar.

#### Scenario: El usuario cancela

- GIVEN una fila visible en la tabla
- WHEN se hace clic en la cruz y después en Cancelar
- THEN el posteo sigue visible y en la base sin `ignored = 1`

#### Scenario: El usuario confirma

- GIVEN una fila visible en la tabla
- WHEN se hace clic en la cruz y se confirma
- THEN el posteo desaparece de la tabla
- AND deja de aparecer en "Se despegaron" si estaba ahí

---

### Requirement: REQ-IGNORE-02 — Persistencia soft-ignore

Ignorar MUST actualizar la fila existente en `detected_posts` (`ignored = 1`, `ignored_at` ISO 8601). MUST NOT hacer `DELETE FROM detected_posts`.

#### Scenario: La fila sigue en SQLite

- GIVEN un posteo con id `p1` y url `U`
- WHEN se ignora `p1`
- THEN existe una fila con ese id, `ignored = 1` e `ignored_at` no nulo

#### Scenario: Re-ignorar no pisa la fecha

- GIVEN un posteo ya ignorado con `ignored_at = T`
- WHEN se vuelve a llamar `ignorePost` con el mismo id
- THEN `ignored_at` sigue siendo `T`

---

### Requirement: REQ-IGNORE-03 — Invisible en producto

Los listados y conteos de producto MUST excluir `ignored = 1`: tabla, destacados (derivados del listado), `listUnnotified`, `listUnclassified`, `countRecentPosts`, y candidatos a refresh de métricas.

#### Scenario: No vuelve a la tabla al recargar

- GIVEN un posteo ignorado
- WHEN el cliente pide `GET /api/monitoring/posts`
- THEN ese posteo no está en `posts`
- AND no suma en `total`

---

### Requirement: REQ-IGNORE-04 — Sigue siendo conocido

`findExistingPostId` / `isKnownPost` MUST considerar ignorados. El unique de `url` MUST seguir bloqueando un segundo insert. Un posteo ignorado MUST NOT entrar en `newPosts` ni disparar mail.

#### Scenario: Misma URL en la próxima corrida

- GIVEN un posteo ignorado con url `U`
- WHEN el monitor ve de nuevo un candidato con url `U`
- THEN no se inserta una fila nueva
- AND no se reclasifica
- AND no se encola notificación

---

### Requirement: REQ-IGNORE-05 — No gastar refresh en ignorados

`applyMetricsRefresh` MUST devolver `null` y no escribir likes/comments si la fila está ignorada.

#### Scenario: Apify trae métricas nuevas de un ignorado

- GIVEN un posteo ignorado con 10 likes
- WHEN `applyMetricsRefresh` llega con 99 likes
- THEN la fila sigue con 10 likes
- AND la función retorna `null`

---

### Requirement: REQ-IGNORE-06 — Chips fuera de alcance

La cruz de los chips de cuentas trackeadas y de palabras clave MUST seguir quitando ítems de la config. Este cambio MUST NOT alterar ese flujo.

---

### Requirement: REQ-IGNORE-07 — API de ignore

El cliente MUST ignorar con `POST /api/monitoring/posts/:id/ignore`. El `DELETE /api/monitoring/posts/:id` MUST dejar de borrar (se retira).

#### Scenario: Ignore idempotente

- GIVEN un id existente (ignorado o no)
- WHEN `POST /api/monitoring/posts/:id/ignore`
- THEN la respuesta es `{ ok: true }`
