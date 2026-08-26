# Design: ignore-detected-post

## Technical Approach

Soft-delete con flag, no `DELETE FROM`. El dedupe del monitor (`findExistingPostId` por id o URL + `INSERT OR IGNORE` + unique de `url`) **depende de que la fila exista**. Por eso ignorar tiene que dejar la fila.

Se usa el mismo patrón que `notified INTEGER NOT NULL DEFAULT 0`, más `ignored_at TEXT` para auditoría y un futuro "deshacer".

## Architecture Decisions

| Decision | Choice | Alternative | Rationale |
|---|---|---|---|
| Estado | `ignored INTEGER NOT NULL DEFAULT 0` + `ignored_at TEXT` | Solo boolean; solo timestamp | Consistente con `notified`; el timestamp deja pista sin UI extra |
| API | `POST /api/monitoring/posts/:id/ignore` | Reusar `DELETE` como soft-ignore | `DELETE` mentiría; el cliente se actualiza junto con el server |
| Hard delete | Se elimina `deletePost` | Dejar DELETE interno | El producto ya no borra; un DELETE residual reabriría el hueco |
| Dedupe | `findExistingPostId` ve ignorados | Tabla aparte de URLs ignoradas | Una sola fuente de verdad; el unique de URL ya existe |
| Refresh / backfill | Excluir ignorados | Seguir actualizando likes | No gastar Apify ni Haiku en algo que la UI no muestra |
| Tests | `node:test` + DB tempfile vía `MONITORING_DB_PATH` | Sin tests; mockear SQL | El repo no tenía tests; Node 22 trae `node:test`; no hace falta un runner extra |

## Data Flow

```
  Cruz de fila
       │
       ├── modal "¿Seguro que querés ignorar esta publicación?"
       │
       └── POST /api/monitoring/posts/:id/ignore
                │
                └── UPDATE detected_posts
                      SET ignored = 1,
                          ignored_at = COALESCE(ignored_at, now)
                    WHERE id = ?

  Ciclo de monitoreo (Apify)
       │
       └── findExistingPostId(id, url)  ← incluye ignorados
                │
                ├── existe → no clasifica, no notifica
                │            applyMetricsRefresh no-op si ignored
                └── no existe → evaluateRelevance → INSERT
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/db.js` | Modify | Migración, `ignorePost`, filtros, `MONITORING_DB_PATH` |
| `server.js` | Modify | POST ignore; quitar DELETE |
| `public/js/monitoring.js` | Modify | Flujo ignore + refrescar destacados |
| `public/instagram.html` | Modify | ids/copy del modal |
| `design/monitoreo.html` | Modify | title "Ignorar" |
| `design/plataforma.html` | Modify | title "Ignorar" |
| `test/ignoreDetectedPost.test.js` | Create | Contrato SQLite |
| `package.json` | Modify | script `test` |
| `README.md` | Modify | Semántica de ignorados |

## Interfaces / Contracts

```js
// src/db.js
function ignorePost(id) // no-op si ya estaba ignorado; conserva ignored_at original
function listDetectedPosts(...) // solo ignored = 0
function listUnnotified() // notified = 0 AND ignored = 0
function listUnclassified() // title IS NULL AND ignored = 0
function countRecentPosts(days) // ignored = 0
function applyMetricsRefresh(id, metrics) // null si no existe o ignored
function findExistingPostId(id, url) // sin filtrar ignored

// server.js
POST /api/monitoring/posts/:id/ignore → { ok: true }
```

## Migration

Al arrancar, si faltan columnas (mismo `PRAGMA table_info` que el resto de `detected_posts`):

```sql
ALTER TABLE detected_posts ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
ALTER TABLE detected_posts ADD COLUMN ignored_at TEXT;
```

Filas viejas quedan `ignored = 0`. El unique `detected_posts_url_unique` no se toca.

## Test Plan

Archivo `test/ignoreDetectedPost.test.js` (tempfile, no `data/monitoring.db`):

1. Insertar un posteo → aparece en `listDetectedPosts` y cuenta en `countRecentPosts`.
2. `ignorePost` → deja de listarse / contarse; `isKnownPost` sigue true.
3. `saveDetectedPost` con la misma URL → `changes === 0` (no es detección nueva).
4. `listUnnotified` no incluye ignorados.
5. `applyMetricsRefresh` sobre ignorado → `null` (no pisa métricas).
6. Un segundo posteo no ignorado sigue visible.

## Open Questions

Ninguna. Sin UI de deshacer en este cambio (`ignored_at` queda listo).
