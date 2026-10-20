# Spec: replicas-solo-lectura

La PC principal publica al final de cada ciclo un snapshot de los datos en un repo privado de GitHub; las réplicas lo traen y lo sirven en modo de solo lectura, solo en `localhost`.

---

## ADDED Requirements

### Requirement: REQ-REP-01 — Interruptor `APP_MODE`

El server MUST arrancar en el modo que indique `APP_MODE`: `principal` (default, también con el valor vacío) o `replica`. Un valor desconocido MUST abortar el arranque con un mensaje que nombre los valores válidos. En `principal` el comportamiento MUST ser el anterior al cambio.

#### Scenario: Sin variable

- GIVEN `APP_MODE` sin definir
- WHEN arranca el server
- THEN corre como antes: scheduler, login y todas las rutas

#### Scenario: Valor inválido

- GIVEN `APP_MODE=copia`
- WHEN arranca el server
- THEN aborta indicando `principal` o `replica`

---

### Requirement: REQ-REP-02 — Contenido del snapshot

Con `REPLICA_PUBLISH_DIR` configurado, al cerrar cada ciclo la principal MUST dejar en esa carpeta: `monitoring.db.gz` (copia consistente de la base comprimida con gzip, con filas solo en `detected_posts`, `account_stats` y `reclamos`: toda otra tabla, `magic_links` incluida, MUST viajar vacía), `snapshot.json` con `publishedAt`, `runId` y `appVersion`, `config/monitoring.json` y `media/` como espejo de `data/media/`. Sin `REPLICA_PUBLISH_DIR` MUST NOT hacer nada.

#### Scenario: Login fuera del snapshot

- GIVEN una base con posteos y un magic link pendiente
- WHEN se publica
- THEN la copia tiene los posteos y `magic_links` vacía

#### Scenario: Solo lo que la réplica muestra

- GIVEN una base con posteos, medianas, reclamos, llamadas a Apify y una tabla que no está en la lista
- WHEN se publica
- THEN la copia tiene posteos, medianas y reclamos, y las otras tablas vacías

#### Scenario: Foto borrada

- GIVEN una foto que estaba en el snapshot anterior y ya no está en `data/media/`
- WHEN se publica
- THEN tampoco está en `media/` del snapshot

---

### Requirement: REQ-REP-03 — Publicación con git

La principal MUST publicar el snapshot como un único commit en la rama `snapshot` del repo de datos (`commit --amend` si ya había uno) y `push --force`. Un fallo al armar o publicar MUST NOT tirar ni frenar el ciclo: MUST loguear `[réplica] no se pudo publicar: <motivo>` y el ciclo siguiente lo reintenta.

#### Scenario: Push rechazado

- GIVEN git devuelve error al hacer push
- WHEN cierra el ciclo
- THEN el ciclo termina igual y queda la línea de log

---

### Requirement: REQ-REP-04 — Réplica de solo lectura

En `replica`, todo pedido con un método distinto de GET o HEAD MUST responder 403 con "Esta copia es de solo lectura." sin llegar a ningún handler. El server MUST NOT arrancar el scheduler ni el keep-awake y MUST NOT exigir claves de Apify, LLM, SMTP ni `SESSION_SECRET`.

#### Scenario: Actualizar ahora

- GIVEN una réplica
- WHEN llega `POST /api/monitoring/run-now`
- THEN responde 403 y no corre ningún ciclo

#### Scenario: Cambiar un reclamo

- GIVEN una réplica
- WHEN llega `PATCH /api/reclamos/1`
- THEN responde 403

---

### Requirement: REQ-REP-05 — Acceso solo local

En `replica`, el server MUST escuchar solo en `127.0.0.1`, MUST rechazar con 421 todo pedido cuyo `Host` no sea `localhost`, `127.0.0.1` o `[::1]` con el puerto del server, y MUST NOT pedir login: las páginas y los GET de `/api` pasan sin sesión, y `/`, `/index.html` y `/login-verify.html` redirigen a `/dashboard.html`.

#### Scenario: DNS rebinding

- GIVEN una réplica en el puerto 3000
- WHEN llega `GET /api/monitoring/posts` con `Host: evil.example:3000`
- THEN responde 421

#### Scenario: Sin login

- GIVEN una réplica
- WHEN se pide `/instagram.html` sin cookie
- THEN se sirve la página

---

### Requirement: REQ-REP-06 — Sincronización

Antes de cada arranque de la réplica MUST traerse el último snapshot (clon superficial la primera vez, fetch superficial y reset después) y aplicarlo: la base nueva (`monitoring.db.gz`, o `monitoring.db` sin comprimir en un snapshot del formato anterior) MUST descomprimirse y pasar `PRAGMA integrity_check` antes de reemplazar la actual, el reemplazo MUST ser por renombre y MUST borrar el `-wal` y el `-shm` anteriores; `media/` MUST quedar en espejo y la config copiada. Si git falla, MUST aplicar lo que ya tenga el clon local y arrancar igual. Una base que no pasa el chequeo MUST NOT reemplazar la actual.

#### Scenario: Sin red

- GIVEN una réplica con un clon de ayer y GitHub inaccesible
- WHEN corre la sincronización
- THEN deja la base de ayer y lo dice en el log

#### Scenario: Base dañada

- GIVEN un snapshot con un `monitoring.db.gz` que no descomprime o no trae una base SQLite válida
- WHEN corre la sincronización
- THEN la base local queda como estaba

---

### Requirement: REQ-REP-07 — Sondeo y reinicio

En `replica`, cada `REPLICA_POLL_MINUTES` (default 10) el server MUST comparar el commit remoto de `snapshot` con el local; si difieren, MUST salir con el código 75. Un error al consultar MUST loguearse y MUST NOT terminar el proceso.

#### Scenario: Snapshot nuevo

- GIVEN el commit remoto distinto del local
- WHEN pasa el sondeo
- THEN el proceso sale con 75

---

### Requirement: REQ-REP-08 — Modo y versión para el frontend

`GET /api/app/mode` MUST responder `{ mode, readOnly }`; en `replica`, además `dataAsOf`, `runId`, `appVersion`, `snapshotAppVersion` y `newerAppAvailable` (true solo si las dos versiones existen y difieren). En réplica el frontend MUST ocultar los controles de escritura y mostrar "Copia de solo lectura · Datos al DD/MM HH:MM".

---

### Requirement: REQ-REP-09 — El token no se filtra

El token de las réplicas (`DATA_REPO_TOKEN`) MUST pasarse a git solo por variables de entorno del proceso hijo, MUST NOT aparecer en argumentos de línea de comandos ni en URLs, y un mensaje de error de git MUST NOT incluirlo (ni en claro ni en base64).

#### Scenario: Error de git con el header

- GIVEN git falla y su stderr incluye el header de autenticación
- WHEN se loguea el error
- THEN el token aparece reemplazado
