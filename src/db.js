// ==========================================================================
// db.js
// --------------------------------------------------------------------------
// Capa de persistencia del monitoreo automático, usando SQLite. Usamos el
// módulo "node:sqlite" incorporado en Node (desde la v22.5) en vez de una
// librería externa como "better-sqlite3": esta última necesita compilar
// código nativo (node-gyp + Visual Studio Build Tools en Windows), algo que
// esta PC no tiene instalado. node:sqlite viene con Node, así que no hace
// falta compilar nada ni instalar dependencias extra. Su API es igual de
// sincrónica y simple. Todo vive en un único archivo: data/monitoring.db.
//
// Guardamos acá cada posteo relevante que detectamos, para no volver a
// notificarlo dos veces en corridas futuras. Si se ignora desde la tabla,
// la fila se queda (ignored=1): sigue bloqueando re-detección, pero ya no
// aparece en la UI ni en los mails pendientes. También los hashes de magic
// links de login (nunca el token crudo).
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeClasificacion } = require('./categoriasConfig');
const { platformForUrl } = require('./platforms/urlPlatform');
const figurasModelo = require('./figuras');
const analysisMetrics = require('./analysisMetrics'); // sin dependencias: no vuelve a db.js

const DATA_DIR = path.join(__dirname, '..', 'data');
// MONITORING_DB_PATH: solo para tests (tempfile). En runtime normal sigue
// siendo data/monitoring.db.
const DB_PATH = process.env.MONITORING_DB_PATH || path.join(DATA_DIR, 'monitoring.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS detected_posts (
    id TEXT PRIMARY KEY,
    account TEXT,
    url TEXT NOT NULL,
    caption TEXT,
    matched_reason TEXT,
    likes INTEGER,
    comments INTEGER,
    posted_at TEXT,
    detected_at TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  )
`);

// Migración simple: agrega las columnas de clasificación (título + sentimiento
// del posteo) si todavía no existen, sin tocar las filas ya guardadas.
const existingColumns = db.prepare('PRAGMA table_info(detected_posts)').all().map((c) => c.name);
if (!existingColumns.includes('title')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN title TEXT');
}
if (!existingColumns.includes('sentiment')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN sentiment TEXT');
}
// post_type (reel|imagen|carrusel|null) para poder comparar el posteo contra
// la mediana de SU tipo en account_stats (ver src/accountStats.js). Las filas
// guardadas antes de esto quedan NULL — caen en el bucket "sin tipo", que es
// el comportamiento correcto si esa cuenta no tiene desglose por tipo.
if (!existingColumns.includes('post_type')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN post_type TEXT');
}
// Snapshot de seguidores de la cuenta al momento de guardar el posteo (no en
// tiempo real): viene de la caché account_followers, que se refresca con la
// misma cadencia que account_stats (ver src/accountStats.js). Las filas
// guardadas antes de esto, o de cuentas todavía sin caché, quedan NULL.
if (!existingColumns.includes('followers')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN followers INTEGER');
}
// Cuándo se actualizaron por última vez likes/comments de este posteo desde
// un recálculo de benchmark (no desde la detección original) — ver
// updatePostMetricsIfChanged más abajo. NULL si nunca se tocó después de
// guardarse.
if (!existingColumns.includes('metrics_updated_at')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN metrics_updated_at TEXT');
}
// Soft-ignore: la cruz de la tabla no borra la fila. Se queda con
// ignored=1 para que findExistingPostId / el unique de url sigan
// bloqueando una re-detección (y un re-mail) en la próxima corrida.
if (!existingColumns.includes('ignored')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0');
}
if (!existingColumns.includes('ignored_at')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN ignored_at TEXT');
}
// Plataforma de origen del posteo (instagram | x | ...), para la capa de
// adapters de src/platforms/. Todas las filas guardadas antes de esta columna
// eran de Instagram (única plataforma con scraping implementado): el DEFAULT
// las deja correctas sin necesitar un UPDATE aparte.
// Historia: la rama refactor_plataformas creó esta columna como `platform` y
// main como `plataforma`. Una base puede venir de cualquiera de las dos, o de
// ambas (las dos columnas a la vez). Se unifica en `plataforma` conservando
// los datos. La migración es de ida (el código anterior no arranca contra
// la base migrada): backup de data/monitoring.db (+ -wal y -shm) antes.
const hasPlatformEn = existingColumns.includes('platform');
const hasPlataforma = existingColumns.includes('plataforma');
if (hasPlatformEn && !hasPlataforma) {
  // Base que corrió solo refactor_plataformas: mismo dato, otro nombre.
  db.exec('ALTER TABLE detected_posts RENAME COLUMN platform TO plataforma');
} else if (hasPlatformEn && hasPlataforma) {
  // Base que corrió las dos ramas. Cada fila la escribió una sola de ellas,
  // así que la columna "real" es la que no quedó en su DEFAULT: `plataforma`
  // gana salvo que esté en 'instagram' y `platform` diga otra cosa. Después
  // se tira la columna en inglés (no está en ningún índice ni en la PK).
  db.exec('BEGIN');
  db.exec("UPDATE detected_posts SET plataforma = platform WHERE plataforma = 'instagram' AND platform <> 'instagram'");
  db.exec('ALTER TABLE detected_posts DROP COLUMN platform');
  db.exec('COMMIT');
} else if (!hasPlataforma) {
  // Base anterior a ambas ramas (o recién creada).
  db.exec("ALTER TABLE detected_posts ADD COLUMN plataforma TEXT NOT NULL DEFAULT 'instagram'");
}
// Métricas propias de X (Instagram las deja NULL y no las muestra).
if (!existingColumns.includes('retweets')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN retweets INTEGER');
}
if (!existingColumns.includes('views')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN views INTEGER');
}
// Refresco de métricas por URL (ver src/metricsRefresh.js y
// openspec/changes/refresco-url): intentos SEGUIDOS en que se pidió este
// posteo por su URL y el run, que terminó bien, no lo devolvió (borrado,
// privado) y, al llegar al tope, la fecha en que dejó de pedirse. Una
// respuesta válida (por el refresco o por el benchmark) vuelve el contador
// a 0 y levanta el freno. Las filas viejas arrancan en 0 / NULL.
if (!existingColumns.includes('refresh_misses')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN refresh_misses INTEGER NOT NULL DEFAULT 0');
}
if (!existingColumns.includes('refresh_stopped_at')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN refresh_stopped_at TEXT');
}
// Foto del posteo (src/postImages.js, openspec/changes/monitoreo-fotos). Las
// copias van a disco (data/media/); acá queda el link original del último
// intento, cómo salió (ok | vencido | error | pendiente de reintentar; NULL
// si nunca vino imagen), cuándo se guardaron las copias y las medidas de la
// original.
// image_saved_at es lo único que dice si hay foto: un intento fallido cambia
// el estado y el link, nunca esa marca. Todas anulables y sin tocar las
// filas guardadas: el código anterior sigue funcionando contra la base
// migrada.
for (const [column, type] of [
  ['image_source_url', 'TEXT'],
  ['image_status', 'TEXT'],
  ['image_saved_at', 'TEXT'],
  ['image_width', 'INTEGER'],
  ['image_height', 'INTEGER'],
]) {
  if (!existingColumns.includes(column)) {
    db.exec(`ALTER TABLE detected_posts ADD COLUMN ${column} ${type}`);
  }
}
// Tema del posteo para la sección Estadísticas: el nombre canónico de una
// categoría de config/categorias-reclamos.json (src/classifier.js), el mismo
// texto que reclamos.categoria. Sin CHECK a propósito, como en reclamos: la
// lista la define el cliente en el JSON. NULL = sin dato: posteos guardados
// antes de esta columna o un fallo del clasificador; backfillClassification
// lo completa. Anulable y sin tocar las filas guardadas.
if (!existingColumns.includes('tema')) {
  db.exec('ALTER TABLE detected_posts ADD COLUMN tema TEXT');
}
// Limpieza de datos: Apify devuelve -1 en likesCount cuando el autor ocultó
// el contador de "me gusta" (centinela documentado del actor, no un error de
// parseo) — se guardaba tal cual, como si fuera un valor real. Un posteo sin
// dato no es lo mismo que un posteo con cero likes (contaminaría medianas y
// se vería como una fila rota), así que pasa a NULL como cualquier otro dato
// faltante. Se corre en cada arranque; sin filas negativas es un UPDATE
// vacío, no hace falta guardarlo como migración "de una sola vez".
db.exec('UPDATE detected_posts SET likes = NULL WHERE likes < 0');
db.exec('UPDATE detected_posts SET comments = NULL WHERE comments < 0');
// Misma pieza de Instagram = misma URL. Si Apify cambia cuál campo usa
// normalizePost (src/platforms/instagram.js) para armar el id (raw.id vs
// shortCode), sin este índice se insertaría una segunda fila y se
// re-notificaría.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS detected_posts_url_unique ON detected_posts(url)');

const isKnownPostStmt = db.prepare('SELECT 1 FROM detected_posts WHERE id = ?');
const getPostIdByUrlStmt = db.prepare('SELECT id FROM detected_posts WHERE url = ?');
// OR IGNORE: un segundo ciclo en paralelo (cron + "Actualizar ahora") no
// puede tirar abajo toda la corrida con UNIQUE constraint failed. Si el
// posteo ya está, changes === 0 y el llamador lo trata como conocido.
const insertPostStmt = db.prepare(`
  INSERT OR IGNORE INTO detected_posts
    (id, account, url, caption, matched_reason, likes, comments, posted_at, detected_at, notified, title, sentiment, tema, post_type, followers, plataforma, retweets, views)
  VALUES
    (@id, @account, @url, @caption, @matchedReason, @likes, @comments, @postedAt, @detectedAt, 0, @title, @sentiment, @tema, @postType, @followers, @plataforma, @retweets, @views)
`);
// Cada listado/conteo tiene su variante filtrada por plataforma: el filtro es
// opcional (sin plataforma = todas), así los llamadores existentes no cambian.
const countPostsStmt = db.prepare('SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0');
const countPostsByPlataformaStmt = db.prepare(
  'SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0 AND plataforma = ?'
);
const countRecentPostsStmt = db.prepare('SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0 AND detected_at >= ?');
const countRecentPostsByPlataformaStmt = db.prepare(
  'SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0 AND detected_at >= ? AND plataforma = ?'
);
const listPostsPageStmt = db.prepare('SELECT * FROM detected_posts WHERE ignored = 0 ORDER BY detected_at DESC LIMIT ? OFFSET ?');
const listPostsPageByPlataformaStmt = db.prepare(
  'SELECT * FROM detected_posts WHERE ignored = 0 AND plataforma = ? ORDER BY detected_at DESC LIMIT ? OFFSET ?'
);
const listUnclassifiedStmt = db.prepare(
  'SELECT id, account, caption, matched_reason, title FROM detected_posts WHERE (title IS NULL OR tema IS NULL) AND ignored = 0 ORDER BY detected_at ASC'
);
const listUnclassifiedByPlataformaStmt = db.prepare(
  'SELECT id, account, caption, matched_reason, title FROM detected_posts WHERE (title IS NULL OR tema IS NULL) AND ignored = 0 AND plataforma = ? ORDER BY detected_at ASC'
);
// El tema, en los dos casos, solo se completa: uno ya guardado no se pisa.
const updateClassificationStmt = db.prepare('UPDATE detected_posts SET title = ?, sentiment = ?, tema = COALESCE(tema, ?) WHERE id = ?');
const updateClassificationConMotivoStmt = db.prepare(
  'UPDATE detected_posts SET title = ?, sentiment = ?, tema = COALESCE(tema, ?), matched_reason = ? WHERE id = ?'
);
const updateTemaStmt = db.prepare('UPDATE detected_posts SET tema = ? WHERE id = ? AND plataforma = ? AND tema IS NULL');
// Las acciones de la tabla (ignorar, corregir sentimiento) van por id Y
// plataforma: desde la solapa de Instagram no se toca un posteo de X aunque
// se conozca su id (los ids ya son únicos entre redes, esto es el contrato).
const postExistsInPlataformaStmt = db.prepare('SELECT 1 FROM detected_posts WHERE id = ? AND plataforma = ?');
const updateSentimentStmt = db.prepare('UPDATE detected_posts SET sentiment = ? WHERE id = ? AND plataforma = ?');
// Solo la primera vez: si ya estaba ignorado, ignored_at se conserva.
const ignorePostStmt = db.prepare(
  'UPDATE detected_posts SET ignored = 1, ignored_at = ? WHERE id = ? AND ignored = 0 AND plataforma = ?'
);
const getPostIgnoredAtStmt = db.prepare('SELECT ignored, ignored_at FROM detected_posts WHERE id = ?');

/** Las funciones por plataforma no tienen default: sin ella es un error de programación, no "instagram". */
function requirePlataforma(plataforma, fn) {
  if (typeof plataforma !== 'string' || !plataforma.trim()) {
    throw new Error(`${fn}: falta plataforma (instagram | x); no hay default.`);
  }
  return plataforma;
}

// La forma vieja de `reclamos` (source/username/comment_text/lat/lng/tematica
// libre) es incompatible con el esquema de categorías cerradas + USIG. La
// tabla estaba vacía en producción, así que en vez de un ALTER aditivo que
// dejaría columnas muertas duplicando conceptos (username vs autor, lat/lng
// vs x/y), se recrea limpia una única vez: si existe con la forma vieja
// (sin `comentario_id`), se dropea antes del CREATE de abajo. A partir de
// acá, cualquier columna nueva se suma con el mismo patrón incremental que
// ya usa este archivo (ver detected_posts más arriba).
const reclamosColumnsBefore = db.prepare('PRAGMA table_info(reclamos)').all().map((c) => c.name);
if (reclamosColumnsBefore.length > 0 && !reclamosColumnsBefore.includes('comentario_id')) {
  db.exec('DROP TABLE reclamos');
}

// Listas cerradas que SÍ van en el esquema: son estables y no las define el
// cliente. La categoría NO está acá a propósito — ver más abajo.
const ESTADO_SQL_LIST = "'Pendiente','En tratamiento','Resuelto','Desestimado'";
const PLATAFORMA_SQL_LIST = "'instagram','x','tiktok','facebook'";
// 'sin_direccion' y 'no_encontrada' son cosas distintas y hay que poder
// separarlas: la primera es "el texto no menciona un lugar accionable", la
// segunda es "había una dirección pero USIG no le pudo dar un punto". Mezclarlas
// impide medir qué proporción de reclamos es geolocalizable, que es un dato en
// sí mismo, y saber contra qué comparar si algún día mejora la extracción.
const GEO_STATUS_SQL_LIST =
  "'pendiente','ok','sin_direccion','no_encontrada','invalida','fuera_caba'";

// `categoria` y `subcategoria` van sin CHECK: la lista de categorías la define
// el cliente en config/categorias-reclamos.json, es larga y va a cambiar. Un
// CHECK la volvería a hardcodear en el esquema y obligaría a reconstruir la
// tabla en cada cambio (SQLite no sabe alterar un CHECK). La validación vive
// en src/categoriasConfig.js, por donde pasa todo lo que se guarda.
db.exec(`
  CREATE TABLE IF NOT EXISTS reclamos (
    id TEXT PRIMARY KEY,
    comentario_id TEXT UNIQUE,
    plataforma TEXT NOT NULL CHECK(plataforma IN (${PLATAFORMA_SQL_LIST})),
    post_url TEXT,
    comment_url TEXT,
    autor TEXT,
    fecha TEXT,
    detected_at TEXT NOT NULL,
    texto_original TEXT NOT NULL,
    categoria TEXT NOT NULL,
    subcategoria TEXT,
    precision_fecha TEXT,
    import_origen TEXT,
    direccion_detectada TEXT,
    direccion_normalizada TEXT,
    calle TEXT,
    altura INTEGER,
    cruce TEXT,
    x REAL,
    y REAL,
    comuna INTEGER,
    barrio TEXT,
    precision TEXT,
    geo_status TEXT CHECK(geo_status IN (${GEO_STATUS_SQL_LIST})),
    estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK(estado IN (${ESTADO_SQL_LIST}))
  )
`);

// --------------------------------------------------------------------------
// Migración a dos niveles (categoría + subcategoría).
//
// Dos cosas que el CREATE de arriba no puede hacer sobre una tabla que ya
// existe: agregar `subcategoria` y sacar el CHECK viejo de `categoria`. Lo
// primero es un ALTER; lo segundo, en SQLite, obliga a reconstruir la tabla.
// Se hace una sola vez, detectando el CHECK viejo en el DDL guardado.
// --------------------------------------------------------------------------
const reclamosColumns = db.prepare('PRAGMA table_info(reclamos)').all().map((c) => c.name);
if (!reclamosColumns.includes('subcategoria')) {
  db.exec('ALTER TABLE reclamos ADD COLUMN subcategoria TEXT');
}
// Con qué precisión se conoce `fecha`. Los archivos importados a veces traen
// sólo el mes ("ABRIL"): se guarda el día 1, pero marcado como 'mes' para no
// hacer pasar por exacta una fecha que no lo es. 'exacta' cuando vino día y
// hora; NULL en las filas viejas y en las que no tienen fecha.
if (!reclamosColumns.includes('precision_fecha')) {
  db.exec('ALTER TABLE reclamos ADD COLUMN precision_fecha TEXT');
}
// De qué archivo vino la fila, cuando entró por scripts/import-reclamos.js.
// Es lo que permite deshacer una importación puntual sin restaurar un backup
// entero (`--revert`). NULL en todo lo que no vino de un import.
if (!reclamosColumns.includes('import_origen')) {
  db.exec('ALTER TABLE reclamos ADD COLUMN import_origen TEXT');
}

const reclamosDdl =
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reclamos'").get()?.sql || '';
// Dos motivos para reconstruir, los dos por CHECKs que SQLite no sabe alterar:
//   - el CHECK viejo de `categoria`, que ya no va (la lista vive en config/);
//   - el CHECK de `geo_status`, si todavía no conoce 'no_encontrada'.
const sobraCheckCategoria = /CHECK\s*\(\s*categoria\s+IN/i.test(reclamosDdl);
const faltaNoEncontrada =
  /CHECK\s*\(\s*geo_status\s+IN/i.test(reclamosDdl) && !reclamosDdl.includes("'no_encontrada'");
if (sobraCheckCategoria || faltaNoEncontrada) {
  console.log(
    `[db] Migrando \`reclamos\`:${sobraCheckCategoria ? ' se quita el CHECK de categoria;' : ''}` +
    `${faltaNoEncontrada ? " se agrega 'no_encontrada' a geo_status;" : ''}`
  );
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE reclamos_nueva (
        id TEXT PRIMARY KEY,
        comentario_id TEXT UNIQUE,
        plataforma TEXT NOT NULL CHECK(plataforma IN (${PLATAFORMA_SQL_LIST})),
        post_url TEXT,
        comment_url TEXT,
        autor TEXT,
        fecha TEXT,
        detected_at TEXT NOT NULL,
        texto_original TEXT NOT NULL,
        categoria TEXT NOT NULL,
        subcategoria TEXT,
    precision_fecha TEXT,
    import_origen TEXT,
        direccion_detectada TEXT,
        direccion_normalizada TEXT,
        calle TEXT,
        altura INTEGER,
        cruce TEXT,
        x REAL,
        y REAL,
        comuna INTEGER,
        barrio TEXT,
        precision TEXT,
        geo_status TEXT CHECK(geo_status IN (${GEO_STATUS_SQL_LIST})),
        estado TEXT NOT NULL DEFAULT 'Pendiente' CHECK(estado IN (${ESTADO_SQL_LIST}))
      )
    `);
    db.exec(`
      INSERT INTO reclamos_nueva
      SELECT id, comentario_id, plataforma, post_url, comment_url, autor, fecha, detected_at,
             texto_original, categoria, subcategoria, precision_fecha, import_origen, direccion_detectada, direccion_normalizada,
             calle, altura, cruce, x, y, comuna, barrio, precision, geo_status, estado
      FROM reclamos
    `);
    db.exec('DROP TABLE reclamos');
    db.exec('ALTER TABLE reclamos_nueva RENAME TO reclamos');
    db.exec('COMMIT');
    console.log('[db] Migración de `reclamos` completada.');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
// Fase H (openspec/changes/geo-pro): la ubicación que devolvió el modelo y
// lo que resolvió el servidor. Van DESPUÉS de la reconstrucción de arriba,
// que no las conoce. ubicacion_tipo: calle_altura | cruce | lugar | villa |
// barrio | lineal | ninguna (el que quedó al resolver). motivo_sin_ubicar:
// lineal | fuera_de_caba | ambigua | no_encontrada | sin_direccion |
// descartado. ubicacion_json: la `ubicacion` del modelo, tal cual (y la
// corrección del equipo, si la hubo). corregida_por: el correo de quien la
// corrigió a mano; nunca sale a la API.
const reclamosColumnsGeo = db.prepare('PRAGMA table_info(reclamos)').all().map((c) => c.name);
for (const col of ['ubicacion_tipo', 'nombre_lugar', 'motivo_sin_ubicar', 'ubicacion_json', 'corregida_por', 'descarte_motivo']) {
  if (!reclamosColumnsGeo.includes(col)) db.exec(`ALTER TABLE reclamos ADD COLUMN ${col} TEXT`);
}
// `precision` era exacta | aproximada; pasa a puntual | cruce | lugar | area |
// ninguna. Solo toca los valores viejos (y los vacíos), así que correrla de
// nuevo no cambia nada. Lo que ya tenía punto recibe también el tipo de
// ubicación, y lo que no, su motivo; una mención de solo el barrio no lleva
// motivo (no es un "sin ubicar"): el siguiente arranque no se lo puede poner.
db.exec(`
  UPDATE reclamos SET precision = CASE
      WHEN x IS NULL OR y IS NULL OR (x = 0 AND y = 0) THEN 'ninguna'
      WHEN precision = 'aproximada' THEN 'lugar'
      WHEN COALESCE(cruce, '') <> '' THEN 'cruce'
      ELSE 'puntual' END
  WHERE precision IS NULL OR precision IN ('exacta', 'aproximada')
`);
db.exec(`
  UPDATE reclamos SET ubicacion_tipo = CASE
      WHEN precision = 'lugar' THEN 'lugar'
      WHEN precision = 'cruce' THEN 'cruce'
      ELSE 'calle_altura' END
  WHERE ubicacion_tipo IS NULL AND precision IN ('puntual', 'cruce', 'lugar')
`);
db.exec(`
  UPDATE reclamos SET motivo_sin_ubicar = CASE geo_status
      WHEN 'fuera_caba' THEN 'fuera_de_caba'
      WHEN 'no_encontrada' THEN 'no_encontrada'
      ELSE 'sin_direccion' END
  WHERE motivo_sin_ubicar IS NULL AND precision = 'ninguna' AND geo_status IN ('fuera_caba', 'no_encontrada', 'sin_direccion', 'invalida')
    AND COALESCE(ubicacion_tipo, '') <> 'barrio'
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_direccion_normalizada ON reclamos(direccion_normalizada)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_categoria ON reclamos(categoria)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_subcategoria ON reclamos(subcategoria)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_estado ON reclamos(estado)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_plataforma ON reclamos(plataforma)');
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_fecha ON reclamos(fecha)');

db.exec(`
  CREATE TABLE IF NOT EXISTS x_influencers (
    handle TEXT PRIMARY KEY,
    lista TEXT NOT NULL DEFAULT 'antik-pro',
    tipo_identidad TEXT NOT NULL CHECK(tipo_identidad IN ('con_identidad','sin_identidad')),
    seguidores INTEGER,
    updated_at TEXT NOT NULL
  )
`);

const upsertXInfluencerStmt = db.prepare(`
  INSERT INTO x_influencers (handle, lista, tipo_identidad, seguidores, updated_at)
  VALUES (@handle, @lista, @tipoIdentidad, @seguidores, @updatedAt)
  ON CONFLICT(handle) DO UPDATE SET
    lista = excluded.lista,
    tipo_identidad = excluded.tipo_identidad,
    seguidores = excluded.seguidores,
    updated_at = excluded.updated_at
`);
const getXInfluencerStmt = db.prepare('SELECT * FROM x_influencers WHERE handle = ?');
const listXInfluencersStmt = db.prepare('SELECT * FROM x_influencers ORDER BY handle');
const countXInfluencersStmt = db.prepare('SELECT COUNT(*) AS total FROM x_influencers');

function upsertXInfluencer(row) {
  upsertXInfluencerStmt.run({
    handle: row.handle,
    lista: row.lista || 'antik-pro',
    tipoIdentidad: row.tipoIdentidad || 'sin_identidad',
    seguidores: row.seguidores ?? null,
    updatedAt: row.updatedAt || new Date().toISOString(),
  });
}

function upsertXInfluencers(rows) {
  const now = new Date().toISOString();
  const list = rows || [];
  db.exec('BEGIN');
  try {
    for (const row of list) {
      upsertXInfluencer({ ...row, updatedAt: now });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return list.length;
}

function getXInfluencer(handle) {
  return getXInfluencerStmt.get(handle) || null;
}

function listXInfluencers() {
  return listXInfluencersStmt.all();
}

function countXInfluencers() {
  return countXInfluencersStmt.get().total;
}

/** Mapa handle → fila, para el cruce de identidad en el análisis. */
function getXInfluencerMap() {
  const map = new Map();
  for (const row of listXInfluencers()) {
    map.set(row.handle, {
      handle: row.handle,
      lista: row.lista,
      tipoIdentidad: row.tipo_identidad,
      seguidores: row.seguidores,
    });
  }
  return map;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS geocode_cache (
    query_key TEXT PRIMARY KEY,
    lat REAL,
    lng REAL,
    display_name TEXT,
    status TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  )
`);
// Migración incremental: caché de calle/altura/cruce/comuna/barrio por
// dirección, para no volver a pedirle esos datos a USIG cuando otra fila
// comparte la misma dirección normalizada.
const geocodeCacheColumns = db.prepare('PRAGMA table_info(geocode_cache)').all().map((c) => c.name);
for (const col of ['calle', 'altura', 'cruce', 'comuna', 'barrio']) {
  if (!geocodeCacheColumns.includes(col)) {
    const type = col === 'altura' || col === 'comuna' ? 'INTEGER' : 'TEXT';
    db.exec(`ALTER TABLE geocode_cache ADD COLUMN ${col} ${type}`);
  }
}
// Los lugares con nombre ya resueltos (src/geo/gazetteer.js): la dirección
// para mostrar (la del dataset o la geocodificación inversa de USIG) y el
// punto, por nombre normalizado. Los lugares no se mueven: no vence.
db.exec(`
  CREATE TABLE IF NOT EXISTS lugar_cache (
    clave TEXT PRIMARY KEY,
    nombre TEXT,
    x REAL,
    y REAL,
    direccion TEXT,
    fuente TEXT,
    fetched_at TEXT NOT NULL
  )
`);

// Mediana de likes/comentarios por cuenta (y por tipo de posteo, si se pudo
// determinar) — la referencia contra la que se clasifica un posteo detectado
// como alto/normal/bajo. Ver src/accountStats.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS account_stats (
    account TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    post_type TEXT CHECK(post_type IN ('reel','imagen','carrusel') OR post_type IS NULL),
    n_posts INTEGER NOT NULL,
    median_likes REAL,
    median_comments REAL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (account, plataforma, post_type)
  )
`);
// Bases anteriores tienen la columna como `platform` (así nació en la base
// común de refactor y main). RENAME COLUMN reescribe también la PRIMARY KEY
// compuesta y conserva las filas. Va antes de los prepare de abajo, que ya
// nombran `plataforma`.
const accountStatsColumns = db.prepare('PRAGMA table_info(account_stats)').all().map((c) => c.name);
if (accountStatsColumns.includes('platform') && !accountStatsColumns.includes('plataforma')) {
  db.exec('ALTER TABLE account_stats RENAME COLUMN platform TO plataforma');
}

// INSERT/UPDATE separados en vez de "INSERT ... ON CONFLICT": SQLite trata
// cada NULL como distinto de cualquier otro NULL a los fines de la
// restricción UNIQUE/PRIMARY KEY, así que "ON CONFLICT(account, plataforma,
// post_type)" nunca dispara cuando post_type es NULL — cada recálculo de una
// cuenta sin tipo detectado insertaría una fila nueva en vez de actualizar
// la existente. Con el SELECT previo (que sí usa "IS") no depende de esa
// semántica de NULL para nada.
const insertAccountStatsStmt = db.prepare(`
  INSERT INTO account_stats (account, plataforma, post_type, n_posts, median_likes, median_comments, computed_at)
  VALUES (@account, @plataforma, @postType, @nPosts, @medianLikes, @medianComments, @computedAt)
`);
const updateAccountStatsStmt = db.prepare(`
  UPDATE account_stats
  SET n_posts = @nPosts, median_likes = @medianLikes, median_comments = @medianComments, computed_at = @computedAt
  WHERE account = @account AND plataforma = @plataforma AND post_type IS @postType
`);
// "post_type IS ?" (no "=") porque "= NULL" nunca matchea en SQL, ni para
// las cuentas sin desglose por tipo (post_type NULL de los dos lados).
const getAccountStatsStmt = db.prepare(`
  SELECT * FROM account_stats WHERE account = ? AND plataforma = ? AND post_type IS ?
`);
const getAccountStatsFreshnessStmt = db.prepare(`
  SELECT MAX(computed_at) AS lastComputedAt FROM account_stats WHERE account = ? AND plataforma = ?
`);
const listAllAccountStatsStmt = db.prepare('SELECT * FROM account_stats');

// Caché de seguidores por cuenta: tabla propia (no una columna más en
// account_stats) porque account_stats tiene hasta una fila por post_type y
// duplicaría el mismo número de seguidores en cada una, además de la
// ambigüedad de "cuál fila leer" si esa cuenta no tiene fila con
// post_type NULL. Se refresca con la misma cadencia que account_stats (ver
// computeAccountStats en src/accountStats.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS account_followers (
    account TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    followers INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account, plataforma)
  )
`);
// Mismo renombre que account_stats (ver arriba).
const accountFollowersColumns = db.prepare('PRAGMA table_info(account_followers)').all().map((c) => c.name);
if (accountFollowersColumns.includes('platform') && !accountFollowersColumns.includes('plataforma')) {
  db.exec('ALTER TABLE account_followers RENAME COLUMN platform TO plataforma');
}
const insertAccountFollowersStmt = db.prepare(`
  INSERT INTO account_followers (account, plataforma, followers, updated_at)
  VALUES (@account, @plataforma, @followers, @updatedAt)
`);
const updateAccountFollowersStmt = db.prepare(`
  UPDATE account_followers SET followers = @followers, updated_at = @updatedAt
  WHERE account = @account AND plataforma = @plataforma
`);
const getAccountFollowersStmt = db.prepare(
  'SELECT followers FROM account_followers WHERE account = ? AND plataforma = ?'
);

// Carga manual / recálculo forzado del benchmark (scripts/recalc-account-
// stats.js --todas): el universo de cuentas a procesar es la unión de las
// trackeadas (config/monitoring.json) con las que ya aparecen en
// detected_posts (llegaron por hashtag, nunca se trackearon explícitamente).
// El ciclo automático NO usa este universo: usa listAccountBenchmarkActivity.
const listDistinctPostAccountsStmt = db.prepare(
  `SELECT DISTINCT account FROM detected_posts WHERE ignored = 0 AND plataforma = ? AND account IS NOT NULL AND account != 'N/D' ORDER BY account`
);
// Qué cuentas tienen que recalcular su benchmark, derivado SOLO de la base
// (ver accountStats.refreshStaleAccountStats): una fila por cuenta con
// posteos visibles en detected_posts, con la fecha del último posteo
// detectado, la del último cálculo (la fila global de account_stats,
// post_type NULL: es la que se escribe en cada intento, con o sin datos
// suficientes) y `eligibleSince`, la fecha del primer posteo que dispara el
// recálculo: cualquiera si nunca se calculó, o uno detectado @recalcDays o
// más días después del último cálculo. NULL = no hay nada que recalcular.
// Como todo sale de detected_at vs. computed_at, una cuenta que quedó
// fuera del tope en un ciclo sigue elegible en el siguiente sin guardar
// estado en memoria, y una recalculada deja de serlo sola (su computed_at
// pasa a ser posterior a sus posteos).
// Join case-insensitive: el nombre devuelto es el de account_stats si
// existe (así el recálculo pisa esas filas y no crea otras con distinta
// capitalización), si no el del posteo.
const listAccountBenchmarkActivityStmt = db.prepare(`
  SELECT
    COALESCE(s.account, MIN(p.account)) AS account,
    MAX(p.detected_at) AS lastDetectedAt,
    s.computed_at AS lastComputedAt,
    MIN(CASE
          WHEN s.computed_at IS NULL
            OR julianday(p.detected_at) - julianday(s.computed_at) >= @recalcDays
          THEN p.detected_at
        END) AS eligibleSince
  FROM detected_posts p
  LEFT JOIN (
    SELECT lower(account) AS k, MIN(account) AS account, MAX(computed_at) AS computed_at
    FROM account_stats
    WHERE plataforma = @plataforma AND post_type IS NULL
    GROUP BY lower(account)
  ) s ON s.k = lower(p.account)
  WHERE p.plataforma = @plataforma AND p.ignored = 0 AND p.account IS NOT NULL AND p.account != 'N/D'
  GROUP BY lower(p.account)
  ORDER BY eligibleSince, account
`);
// Un intento de recálculo que no trajo datos suficientes deja la
// referencia anterior intacta y solo avanza la fecha (ver
// accountStats.computeAccountStats): la cuenta cuenta como calculada y no
// vuelve a la cola en cada ciclo.
const touchAccountStatsComputedAtStmt = db.prepare(
  'UPDATE account_stats SET computed_at = @computedAt WHERE lower(account) = lower(@account) AND plataforma = @plataforma'
);
const getPostMetricsStmt = db.prepare('SELECT likes, comments, post_type, ignored FROM detected_posts WHERE id = ?');
const updatePostMetricsStmt = db.prepare(
  'UPDATE detected_posts SET likes = @likes, comments = @comments, post_type = @postType, metrics_updated_at = @metricsUpdatedAt, refresh_misses = 0, refresh_stopped_at = NULL WHERE id = @id'
);
const updateFollowersForAccountStmt = db.prepare(
  'UPDATE detected_posts SET followers = ? WHERE account = ? AND plataforma = ?'
);

// Marcas de "último pase" de los tramos tibio/frío del refresco de métricas
// (ver src/metricsRefresh.js) — en la base, no en memoria, para que
// sobrevivan a un reinicio del proceso. Clave/valor genérico en vez de
// columnas sueltas: solo dos claves hoy, pero no ata el esquema a eso.
db.exec(`
  CREATE TABLE IF NOT EXISTS refresh_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
const getRefreshStateStmt = db.prepare('SELECT value FROM refresh_state WHERE key = ?');
const setRefreshStateStmt = db.prepare(`
  INSERT INTO refresh_state (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const deleteRefreshStateStmt = db.prepare('DELETE FROM refresh_state WHERE key = ?');
// Por prefijo con substr, nunca LIKE: una clave puede traer "%" o "_" (un
// término de búsqueda es texto libre).
const listRefreshStateByPrefixStmt = db.prepare('SELECT key, value FROM refresh_state WHERE substr(key, 1, length(@prefix)) = @prefix ORDER BY key');

// Resultados de la búsqueda por palabra clave de Instagram a los que ya se
// les pidió el detalle (ver enrichSearchResults en src/monitor.js). La
// búsqueda devuelve los posteos sin caption ni contadores, así que evaluar
// uno nuevo cuesta una consulta de detalle; esta tabla evita pagarla dos
// veces por un posteo que terminó descartado (los guardados ya están en
// detected_posts). outcome: guardado | descartado | sin_caption |
// sin_detalle. Se purga a los 100 días (SEARCH_SEEN_TTL_DAYS en monitor.js):
// la búsqueda trae contenido de la ventana del ciclo, un id viejo no vuelve,
// y Estadísticas cuenta los descartados de períodos de hasta 90 días.
db.exec(`
  CREATE TABLE IF NOT EXISTS search_seen (
    post_id TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    url TEXT,
    term TEXT,
    outcome TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (post_id, plataforma)
  )
`);
// Desde noviembre 2026 (openspec/changes/ventana-por-fuente) la tabla anota
// TODO lo que decidió el clasificador sobre un resultado de búsqueda, se
// haya pagado o no su detalle (las búsquedas ya traen el texto): así un
// descartado no se vuelve a clasificar en cada corrida. Columnas nuevas, las
// cinco anulables (las filas anteriores no las tienen): posted_at (la fecha
// de publicación, para contarlo en su día), motivo (el del modelo), llm_usd
// (lo que costó esa clasificación, estimado), run_id (la corrida que lo
// decidió) y terminos (JSON: todos los términos que lo trajeron; el primero
// es `term`, el del motivo).
const searchSeenColumns = db.prepare('PRAGMA table_info(search_seen)').all().map((c) => c.name);
for (const [col, type] of [['posted_at', 'TEXT'], ['motivo', 'TEXT'], ['llm_usd', 'REAL'], ['run_id', 'INTEGER'], ['terminos', 'TEXT']]) {
  if (!searchSeenColumns.includes(col)) db.exec(`ALTER TABLE search_seen ADD COLUMN ${col} ${type}`);
}
const getSearchSeenStmt = db.prepare(`
  SELECT post_id AS postId, plataforma, url, term, outcome, first_seen_at AS firstSeenAt,
         posted_at AS postedAt, motivo, llm_usd AS llmUsd, run_id AS runId, terminos
  FROM search_seen WHERE post_id = ? AND plataforma = ?
`);
// first_seen_at no se pisa: es la fecha de la primera decisión, la que
// cuenta para la purga. `term` tampoco (es el del motivo). Lo demás se
// completa si llega: un dato nuevo pisa, uno ausente conserva el guardado.
const markSearchSeenStmt = db.prepare(`
  INSERT INTO search_seen (post_id, plataforma, url, term, outcome, first_seen_at, posted_at, motivo, llm_usd, run_id, terminos)
  VALUES (@postId, @plataforma, @url, @term, @outcome, @firstSeenAt, @postedAt, @motivo, @llmUsd, @runId, @terminos)
  ON CONFLICT(post_id, plataforma) DO UPDATE SET
    outcome = excluded.outcome,
    posted_at = COALESCE(excluded.posted_at, posted_at),
    motivo = COALESCE(excluded.motivo, motivo),
    llm_usd = COALESCE(excluded.llm_usd, llm_usd),
    run_id = COALESCE(excluded.run_id, run_id),
    terminos = COALESCE(excluded.terminos, terminos)
`);
const setSearchSeenTermsStmt = db.prepare('UPDATE search_seen SET terminos = @terminos WHERE post_id = @postId AND plataforma = @plataforma');
const purgeSearchSeenStmt = db.prepare('DELETE FROM search_seen WHERE first_seen_at < ?');
// Lo que decidió el clasificador en una corrida (para la línea de costo del ciclo).
const sumSearchSeenByRunStmt = db.prepare('SELECT COUNT(*) AS n, SUM(llm_usd) AS usd FROM search_seen WHERE run_id = ?');

// Gasto en Apify (ver src/apifyCost.js): una fila por llamada a runActorSync
// (src/apify.js) y una por ciclo de monitoreo (src/scheduler.js). Apify
// cobra por item devuelto, así que `items` cuenta TODO lo que vino en el
// dataset, incluidos los items de error (no_items / not_found), que se
// cobran igual. Una llamada fallida también se registra (items 0, ok 0,
// error con el mensaje, o 'QUOTA_EXCEEDED' si fue la cuota). `usd` va con
// la tarifa del plan activo al momento de registrar; los reportes
// recalculan desde `items` con las tres tarifas.
db.exec(`
  CREATE TABLE IF NOT EXISTS apify_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    run_id INTEGER,
    phase TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    target TEXT,
    results_type TEXT,
    items INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    duration_ms INTEGER,
    usd REAL NOT NULL DEFAULT 0
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_apify_calls_at ON apify_calls(at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_apify_calls_run_id ON apify_calls(run_id)');
// Costo por actor (ver src/apifyCost.js): qué actor corrió la llamada, el
// tipo de consulta (user | hashtag | search | post | details), lo que Apify
// cobró de verdad por el run (usageTotalUsd; solo cuando la llamada fue por
// el flujo asincrónico, hoy el actor apidojo) y el id del run. Las filas
// anteriores a estas columnas quedan con actor NULL = el actor oficial.
const apifyCallsColumns = db.prepare('PRAGMA table_info(apify_calls)').all().map((c) => c.name);
for (const [col, type] of [['actor', 'TEXT'], ['query_type', 'TEXT'], ['usd_real', 'REAL'], ['apify_run_id', 'TEXT']]) {
  if (!apifyCallsColumns.includes(col)) db.exec(`ALTER TABLE apify_calls ADD COLUMN ${col} ${type}`);
}
// El análisis de publicación al que pertenece la llamada (tabla analisis):
// así el gasto de Apify de cada análisis es la suma de sus filas. null en
// todo lo demás (monitoreo, validación, scripts).
if (!apifyCallsColumns.includes('analisis_id')) db.exec('ALTER TABLE apify_calls ADD COLUMN analisis_id INTEGER');
// Desde noviembre 2026 (openspec/changes/ventana-por-fuente): cómo quedó la
// llamada (`estado`: en_curso | ok | error | esperando | parcial |
// recuperada | perdida; NULL en las filas anteriores, que se leen por `ok`),
// y lo que se le pidió al actor (`max_items`, `until`). `esperando`: la app
// dejó de esperar el run, que sigue en Apify con su id guardado, y alguien
// lo va a levantar; al levantarlo la fila pasa a `recuperada` con ok = 1 y
// sus resultados, así las sumas de siempre siguen valiendo.
for (const [col, type] of [['estado', 'TEXT'], ['max_items', 'INTEGER'], ['until', 'TEXT']]) {
  if (!apifyCallsColumns.includes(col)) db.exec(`ALTER TABLE apify_calls ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_apify_calls_analisis_id ON apify_calls(analisis_id)');
// Una fila por ciclo (cron o "Actualizar ahora"); los totales se completan
// al terminar sumando las filas de apify_calls con ese run_id.
db.exec(`
  CREATE TABLE IF NOT EXISTS monitoring_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    "trigger" TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    new_posts INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    results INTEGER NOT NULL DEFAULT 0,
    usd REAL NOT NULL DEFAULT 0,
    quota_exceeded INTEGER NOT NULL DEFAULT 0
  )
`);
// Posteos nuevos de la corrida (monitor.isNewPost, antes del detalle): la
// etapa "nuevas" del Pipeline del Monitoreo. Anulable: las corridas
// anteriores a la columna no lo tienen y la pantalla muestra "—".
const monitoringRunsColumns = db.prepare('PRAGMA table_info(monitoring_runs)').all().map((c) => c.name);
if (!monitoringRunsColumns.includes('new_candidates')) {
  db.exec('ALTER TABLE monitoring_runs ADD COLUMN new_candidates INTEGER');
}
// Si el ciclo entero tiró (un error de plataforma en una corrida manual),
// el código del error: la corrida no fue "ok" (src/runStatus.js).
if (!monitoringRunsColumns.includes('error_code')) {
  db.exec('ALTER TABLE monitoring_runs ADD COLUMN error_code TEXT');
}
// Corridas hondas (src/deepRun.js): 1 si la corrida fue honda (sus búsquedas
// miraron la ventana honda), 0 si fue corta, NULL en las anteriores y cuando
// las hondas están apagadas.
if (!monitoringRunsColumns.includes('honda')) {
  db.exec('ALTER TABLE monitoring_runs ADD COLUMN honda INTEGER');
}

// Una fila por consulta de detección de cada ciclo (noviembre 2026,
// openspec/changes/ventana-por-fuente): qué fuente se consultó, con qué
// ventana y tope, cómo terminó y, si fue una corrida de Apify, su id. Es a
// la vez el registro de qué falló en una corrida (src/runStatus.js calcula
// el estado al leer) y la cola de las corridas que siguen en Apify y hay que
// levantar (estado `esperando`). tipo: busqueda | cuenta | hashtag | keyword
// | detalle (el detalle de los resultados nuevos) | plataforma (no se buscó
// nada: el motivo dice por qué). `clave` es la fuente normalizada, la misma
// de la marca de detección. `intento` 2 es la segunda consulta por tope
// lleno. `detalle` es el texto crudo del error, acotado: sirve al log y a
// los scripts y NUNCA sale por la API. Sin CHECK en `estado` (ver
// src/runStatus.js para los valores).
db.exec(`
  CREATE TABLE IF NOT EXISTS monitoring_run_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    plataforma TEXT NOT NULL,
    tipo TEXT NOT NULL,
    fuente TEXT,
    clave TEXT,
    intento INTEGER NOT NULL DEFAULT 1,
    estado TEXT NOT NULL,
    motivo TEXT,
    detalle TEXT,
    actor TEXT,
    apify_run_id TEXT,
    desde_iso TEXT,
    until TEXT,
    tope INTEGER,
    items INTEGER,
    nuevos INTEGER,
    tope_lleno INTEGER NOT NULL DEFAULT 0,
    hueco_desde TEXT,
    recuperada_en INTEGER,
    recuperada_at TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duracion_ms INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_run_sources_run ON monitoring_run_sources(run_id, plataforma)');
db.exec('CREATE INDEX IF NOT EXISTS idx_run_sources_estado ON monitoring_run_sources(plataforma, estado)');
const insertRunSourceStmt = db.prepare(`
  INSERT INTO monitoring_run_sources
    (run_id, plataforma, tipo, fuente, clave, intento, estado, motivo, detalle, actor, apify_run_id, desde_iso, until, tope, items, nuevos,
     tope_lleno, hueco_desde, started_at, finished_at, duracion_ms)
  VALUES
    (@runId, @plataforma, @tipo, @fuente, @clave, @intento, @estado, @motivo, @detalle, @actor, @apifyRunId, @desdeIso, @until, @tope, @items, @nuevos,
     @topeLleno, @huecoDesde, @startedAt, @finishedAt, @duracionMs)
`);
const getRunSourceStmt = db.prepare('SELECT * FROM monitoring_run_sources WHERE id = ?');
const listRunSourcesStmt = db.prepare('SELECT * FROM monitoring_run_sources WHERE run_id = ? AND plataforma = ? ORDER BY id');
const listRunSourcesAllStmt = db.prepare('SELECT * FROM monitoring_run_sources WHERE run_id = ? ORDER BY id');
// Las búsquedas que una corrida levantó de corridas anteriores.
const listRunSourcesRecoveredInStmt = db.prepare('SELECT * FROM monitoring_run_sources WHERE recuperada_en = ? AND plataforma = ? ORDER BY id');
const listPendingRunSourcesStmt = db.prepare(
  "SELECT * FROM monitoring_run_sources WHERE plataforma = ? AND estado IN ('esperando', 'en curso') ORDER BY id"
);
// La segunda consulta de una búsqueda se levantó después y cubrió lo que
// faltaba: la primera de esa corrida deja de estar marcada como tope lleno.
const clearTopeLlenoPrimerIntentoStmt = db.prepare(
  'UPDATE monitoring_run_sources SET tope_lleno = 0 WHERE run_id = ? AND plataforma = ? AND tipo = ? AND clave = ? AND intento = 1 AND tope_lleno = 1'
);
const lastRunSourcesForKeyStmt = db.prepare(
  "SELECT * FROM monitoring_run_sources WHERE plataforma = ? AND tipo = ? AND clave = ? AND intento = 1 AND estado <> 'en curso' ORDER BY id DESC LIMIT ?"
);
// Completado ÚNICO de las corridas anteriores a la tabla (marca
// `fuentes_por_corrida_backfill` en refresh_state): una fila por cada
// consulta de detección que quedó en apify_calls (las búsquedas; y, en las
// corridas viejas de Instagram, los perfiles y hashtags de la fase
// monitoreo), `fallo` si la llamada falló. Así las corridas que ya estaban
// en la base dicen la verdad: las que tuvieron búsquedas caídas pasan a
// "incompleta". En una transacción; si algo falla no queda nada a medias y
// se reintenta en el próximo arranque.
if (!getRefreshStateStmt.get('fuentes_por_corrida_backfill')) {
  const { motivoDeFallo } = require('./runStatus');
  const TIPO_POR_CONSULTA = { search: 'busqueda', user: 'cuenta', hashtag: 'hashtag' };
  const fuenteDe = (call) => {
    const target = String(call.target || '');
    if (call.query_type === 'hashtag') return decodeURIComponent((/\/explore\/tags\/([^/?#]+)/.exec(target) || [])[1] || target);
    if (call.query_type === 'user') return (/instagram\.com\/([^/?#]+)/.exec(target) || [])[1] || target;
    return target;
  };
  db.exec('BEGIN');
  try {
    const llamadas = db
      .prepare(
        `SELECT c.* FROM apify_calls c
         WHERE c.run_id IS NOT NULL AND c.phase IN ('monitoreo', 'busqueda') AND c.query_type IN ('search', 'user', 'hashtag')
           AND EXISTS (SELECT 1 FROM monitoring_runs r WHERE r.id = c.run_id)
           AND NOT EXISTS (SELECT 1 FROM monitoring_run_sources s WHERE s.run_id = c.run_id)
         ORDER BY c.id`
      )
      .all();
    for (const call of llamadas) {
      const fuente = fuenteDe(call);
      const finMs = Date.parse(call.at);
      const inicio = Number.isFinite(finMs) && call.duration_ms != null ? new Date(finMs - call.duration_ms).toISOString() : call.at;
      insertRunSourceStmt.run({
        runId: call.run_id,
        plataforma: call.plataforma,
        tipo: TIPO_POR_CONSULTA[call.query_type],
        fuente,
        clave: String(fuente).trim().toLowerCase().replace(/^[@#]/, ''),
        intento: 1,
        estado: call.ok ? 'ok' : 'fallo',
        motivo: call.ok ? null : motivoDeFallo(call.error),
        detalle: call.ok || !call.error ? null : String(call.error).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        actor: call.actor,
        apifyRunId: call.apify_run_id,
        desdeIso: null,
        until: call.until ?? null,
        tope: call.max_items ?? null,
        items: call.items,
        nuevos: null,
        topeLleno: 0,
        huecoDesde: null,
        startedAt: inicio,
        finishedAt: call.at,
        duracionMs: call.duration_ms,
      });
    }
    setRefreshStateStmt.run({ key: 'fuentes_por_corrida_backfill', value: new Date().toISOString() });
    db.exec('COMMIT');
    if (llamadas.length > 0) console.log(`[db] fuentes por corrida: ${llamadas.length} consulta(s) de corridas anteriores registradas.`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[db] No se pudieron registrar las fuentes de las corridas anteriores (se reintenta en el próximo arranque):', err.message);
  }
}
const insertApifyCallStmt = db.prepare(`
  INSERT INTO apify_calls (at, run_id, phase, plataforma, actor, query_type, target, results_type, items, ok, error, duration_ms, usd, usd_real, apify_run_id, analisis_id, estado, max_items, until)
  VALUES (@at, @runId, @phase, @plataforma, @actor, @queryType, @target, @resultsType, @items, @ok, @error, @durationMs, @usd, @usdReal, @apifyRunId, @analisisId, @estado, @maxItems, @until)
`);
// Cierre de una fila abierta al arrancar el run (apifyCost.openApifyCall).
const closeApifyCallStmt = db.prepare(`
  UPDATE apify_calls
  SET items = @items, ok = @ok, error = @error, duration_ms = @durationMs, usd = @usd, estado = @estado
  WHERE id = @id
`);
const getApifyCallStmt = db.prepare('SELECT * FROM apify_calls WHERE id = ?');
// Una llamada que quedó esperando (o abierta) y cuyo resultado se levantó
// después: pasa a contar como una llamada buena, con lo que trajo.
const markApifyCallRecoveredStmt = db.prepare(`
  UPDATE apify_calls SET ok = 1, error = NULL, items = @items, usd = @usd, estado = 'recuperada'
  WHERE apify_run_id = @apifyRunId AND estado IN ('esperando', 'en_curso')
`);
const markApifyCallLostStmt = db.prepare(`
  UPDATE apify_calls SET estado = 'perdida' WHERE apify_run_id = @apifyRunId AND estado IN ('esperando', 'en_curso')
`);
const listApifyCallsByApifyRunStmt = db.prepare('SELECT * FROM apify_calls WHERE apify_run_id = ? ORDER BY id');
// Asiento de una corrida que la app cortó sin registrar (scripts/costo-apify.js
// --asentar): las llamadas fallidas y sin run de un ciclo, y la escritura del
// run y de su costo real en una de ellas.
const listFailedCallsWithoutRunStmt = db.prepare(
  'SELECT id, target, query_type AS queryType, phase, error FROM apify_calls WHERE run_id = ? AND ok = 0 AND apify_run_id IS NULL ORDER BY id'
);
const settleApifyCallStmt = db.prepare('UPDATE apify_calls SET apify_run_id = @apifyRunId, usd_real = @usdReal WHERE id = @id AND apify_run_id IS NULL');
const listApifyRunIdsSinceStmt = db.prepare('SELECT DISTINCT apify_run_id AS id FROM apify_calls WHERE apify_run_id IS NOT NULL AND at >= ?');
// Las últimas búsquedas buenas de una red, para medir el volumen de un
// término (src/busquedaTope.js). El término se compara en JS
// (lastSearchCallsForTerm): el lower() de SQLite no pasa a minúsculas las
// letras acentuadas ("POLICÍA" quedaba "policÍa" y nunca encontraba su
// historia).
const lastSearchCallsStmt = db.prepare(`
  SELECT id, target, items, max_items AS maxItems, until, at FROM apify_calls
  WHERE plataforma = @plataforma AND query_type = 'search' AND ok = 1
  ORDER BY id DESC LIMIT @limit
`);
// Cuántas búsquedas buenas de la red se recorren para encontrar las de un
// término: con 8 búsquedas y 4 corridas por día, más de un mes.
const SEARCH_HISTORY_SCAN = 1500;
// Las sumas van por fase Y por actor: el actor oficial se valúa por
// resultados (tres tarifas), apidojo por consulta. usdBest = lo que cobró
// Apify si se sabe (usd_real), si no el estimado (usd).
const OFFICIAL_ACTOR_SQL = "'apify~instagram-scraper'";
const insertMonitoringRunStmt = db.prepare(
  'INSERT INTO monitoring_runs (started_at, "trigger", plataforma, honda) VALUES (@startedAt, @trigger, @plataforma, @honda)'
);
// La última corrida honda TERMINADA: cerró sin que el ciclo tirara y alguna
// búsqueda respondió o quedó en Apify (una honda en la que no respondió
// ninguna no cuenta: no trajo nada). Una corrida sin búsquedas cuenta.
const getLastFinishedDeepRunAtStmt = db.prepare(`
  SELECT MAX(r.finished_at) AS at FROM monitoring_runs r
  WHERE r.honda = 1 AND r.finished_at IS NOT NULL AND r.error_code IS NULL
    AND (
      NOT EXISTS (SELECT 1 FROM monitoring_run_sources s WHERE s.run_id = r.id AND s.tipo = 'busqueda')
      OR EXISTS (
        SELECT 1 FROM monitoring_run_sources s
        WHERE s.run_id = r.id AND s.tipo = 'busqueda' AND s.estado IN ('ok', 'parcial', 'esperando', 'recuperada')
      )
    )
`);
const sumApifyCallsByRunStmt = db.prepare(`
  SELECT phase, COALESCE(actor, ${OFFICIAL_ACTOR_SQL}) AS actor, COUNT(*) AS calls, COALESCE(SUM(items), 0) AS results,
         COALESCE(SUM(usd), 0) AS usd, SUM(usd_real) AS usdReal, SUM(usd_real IS NOT NULL) AS withReal,
         COALESCE(SUM(COALESCE(usd_real, usd)), 0) AS usdBest,
         SUM(CASE WHEN error = 'QUOTA_EXCEEDED' THEN 1 ELSE 0 END) AS quotaErrors
  FROM apify_calls WHERE run_id = ? GROUP BY phase, actor ORDER BY phase, actor
`);
const finishMonitoringRunStmt = db.prepare(`
  UPDATE monitoring_runs
  SET finished_at = @finishedAt, new_posts = @newPosts, new_candidates = @newCandidates, calls = @calls, results = @results,
      usd = @usd, quota_exceeded = @quotaExceeded, error_code = @errorCode
  WHERE id = @id
`);
const getMonitoringRunStmt = db.prepare('SELECT * FROM monitoring_runs WHERE id = ?');
// La última corrida terminada de una plataforma, entera (el Pipeline del
// Monitoreo). Mismo criterio de plataforma que getLastFinishedRunAtStmt.
const getLastFinishedRunStmt = db.prepare(`
  SELECT * FROM monitoring_runs
  WHERE finished_at IS NOT NULL
    AND (plataforma = 'todas' OR (',' || plataforma || ',') LIKE ('%,' || ? || ',%'))
  ORDER BY finished_at DESC
  LIMIT 1
`);
// Lo que trajeron las consultas de detección de una corrida en una red: los
// resultados de las búsquedas (y, en una red que consulta cuentas o
// hashtags para detectar, los de esas consultas). El detalle de los nuevos
// (query_type post) no es detección: son los mismos posteos otra vez.
const sumDetectionItemsStmt = db.prepare(`
  SELECT COUNT(*) AS calls, COALESCE(SUM(items), 0) AS items
  FROM apify_calls
  WHERE run_id = ? AND plataforma = ? AND phase IN ('monitoreo', 'busqueda') AND query_type IN ('search', 'user', 'hashtag')
`);
// Posteos guardados entre dos instantes (detected_at), para contar los
// destacados de una corrida.
const listPostsDetectedBetweenStmt = db.prepare(`
  SELECT id, account, post_type, likes, comments FROM detected_posts
  WHERE ignored = 0 AND plataforma = ? AND detected_at >= ? AND detected_at <= ?
`);
// Fin de la última corrida terminada de una plataforma. La columna
// plataforma dice qué corrió el ciclo: una sola ("instagram"), varias
// separadas por coma ("instagram,x", el cron) o "todas".
const getLastFinishedRunAtStmt = db.prepare(`
  SELECT finished_at FROM monitoring_runs
  WHERE finished_at IS NOT NULL
    AND (plataforma = 'todas' OR (',' || plataforma || ',') LIKE ('%,' || ? || ',%'))
  ORDER BY finished_at DESC
  LIMIT 1
`);
// Fin de la última corrida terminada, de la plataforma que sea (el inicio,
// que no es de ninguna red).
const getLastFinishedRunAtAnyStmt = db.prepare(`
  SELECT finished_at FROM monitoring_runs
  WHERE finished_at IS NOT NULL
  ORDER BY finished_at DESC
  LIMIT 1
`);
// Estadísticas (src/stats.js): los posteos visibles de una plataforma
// publicados en un rango, con lo justo para contar y calcular el alcance.
// posted_at se guarda en ISO UTC con milisegundos ("2026-10-13T16:12:21.000Z"),
// así que el rango se compara como texto, como en el resto de este archivo.
const listPostsForStatsStmt = db.prepare(`
  SELECT id, account, title, caption, sentiment, tema, likes, comments, followers, post_type, posted_at, matched_reason
  FROM detected_posts
  WHERE plataforma = ? AND ignored = 0 AND posted_at >= ? AND posted_at < ?
  ORDER BY posted_at
`);
// Las menciones por término de Estadísticas cuentan también lo que no quedó:
// los ignorados (por posted_at, como el resto) y los resultados de búsqueda
// descartados, por su fecha de publicación (search_seen.posted_at, desde
// noviembre 2026). Las filas anteriores no la tienen: van por first_seen_at,
// el día en que se decidieron (con la ventana de la detección, el mismo día
// de la publicación o el siguiente).
const listIgnoredPostsForStatsStmt = db.prepare(`
  SELECT matched_reason FROM detected_posts
  WHERE plataforma = ? AND ignored = 1 AND posted_at >= ? AND posted_at < ?
`);
const countDiscardedSearchesForStatsStmt = db.prepare(`
  SELECT term, COUNT(*) AS n FROM search_seen
  WHERE plataforma = ? AND outcome = 'descartado' AND term IS NOT NULL
    AND COALESCE(posted_at, first_seen_at) >= ? AND COALESCE(posted_at, first_seen_at) < ?
  GROUP BY term
`);
// Rastros de corridas de una plataforma en un rango, para contar en cuántos
// días hubo alguna (el aviso "período anterior con pocas corridas" de
// Estadísticas): el arranque de cada corrida terminada y, como
// monitoring_runs existe recién desde el 23/9/2026, también cuándo se
// detectó un posteo (visible o ignorado) o se vio un resultado de búsqueda:
// eso solo pasa en una corrida.
// Desde noviembre 2026 (openspec/changes/ventana-por-fuente) una corrida que
// no detectó nada en esa red NO es un rastro: no se buscó nada (una fila
// `plataforma` en monitoring_run_sources) o no respondió ninguna de sus
// fuentes (ni se levantó después). Antes, un día cuya única corrida tenía
// todas las búsquedas caídas contaba como "día con corridas" y con cero
// publicaciones. Una corrida sin filas (anterior a la tabla) cuenta como
// siempre. La tabla se crea más abajo: por eso el statement se prepara al
// usarlo (ver listRunTracesForStats).
const LIST_RUN_TRACES_FOR_STATS_SQL = `
  SELECT r.started_at AS t FROM monitoring_runs r
  WHERE r.finished_at IS NOT NULL AND r.started_at >= @desde AND r.started_at < @hasta
    AND (r.plataforma = 'todas' OR (',' || r.plataforma || ',') LIKE ('%,' || @plataforma || ',%'))
    AND NOT EXISTS (
      SELECT 1 FROM monitoring_run_sources s WHERE s.run_id = r.id AND s.plataforma = @plataforma AND s.tipo = 'plataforma'
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM monitoring_run_sources s
        WHERE s.run_id = r.id AND s.plataforma = @plataforma AND s.tipo IN ('busqueda', 'cuenta', 'hashtag', 'keyword')
      )
      OR EXISTS (
        SELECT 1 FROM monitoring_run_sources s
        WHERE s.run_id = r.id AND s.plataforma = @plataforma AND s.tipo IN ('busqueda', 'cuenta', 'hashtag', 'keyword')
          AND s.estado IN ('ok', 'parcial', 'recuperada')
      )
    )
  UNION
  SELECT detected_at FROM detected_posts WHERE plataforma = @plataforma AND detected_at >= @desde AND detected_at < @hasta
  UNION
  SELECT first_seen_at FROM search_seen WHERE plataforma = @plataforma AND first_seen_at >= @desde AND first_seen_at < @hasta
`;
let listRunTracesForStatsStmt = null;
// El primer posteo visible de la plataforma: antes de ese día no hay datos,
// que no es lo mismo que un día sin publicaciones.
const getFirstPostedAtStmt = db.prepare(
  'SELECT MIN(posted_at) AS first FROM detected_posts WHERE plataforma = ? AND ignored = 0 AND posted_at IS NOT NULL'
);
// El resumen público del login (src/publicResumen.js) cuenta TODAS las redes
// y solo cantidades: ningún texto de un posteo sale de estas lecturas.
const countPostedSinceAllStmt = db.prepare('SELECT COUNT(*) AS n FROM detected_posts WHERE ignored = 0 AND posted_at >= ?');
const countTemasSinceAllStmt = db.prepare(
  'SELECT tema, COUNT(*) AS n FROM detected_posts WHERE ignored = 0 AND posted_at >= ? GROUP BY tema'
);
// Desde cuándo escucha la app: la primera DETECCIÓN (no la primera fecha de
// publicación, que puede ser de días antes: la ventana de detección mira
// hacia atrás). Cuenta también los ignorados: la app ya estaba escuchando.
const getFirstDetectedAtAnyStmt = db.prepare(
  'SELECT MIN(detected_at) AS first FROM detected_posts WHERE detected_at IS NOT NULL'
);
// Los reclamos que dibuja el mapa, con su misma regla (listReclamosFiltered
// deja afuera los de fuera de CABA; claimsMap.js, hasMapLocation, pide x, y
// y dirección normalizada, y que el punto no sea el (0,0) que deja una
// respuesta de USIG sin coordenadas): los sin dirección, no encontrados,
// inválidos o pendientes no tienen pin.
const countReclamosEnMapaStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM reclamos
  WHERE geo_status IS NOT 'fuera_caba' AND x IS NOT NULL AND y IS NOT NULL AND NOT (x = 0 AND y = 0)
    AND COALESCE(direccion_normalizada, '') <> ''
`);
// Las corridas de una plataforma que arrancaron en un rango, terminadas o no:
// la línea de 24 h del inicio (src/inicioRoutes.js).
const listRunsBetweenStmt = db.prepare(`
  SELECT id, started_at, finished_at, "trigger", plataforma, new_candidates, new_posts, quota_exceeded, error_code FROM monitoring_runs
  WHERE started_at >= ? AND started_at < ?
    AND (plataforma = 'todas' OR (',' || plataforma || ',') LIKE ('%,' || ? || ',%'))
  ORDER BY started_at
`);
// Seguidores por cuenta para Estadísticas: la caché account_followers y, de
// respaldo, el número del posteo más reciente de la cuenta que lo trae.
const listCachedFollowersStmt = db.prepare(
  'SELECT account, followers FROM account_followers WHERE plataforma = ? AND followers IS NOT NULL'
);
const listLatestPostFollowersStmt = db.prepare(`
  SELECT account, followers FROM (
    SELECT account, followers,
      ROW_NUMBER() OVER (PARTITION BY account ORDER BY detected_at DESC, posted_at DESC) AS n
    FROM detected_posts
    WHERE plataforma = ? AND followers IS NOT NULL AND account IS NOT NULL
  )
  WHERE n = 1
`);
// Conciliación del costo real (apifyCost.reconcileRealCosts): llamadas con
// run de Apify conocido y sin usd_real todavía, en una ventana de antigüedad.
const listApifyCallsPendingRealCostStmt = db.prepare(`
  SELECT id, run_id AS runId, apify_run_id AS apifyRunId, usd, at
  FROM apify_calls
  WHERE apify_run_id IS NOT NULL AND usd_real IS NULL AND at <= @olderThanIso AND at >= @newerThanIso
  ORDER BY id LIMIT @limit
`);
const setApifyCallRealCostStmt = db.prepare('UPDATE apify_calls SET usd_real = @usdReal WHERE id = @id');
// Después de levantar una llamada de un ciclo ya cerrado: sus totales.
const recomputeMonitoringRunTotalsStmt = db.prepare(`
  UPDATE monitoring_runs
  SET usd = (SELECT COALESCE(SUM(COALESCE(usd_real, usd)), 0) FROM apify_calls WHERE run_id = @id),
      results = (SELECT COALESCE(SUM(items), 0) FROM apify_calls WHERE run_id = @id)
  WHERE id = @id
`);
const recomputeMonitoringRunUsdStmt = db.prepare(`
  UPDATE monitoring_runs
  SET usd = (SELECT COALESCE(SUM(COALESCE(usd_real, usd)), 0) FROM apify_calls WHERE run_id = @id)
  WHERE id = @id
`);
const sumApifyCallsSinceStmt = db.prepare(`
  SELECT phase, COALESCE(actor, ${OFFICIAL_ACTOR_SQL}) AS actor, COUNT(*) AS calls, COALESCE(SUM(items), 0) AS results,
         SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(usd), 0) AS usd, SUM(usd_real) AS usdReal, SUM(usd_real IS NOT NULL) AS withReal,
         COALESCE(SUM(COALESCE(usd_real, usd)), 0) AS usdBest
  FROM apify_calls WHERE at >= ? GROUP BY phase, actor ORDER BY phase, actor
`);

// Cuentas con posteos en una ventana de edad (sinceIso, untilIso], agrupadas
// con el conteo de posteos y el más reciente — para poder priorizar y armar
// el log de "N posteos en tramo X" sin una query aparte por cuenta. Un solo
// statement parametrizado para los 3 tramos del refresco de métricas:
// cadenceIso en NULL desactiva el filtro de metrics_updated_at (tramo
// caliente, que no tiene cadencia propia — el cron de 4hs ya lo es; y el
// barrido frío, gateado enteramente a nivel de tramo, no por posteo).
const listAccountsDueForRefreshStmt = db.prepare(`
  SELECT account, MAX(posted_at) AS mostRecentPostedAt, COUNT(*) AS postCount
  FROM detected_posts
  WHERE ignored = 0 AND plataforma = @plataforma AND account IS NOT NULL AND account != 'N/D' AND posted_at IS NOT NULL
    AND posted_at > @sinceIso AND posted_at <= @untilIso
    AND (@cadenceIso IS NULL OR metrics_updated_at IS NULL OR metrics_updated_at < @cadenceIso)
  GROUP BY account
`);

const getPostForMetricsRefreshStmt = db.prepare(
  'SELECT likes, comments, retweets, views, account, posted_at, ignored FROM detected_posts WHERE id = ?'
);
// Una respuesta válida reanuda el refresco del posteo (ver refresh_misses).
const applyMetricsRefreshStmt = db.prepare(
  'UPDATE detected_posts SET likes = @likes, comments = @comments, retweets = @retweets, views = @views, metrics_updated_at = @metricsUpdatedAt, refresh_misses = 0, refresh_stopped_at = NULL WHERE id = @id'
);

// Refresco de métricas POR PUBLICACIÓN (REFRESH_MODE=url, ver
// src/metricsRefresh.js): los posteos de una ventana de edad cuya última
// escritura de métricas es anterior a la cadencia. Un posteo nunca
// refrescado cuenta desde detected_at (al detectarse ya trae las métricas
// del detalle: entra recién cuando pasa la cadencia, no en el mismo ciclo).
// Quedan afuera los ignorados y los frenados (refresh_stopped_at). Orden:
// lo más atrasado primero (es el orden del tope dentro de cada tramo).
const listPostsDueForRefreshStmt = db.prepare(`
  SELECT id, url, account, posted_at AS postedAt, detected_at AS detectedAt,
    metrics_updated_at AS metricsUpdatedAt, COALESCE(metrics_updated_at, detected_at) AS lastWriteAt
  FROM detected_posts
  WHERE ignored = 0 AND refresh_stopped_at IS NULL AND plataforma = @plataforma
    AND url IS NOT NULL AND posted_at IS NOT NULL
    AND posted_at > @sinceIso AND posted_at <= @untilIso
    AND (@cadenceIso IS NULL OR COALESCE(metrics_updated_at, detected_at) IS NULL OR COALESCE(metrics_updated_at, detected_at) < @cadenceIso)
  ORDER BY COALESCE(metrics_updated_at, detected_at) ASC, posted_at DESC
`);
const registerRefreshMissStmt = db.prepare(`
  UPDATE detected_posts
  SET refresh_misses = refresh_misses + 1,
      refresh_stopped_at = CASE WHEN refresh_misses + 1 >= @stopAfter THEN @at ELSE refresh_stopped_at END
  WHERE id = @id AND ignored = 0
`);
const getRefreshMissStmt = db.prepare(
  'SELECT account, url, refresh_misses AS misses, refresh_stopped_at AS stoppedAt FROM detected_posts WHERE id = ?'
);

const INSERT_RECLAMO = `
  INSERT INTO reclamos (
    id, comentario_id, plataforma, post_url, comment_url, autor, fecha,
    detected_at, texto_original, categoria, subcategoria, precision_fecha, import_origen, direccion_detectada,
    direccion_normalizada, calle, altura, cruce, x, y, comuna, barrio,
    precision, geo_status, estado, ubicacion_tipo, nombre_lugar, motivo_sin_ubicar, ubicacion_json,
    corregida_por, descarte_motivo
  ) VALUES (
    @id, @comentarioId, @plataforma, @postUrl, @commentUrl, @autor, @fecha,
    @detectedAt, @textoOriginal, @categoria, @subcategoria, @precisionFecha, @importOrigen, @direccionDetectada,
    @direccionNormalizada, @calle, @altura, @cruce, @x, @y, @comuna, @barrio,
    @precision, @geoStatus, @estado, @ubicacionTipo, @nombreLugar, @motivoSinUbicar, @ubicacionJson,
    NULL, NULL
  )`;
const upsertReclamoStmt = db.prepare(`${INSERT_RECLAMO}
  ON CONFLICT(id) DO UPDATE SET
    comentario_id = excluded.comentario_id,
    plataforma = excluded.plataforma,
    post_url = excluded.post_url,
    comment_url = excluded.comment_url,
    autor = excluded.autor,
    fecha = excluded.fecha,
    detected_at = excluded.detected_at,
    texto_original = excluded.texto_original,
    categoria = excluded.categoria,
    subcategoria = excluded.subcategoria,
    precision_fecha = excluded.precision_fecha,
    import_origen = excluded.import_origen,
    direccion_detectada = excluded.direccion_detectada,
    direccion_normalizada = excluded.direccion_normalizada,
    calle = excluded.calle,
    altura = excluded.altura,
    cruce = excluded.cruce,
    x = excluded.x,
    y = excluded.y,
    comuna = excluded.comuna,
    barrio = excluded.barrio,
    precision = excluded.precision,
    geo_status = excluded.geo_status,
    estado = excluded.estado,
    ubicacion_tipo = excluded.ubicacion_tipo,
    nombre_lugar = excluded.nombre_lugar,
    motivo_sin_ubicar = excluded.motivo_sin_ubicar,
    ubicacion_json = excluded.ubicacion_json,
    corregida_por = NULL,
    descarte_motivo = NULL
`);
// La misma fila, para un análisis que vuelve a pasar por una publicación ya
// analizada (upsertReclamo con conservarGestion): el reclamo ya existe y
// alguien pudo haberle cambiado el estado ("En tratamiento", "Resuelto") y
// el geocodificado ya corrió. Se conservan el estado, la primera detección
// y, si la dirección detectada no cambió, todo el geocodificado; con la
// misma categoría, una subcategoría vacía (la llamada falló o el modelo dijo
// "ninguna") no borra la que había. El resto (texto, categoría) es lo que
// dijo el análisis nuevo. Desde la fase H, un reclamo corregido o descartado
// a mano conserva todo lo de su ubicación aunque la dirección detectada
// cambie: lo que decidió el equipo no lo pisa un análisis nuevo.
const GEO_SI_MISMA_DIRECCION = [
  'direccion_normalizada', 'calle', 'altura', 'cruce', 'x', 'y', 'comuna', 'barrio', 'precision', 'geo_status',
  'ubicacion_tipo', 'nombre_lugar', 'motivo_sin_ubicar', 'ubicacion_json', 'corregida_por', 'descarte_motivo',
]
  .map(
    (col) =>
      `${col} = CASE WHEN reclamos.corregida_por IS NOT NULL OR reclamos.motivo_sin_ubicar IS 'descartado'` +
      ` OR reclamos.direccion_detectada IS excluded.direccion_detectada THEN reclamos.${col} ELSE excluded.${col} END`
  )
  .join(',\n    ');
const upsertReclamoConservandoStmt = db.prepare(`${INSERT_RECLAMO}
  ON CONFLICT(id) DO UPDATE SET
    comentario_id = excluded.comentario_id,
    plataforma = excluded.plataforma,
    post_url = excluded.post_url,
    comment_url = excluded.comment_url,
    autor = excluded.autor,
    fecha = excluded.fecha,
    texto_original = excluded.texto_original,
    categoria = excluded.categoria,
    subcategoria = CASE WHEN reclamos.categoria IS excluded.categoria
      THEN COALESCE(NULLIF(excluded.subcategoria, ''), reclamos.subcategoria) ELSE excluded.subcategoria END,
    precision_fecha = excluded.precision_fecha,
    import_origen = excluded.import_origen,
    ${GEO_SI_MISMA_DIRECCION},
    direccion_detectada = excluded.direccion_detectada
`);
const listPendingGeoReclamosStmt = db.prepare(`SELECT * FROM reclamos WHERE geo_status = 'pendiente'`);
// El reintento único de los reclamos sin punto (geoWorker.reintentarSinCoordenadas):
// con una dirección escrita y sin coordenadas, o en el (0,0) que dejaba una
// respuesta de USIG sin punto (geocode.js lo leía como 0).
const listSinCoordenadasStmt = db.prepare(`
  SELECT id FROM reclamos
  WHERE TRIM(COALESCE(direccion_detectada, '')) <> ''
    AND (x IS NULL OR y IS NULL OR (x = 0 AND y = 0))
`);
const reabrirGeoStmt = db.prepare(`
  UPDATE reclamos SET geo_status = 'pendiente', x = NULL, y = NULL, comuna = NULL, barrio = NULL WHERE id = ?
`);
const contarUbicadosStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM reclamos
  WHERE id IN (SELECT value FROM json_each(?))
    AND geo_status = 'ok' AND x IS NOT NULL AND y IS NOT NULL AND NOT (x = 0 AND y = 0)
`);
const updateEstadoStmt = db.prepare('UPDATE reclamos SET estado = ? WHERE id = ?');
const updateReclamoGeoStmt = db.prepare(`
  UPDATE reclamos
  SET direccion_normalizada = @direccionNormalizada,
      calle = @calle,
      altura = @altura,
      cruce = @cruce,
      x = @x,
      y = @y,
      comuna = @comuna,
      barrio = @barrio,
      precision = @precision,
      geo_status = @geoStatus,
      ubicacion_tipo = COALESCE(@ubicacionTipo, ubicacion_tipo),
      nombre_lugar = @nombreLugar,
      motivo_sin_ubicar = @motivoSinUbicar
  WHERE id = @id
`);
// Lo que se escribe al corregir o descartar a mano (Mapa, fase H) y al
// aplicar el reproceso: la ubicación del modelo (o la corrección) y quién.
const setReclamoUbicacionStmt = db.prepare(`
  UPDATE reclamos SET ubicacion_tipo = @ubicacionTipo, ubicacion_json = @ubicacionJson WHERE id = @id
`);
const marcarReclamoCorregidoStmt = db.prepare(`
  UPDATE reclamos SET corregida_por = @corregidaPor, descarte_motivo = NULL, ubicacion_json = @ubicacionJson WHERE id = @id
`);
const descartarReclamoStmt = db.prepare(`
  UPDATE reclamos
  SET motivo_sin_ubicar = 'descartado', descarte_motivo = @motivo, corregida_por = @corregidaPor,
      x = NULL, y = NULL, comuna = NULL, barrio = NULL, precision = 'ninguna', nombre_lugar = NULL,
      direccion_normalizada = NULL, geo_status = 'sin_direccion'
  WHERE id = @id
`);
const getReclamoStmt = db.prepare('SELECT * FROM reclamos WHERE id = ?');
const getLugarCacheStmt = db.prepare('SELECT * FROM lugar_cache WHERE clave = ?');
const setLugarCacheStmt = db.prepare(`
  INSERT INTO lugar_cache (clave, nombre, x, y, direccion, fuente, fetched_at)
  VALUES (@clave, @nombre, @x, @y, @direccion, @fuente, @fetchedAt)
  ON CONFLICT(clave) DO UPDATE SET
    nombre = excluded.nombre, x = excluded.x, y = excluded.y, direccion = excluded.direccion,
    fuente = excluded.fuente, fetched_at = excluded.fetched_at
`);
const getGeocodeCacheStmt = db.prepare('SELECT * FROM geocode_cache WHERE query_key = ?');
const setGeocodeCacheStmt = db.prepare(`
  INSERT INTO geocode_cache (
    query_key, lat, lng, display_name, status, fetched_at, calle, altura, cruce, comuna, barrio
  )
  VALUES (
    @queryKey, @lat, @lng, @displayName, @status, @fetchedAt, @calle, @altura, @cruce, @comuna, @barrio
  )
  ON CONFLICT(query_key) DO UPDATE SET
    lat = excluded.lat,
    lng = excluded.lng,
    display_name = excluded.display_name,
    status = excluded.status,
    fetched_at = excluded.fetched_at,
    calle = excluded.calle,
    altura = excluded.altura,
    cruce = excluded.cruce,
    comuna = excluded.comuna,
    barrio = excluded.barrio
`);

// Los análisis de publicación (src/analysisJob.js, openspec/changes/
// analisis-v4): uno por pedido de "Analizar", con su estado mientras corre
// y todo lo que mostró al terminar, para volver a verlo sin gastar. Sin
// CHECK: el estado y los tonos son listas que pueden cambiar. Los campos
// JSON (resultado, temas, comentarios, cuando) los arma y los lee solo este
// módulo. El link va normalizado a /p/<code>/ (el mismo posteo con
// ?igsh= o /reel/ es el mismo).
db.exec(`
  CREATE TABLE IF NOT EXISTS analisis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plataforma TEXT NOT NULL,
    url TEXT NOT NULL,
    post_code TEXT,
    post_id TEXT,
    estado TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    analizado_por TEXT,
    cuenta TEXT,
    cuenta_nombre TEXT,
    caption TEXT,
    posted_at TEXT,
    post_type TEXT,
    likes INTEGER,
    comentarios_total INTEGER,
    vistas INTEGER,
    traidos INTEGER,
    unicos INTEGER,
    enviados INTEGER,
    analizados INTEGER,
    positivos INTEGER,
    neutrales INTEGER,
    negativos INTEGER,
    ruido INTEGER,
    positivo_pct INTEGER,
    negativo_pct INTEGER,
    nivel TEXT,
    resultado TEXT,
    temas TEXT,
    comentarios TEXT,
    cuando TEXT,
    reporte_antes TEXT,
    reporte_despues TEXT,
    csv TEXT,
    reclamos INTEGER,
    usd_apify REAL,
    usd_modelo REAL,
    tokens INTEGER,
    image_source_url TEXT,
    image_status TEXT,
    image_saved_at TEXT,
    image_width INTEGER,
    image_height INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_analisis_lista ON analisis(plataforma, estado, finished_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_analisis_url ON analisis(plataforma, url)');
// Fase F: lo que lista y ordena la galería sin abrir el JSON (se escriben
// al terminar; tema_estrella también al renombrar un tema).
const analisisColumns = db.prepare('PRAGMA table_info(analisis)').all().map((c) => c.name);
for (const [col, type] of [['pct_neg', 'REAL'], ['tiene_hecho', 'INTEGER'], ['n_verificados', 'INTEGER'], ['tema_estrella', 'TEXT']]) {
  if (!analisisColumns.includes(col)) db.exec(`ALTER TABLE analisis ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_analisis_cuenta ON analisis(plataforma, cuenta, started_at)');

// Figuras públicas (fase F, src/figuras.js): el rol y la alineación de quien
// comenta. La mantiene el equipo; el modelo solo deja sugerencias
// (origen 'sugerida') que nunca pisan una fila del equipo, y una sugerida
// que el equipo descarta queda como 'descartada' (fase F2). Sin CHECK: la
// validación vive en src/figuras.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS figuras_publicas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    nombre TEXT,
    rol TEXT NOT NULL,
    alineacion TEXT,
    origen TEXT NOT NULL,
    notas TEXT,
    creado_por TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  )
`);

const insertAnalisisStmt = db.prepare(`
  INSERT INTO analisis (plataforma, url, post_code, estado, started_at, analizado_por)
  VALUES (@plataforma, @url, @postCode, 'en curso', @startedAt, @analizadoPor)
`);
const updateAnalisisPostStmt = db.prepare(`
  UPDATE analisis SET post_id = @postId, cuenta = @cuenta, cuenta_nombre = @cuentaNombre, caption = @caption,
    posted_at = @postedAt, post_type = @postType, likes = @likes, comentarios_total = @comentariosTotal, vistas = @vistas
  WHERE id = @id AND plataforma = @plataforma
`);
const finishAnalisisStmt = db.prepare(`
  UPDATE analisis SET estado = 'ok', error = NULL, finished_at = @finishedAt,
    traidos = @traidos, unicos = @unicos, enviados = @enviados, analizados = @analizados,
    positivos = @positivos, neutrales = @neutrales, negativos = @negativos, ruido = @ruido,
    positivo_pct = @positivoPct, negativo_pct = @negativoPct, nivel = @nivel,
    resultado = @resultado, temas = @temas, comentarios = @comentarios, cuando = @cuando,
    reporte_antes = @reporteAntes, reporte_despues = @reporteDespues, csv = @csv, reclamos = @reclamos,
    usd_apify = @usdApify, usd_modelo = @usdModelo, tokens = @tokens,
    pct_neg = @pctNeg, tiene_hecho = @tieneHecho, n_verificados = @nVerificados, tema_estrella = @temaEstrella
  WHERE id = @id AND plataforma = @plataforma
`);
const failAnalisisStmt = db.prepare(`
  UPDATE analisis SET estado = @estado, error = @error, finished_at = @finishedAt, traidos = COALESCE(@traidos, traidos),
    usd_apify = @usdApify, usd_modelo = @usdModelo, tokens = @tokens
  WHERE id = @id AND plataforma = @plataforma
`);
const markAnalisisImageStmt = db.prepare(`
  UPDATE analisis SET image_source_url = @sourceUrl, image_status = @status,
    image_saved_at = COALESCE(@savedAt, image_saved_at), image_width = COALESCE(@width, image_width),
    image_height = COALESCE(@height, image_height)
  WHERE id = @id AND plataforma = @plataforma
`);
const getAnalisisStmt = db.prepare('SELECT * FROM analisis WHERE id = ? AND plataforma = ?');
// Los reclamos de un análisis se buscan por su publicación (la galería los
// cuenta por cada análisis): sin este índice recorría todos los de la red.
db.exec('CREATE INDEX IF NOT EXISTS idx_reclamos_post ON reclamos(plataforma, post_url)');
// Las columnas livianas: lo que necesitan la tira de recientes, el inicio y
// el aviso de "ya analizado" (sin comentarios ni informe).
const ANALISIS_LIVIANO = `id, plataforma, url, post_code, post_id, estado, started_at, finished_at, cuenta, cuenta_nombre, caption,
  posted_at, likes, comentarios_total, traidos, analizados, positivos, neutrales, negativos, ruido, image_saved_at,
  pct_neg, tiene_hecho, n_verificados, tema_estrella,
  (SELECT COUNT(*) FROM reclamos r WHERE r.plataforma = analisis.plataforma AND r.post_url = analisis.url) AS reclamos_post`;
const listAnalisisStmt = db.prepare(`
  SELECT ${ANALISIS_LIVIANO} FROM analisis WHERE plataforma = ? AND estado = 'ok' ORDER BY finished_at DESC, id DESC LIMIT ?
`);
const findAnalisisByUrlStmt = db.prepare(`
  SELECT ${ANALISIS_LIVIANO} FROM analisis WHERE plataforma = ? AND url = ? AND estado = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 1
`);
const updateAnalisisTemasStmt = db.prepare("UPDATE analisis SET temas = ? WHERE id = ? AND plataforma = ? AND estado = 'ok'");
const updateTemaEstrellaStmt = db.prepare("UPDATE analisis SET tema_estrella = ? WHERE id = ? AND plataforma = ? AND estado = 'ok'");
const updateColumnasGaleriaStmt = db.prepare(`
  UPDATE analisis SET pct_neg = @pctNeg, tiene_hecho = @tieneHecho, n_verificados = @nVerificados, tema_estrella = @temaEstrella
  WHERE id = @id AND plataforma = @plataforma AND estado = 'ok'
`);
// La galería: los terminados bien de la plataforma (se filtran y ordenan en
// listAnalisisGaleria; son cientos, no miles: con más de 2000, la búsqueda y
// los filtros miran los 2000 más recientes). total y desde, de todos.
const listAnalisisGaleriaStmt = db.prepare(`
  SELECT ${ANALISIS_LIVIANO} FROM analisis WHERE plataforma = ? AND estado = 'ok' ORDER BY finished_at DESC, id DESC LIMIT 2000
`);
const resumenGaleriaStmt = db.prepare("SELECT COUNT(*) AS total, MIN(finished_at) AS desde FROM analisis WHERE plataforma = ? AND estado = 'ok'");
// Los análisis anteriores de una cuenta, para la comparación: sin el
// actual ni otros de la misma publicación, y de cada publicación anterior
// solo el último (re-analizar una no la cuenta dos veces). La ventana va
// solo sobre id y fecha y las columnas pesadas (comentarios) se leen de los
// elegidos: con SELECT * ordenaba todo y, con 300 análisis de una cuenta,
// tardaba casi un segundo con el servidor parado.
const listAnterioresDeCuentaStmt = db.prepare(`
  SELECT id, started_at, finished_at, post_code, pct_neg, comentarios_total, n_verificados, comentarios, temas
  FROM analisis
  WHERE id IN (
    SELECT id FROM (
      SELECT id, started_at, ROW_NUMBER() OVER (PARTITION BY COALESCE(post_code, 'id:' || id) ORDER BY started_at DESC, id DESC) AS rn
      FROM analisis
      WHERE plataforma = @plataforma AND estado = 'ok' AND cuenta = @cuenta AND id <> @id AND started_at < @antesDe
        AND (@postCode IS NULL OR post_code IS NULL OR post_code <> @postCode)
    )
    WHERE rn = 1
    ORDER BY started_at DESC, id DESC LIMIT @limit
  )
  ORDER BY started_at DESC, id DESC
`);
// Los reclamos de una publicación (los guarda el análisis con su post_url),
// con la regla del pin del mapa (ver countReclamosEnMapaStmt).
const listReclamosDePostStmt = db.prepare(`
  SELECT id, autor, categoria, subcategoria, direccion_detectada, direccion_normalizada, barrio, comuna, x, y,
    geo_status, estado, precision, ubicacion_tipo, nombre_lugar, motivo_sin_ubicar, texto_original, fecha,
    CASE WHEN geo_status IS NOT 'fuera_caba' AND x IS NOT NULL AND y IS NOT NULL AND NOT (x = 0 AND y = 0)
      AND COALESCE(direccion_normalizada, '') <> '' THEN 1 ELSE 0 END AS en_mapa
  FROM reclamos WHERE plataforma = ? AND post_url = ? ORDER BY detected_at, id
`);
// "Eliminar análisis" de la galería (deleteAnalisis). Las llamadas a Apify
// del análisis quedan: lo gastado sigue en los gastos (AUTOINCREMENT no
// reusa el número, así que su analisis_id no se confunde con otro).
const deleteAnalisisStmt = db.prepare('DELETE FROM analisis WHERE id = ? AND plataforma = ?');
const countOtrosAnalisisDeUrlStmt = db.prepare('SELECT COUNT(*) AS n FROM analisis WHERE plataforma = ? AND url = ? AND id <> ?');
const countOtrosAnalisisDePostIdStmt = db.prepare('SELECT COUNT(*) AS n FROM analisis WHERE plataforma = ? AND post_id = ? AND id <> ?');
const deleteReclamosDePostStmt = db.prepare('DELETE FROM reclamos WHERE plataforma = ? AND post_url = ? AND import_origen IS NULL');
const isDetectedPostStmt = db.prepare('SELECT 1 FROM detected_posts WHERE id = ? AND plataforma = ?');
// "Ver posteo" del Mapa: la publicación del Monitoreo (no ignorada: el pop-up abre solo las de la tabla).
const findMonitoredPostByUrlStmt = db.prepare('SELECT id FROM detected_posts WHERE plataforma = ? AND url = ? AND ignored = 0 LIMIT 1');

// Figuras públicas.
const listFigurasStmt = db.prepare('SELECT * FROM figuras_publicas ORDER BY username');
const getFiguraStmt = db.prepare('SELECT * FROM figuras_publicas WHERE username = ?');
const getFigurasPorUsernamesStmt = db.prepare('SELECT * FROM figuras_publicas WHERE username IN (SELECT value FROM json_each(?))');
const insertFiguraStmt = db.prepare(`
  INSERT INTO figuras_publicas (username, nombre, rol, alineacion, origen, notas, creado_por, creado_en, actualizado_en)
  VALUES (@username, @nombre, @rol, @alineacion, @origen, @notas, @creadoPor, @ahora, @ahora)
`);
// creado_por: quien la cargó o, en una que vino del modelo, quien la confirmó.
const updateFiguraStmt = db.prepare(`
  UPDATE figuras_publicas SET nombre = @nombre, rol = @rol, alineacion = @alineacion, origen = @origen, notas = @notas,
    creado_por = COALESCE(creado_por, @creadoPor), actualizado_en = @ahora
  WHERE username = @username
`);
const updateFiguraSugeridaStmt = db.prepare(`
  UPDATE figuras_publicas SET rol = @rol, alineacion = @alineacion, actualizado_en = @ahora
  WHERE username = @username AND origen = 'sugerida'
`);
const descartarFiguraStmt = db.prepare(`
  UPDATE figuras_publicas SET origen = 'descartada', actualizado_en = @ahora
  WHERE username = @username AND origen = 'sugerida'
`);
const deleteFiguraStmt = db.prepare('DELETE FROM figuras_publicas WHERE username = ?');
const markInterruptedAnalisisStmt = db.prepare(`
  UPDATE analisis SET estado = 'interrumpido', finished_at = ?,
    error = 'El servidor se reinició con el análisis en curso.',
    usd_apify = COALESCE(usd_apify, (SELECT COALESCE(SUM(COALESCE(usd_real, usd)), 0) FROM apify_calls WHERE apify_calls.analisis_id = analisis.id))
  WHERE estado = 'en curso'
`);
const sumApifyUsdForAnalisisStmt = db.prepare(
  'SELECT COALESCE(SUM(COALESCE(usd_real, usd)), 0) AS usd, COUNT(*) AS calls FROM apify_calls WHERE analisis_id = ?'
);

// Los análisis terminados antes de la fase F no tienen las columnas de la
// galería: se completan una vez con lo que ya guardaron, con la MISMA cuenta
// que la vista (analysisMetrics.js), así la galería y el análisis abierto
// dicen lo mismo. Un v1 no tiene hecho dominante. n_verificados es la
// marca: un v2 la escribe al terminar, así que esto nunca toca uno nuevo.
try {
  const sinColumnas = db
    .prepare("SELECT id, analizados, resultado, comentarios, temas FROM analisis WHERE estado = 'ok' AND n_verificados IS NULL")
    .all();
  const rellenar = db.prepare('UPDATE analisis SET pct_neg = ?, tiene_hecho = ?, n_verificados = ?, tema_estrella = COALESCE(tema_estrella, ?) WHERE id = ?');
  for (const row of sinColumnas) {
    // Fila por fila: una rara no deja sin columnas a las demás. Se marca con
    // n_verificados 0 para no volver a probarla en cada arranque.
    try {
      const col = analysisMetrics.columnasDeVista(
        analysisMetrics.buildAnalysisView({
          analizados: row.analizados,
          resultado: parseJsonColumn(row.resultado),
          comentarios: parseJsonColumn(row.comentarios),
          temas: parseJsonColumn(row.temas),
        })
      );
      rellenar.run(col.pctNeg, col.tieneHecho ? 1 : 0, col.nVerificados, col.temaEstrella, row.id);
    } catch (err) {
      console.warn(`[db] el análisis #${row.id} no se pudo completar para la galería: ${err && err.message}`);
      rellenar.run(null, 0, 0, null, row.id);
    }
  }
} catch (err) {
  console.warn(`[db] no se pudieron completar las columnas de los análisis anteriores: ${err && err.message}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )
`);

const insertMagicLinkStmt = db.prepare(`
  INSERT INTO magic_links (token_hash, email, expires_at, used_at)
  VALUES (@tokenHash, @email, @expiresAt, NULL)
`);
const claimMagicLinkStmt = db.prepare(`
  UPDATE magic_links
  SET used_at = ?
  WHERE token_hash = ?
    AND used_at IS NULL
    AND expires_at > ?
`);
const getMagicLinkStmt = db.prepare('SELECT email FROM magic_links WHERE token_hash = ?');
const deleteUnusedMagicLinksStmt = db.prepare('DELETE FROM magic_links WHERE email = ? AND used_at IS NULL');

// Sesiones (noviembre 2026, src/auth/session.js): la cookie lleva un id al
// azar; acá queda solo su SHA-256 (id_hash), como con los magic links, nunca
// el id en claro. Tiempos en milisegundos (Date.now()). Revocable: logout,
// un correo que sale de la allowlist, o a mano.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email)');

const createSessionStmt = db.prepare(`
  INSERT INTO sessions (id_hash, email, created_at, last_seen_at, revoked)
  VALUES (@idHash, @email, @createdAt, @lastSeenAt, 0)
`);
const getSessionStmt = db.prepare(
  'SELECT id_hash, email, created_at, last_seen_at, revoked FROM sessions WHERE id_hash = ?'
);
const touchSessionStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ? AND revoked = 0');
const revokeSessionStmt = db.prepare('UPDATE sessions SET revoked = 1 WHERE id_hash = ?');
const revokeSessionsByEmailStmt = db.prepare('UPDATE sessions SET revoked = 1 WHERE email = ? AND revoked = 0');
const purgeSessionsStmt = db.prepare(
  'DELETE FROM sessions WHERE revoked = 1 OR last_seen_at < @idleBefore OR created_at < @createdBefore'
);

function findExistingPostId(id, url) {
  if (id && isKnownPostStmt.get(id)) return id;
  if (url) {
    const row = getPostIdByUrlStmt.get(url);
    if (row) return row.id;
  }
  return null;
}

function isKnownPost(id, url) {
  return findExistingPostId(id, url) != null;
}

// Defensa en profundidad: además de la limpieza del centinela -1 en el
// origen (src/monitor.js), rechazamos acá cualquier likes/comments negativo
// que igual llegara a guardarse (de esta fuente o de alguna futura) — un
// dato faltante se guarda NULL, nunca un número negativo ni 0 inventado.
function rejectNegative(value) {
  return typeof value === 'number' && value < 0 ? null : value;
}

// Regla única de métricas al REFRESCAR un posteo ya guardado
// (applyMetricsRefresh, updatePostMetricsIfChanged; ver
// openspec/changes/refresco-url, REQ-RURL-06): un valor ausente (undefined),
// null o negativo (el centinela -1 de Apify, un contador oculto) NUNCA pisa
// lo guardado de ESE campo, aunque el otro campo sí venga; solo un número
// >= 0 pisa. Antes `likes ?? null` escribía NULL encima de un valor real
// cuando faltaba uno solo de los dos (y el 0 de un contador oculto pisaba un
// número real: eso se corta en el adapter, que lo deja en null).
function keepIfMissing(next, existing) {
  return typeof next === 'number' && Number.isFinite(next) && next >= 0 ? next : existing;
}

/**
 * @returns {boolean} true si se insertó una fila nueva. false si ya existía
 * (mismo id o misma url) — no tira UNIQUE.
 * @throws {Error} code 'PLATAFORMA_INCONSISTENTE' si el dominio de la url es
 *   de otra red que `plataforma` (una publicación de X nunca se guarda como
 *   Instagram, ni al revés). Un dominio desconocido no se valida: la regla
 *   se garantiza acá, al escribir, no solo al leer.
 */
function saveDetectedPost(post) {
  const plataforma = requirePlataforma(post.plataforma, 'saveDetectedPost');
  const plataformaDeLaUrl = platformForUrl(post.url);
  if (plataformaDeLaUrl && plataformaDeLaUrl !== plataforma) {
    const e = new Error(
      `El posteo ${post.id} tiene url de ${plataformaDeLaUrl} (${post.url}) pero plataforma "${plataforma}": no se guarda.`
    );
    e.code = 'PLATAFORMA_INCONSISTENTE';
    throw e;
  }
  const result = insertPostStmt.run({
    id: post.id,
    account: post.account || null,
    url: post.url,
    caption: post.caption || '',
    matchedReason: post.matchedReason || '',
    likes: rejectNegative(post.likes ?? null),
    comments: rejectNegative(post.comments ?? null),
    postedAt: post.postedAt || null,
    detectedAt: new Date().toISOString(),
    title: post.title || null,
    sentiment: post.sentiment || null,
    tema: post.tema || null,
    postType: post.postType || null,
    followers: post.followers ?? null,
    plataforma,
    retweets: rejectNegative(post.retweets ?? null),
    views: rejectNegative(post.views ?? null),
  });
  return result.changes > 0;
}

/**
 * Página de posteos detectados (los más nuevos primero) + el total de filas,
 * para poder armar la paginación en la interfaz. Los ignorados no salen:
 * siguen en la tabla SQLite para el dedupe, pero no en este listado.
 * `plataforma` filtra a una sola plataforma; sin ella, vienen todas.
 */
function listDetectedPosts({ page = 1, pageSize = 20, plataforma } = {}) {
  const total = plataforma ? countPostsByPlataformaStmt.get(plataforma).total : countPostsStmt.get().total;
  const offset = (page - 1) * pageSize;
  const posts = plataforma
    ? listPostsPageByPlataformaStmt.all(plataforma, pageSize, offset)
    : listPostsPageStmt.all(pageSize, offset);
  return { posts, total };
}

/**
 * Posteos guardados (no ignorados) a los que les falta algo de la
 * clasificación: título/sentimiento (posteos viejos de antes de esta
 * funcionalidad, o alguno que falló al clasificar) o el tema (los guardados
 * antes de la columna tema). Trae `title` para que el backfill sepa qué
 * completar en cada fila. Sirve para el "backfill" manual.
 */
function listUnclassified({ plataforma } = {}) {
  return plataforma ? listUnclassifiedByPlataformaStmt.all(plataforma) : listUnclassifiedStmt.all();
}

/**
 * Completa título, sentimiento y tema de un posteo sin clasificar
 * (backfill); el tema solo si estaba vacío. Con `matchedReason` también
 * reescribe matched_reason (el backfill le suma el motivo del modelo y le
 * saca la marca "sin clasificar"); sin él, no lo toca.
 */
function updateClassification(id, { title, sentiment, tema = null, matchedReason }) {
  if (matchedReason === undefined) {
    updateClassificationStmt.run(title, sentiment, tema, id);
  } else {
    updateClassificationConMotivoStmt.run(title, sentiment, tema, matchedReason, id);
  }
}

/**
 * Completa SOLO el tema de un posteo ya clasificado (backfill de los
 * guardados antes de la columna): no toca título, sentimiento ni
 * matched_reason, y un tema ya guardado no se pisa. Solo si el posteo es de
 * ESA plataforma.
 * @returns {boolean} true si se escribió el tema.
 */
function updateTema(id, tema, plataforma) {
  requirePlataforma(plataforma, 'updateTema');
  return updateTemaStmt.run(tema, id, plataforma).changes > 0;
}

/**
 * Corrección manual del sentimiento de un registro (por si Haiku se
 * equivocó). No toca el título ni ningún otro campo. Solo si el posteo es
 * de ESA plataforma.
 * @returns {boolean} true si existía en esa plataforma y se actualizó.
 */
function updateSentiment(id, sentiment, plataforma) {
  requirePlataforma(plataforma, 'updateSentiment');
  return updateSentimentStmt.run(sentiment, id, plataforma).changes > 0;
}

/**
 * Marca un posteo como ignorado (cruz de la tabla de monitoreo). La fila
 * se queda: findExistingPostId y el unique de url siguen viéndola, así que
 * la próxima corrida no la re-detecta ni re-notifica. No hay deshacer en
 * la UI; ignored_at queda para auditoría. Si ya estaba ignorado, no pisa
 * la fecha original. Solo si el posteo es de ESA plataforma.
 * @returns {boolean} true si el posteo existe en esa plataforma (ignorado
 *   recién o de antes); false si no existe ahí — nada se toca.
 */
function ignorePost(id, plataforma) {
  requirePlataforma(plataforma, 'ignorePost');
  if (!postExistsInPlataformaStmt.get(id, plataforma)) return false;
  ignorePostStmt.run(new Date().toISOString(), id, plataforma);
  return true;
}

function getPostIgnoreState(id) {
  const row = getPostIgnoredAtStmt.get(id);
  if (!row) return null;
  return { ignored: row.ignored === 1, ignoredAt: row.ignored_at || null };
}

function mapReclamoRow(row) {
  return {
    id: row.id,
    comentarioId: row.comentario_id,
    plataforma: row.plataforma,
    postUrl: row.post_url,
    commentUrl: row.comment_url,
    autor: row.autor,
    fecha: row.fecha,
    detectedAt: row.detected_at,
    textoOriginal: row.texto_original,
    categoria: row.categoria,
    subcategoria: row.subcategoria,
    precisionFecha: row.precision_fecha,
    importOrigen: row.import_origen,
    direccionDetectada: row.direccion_detectada,
    direccionNormalizada: row.direccion_normalizada,
    calle: row.calle,
    altura: row.altura,
    cruce: row.cruce,
    x: row.x,
    y: row.y,
    comuna: row.comuna,
    barrio: row.barrio,
    precision: row.precision,
    geoStatus: row.geo_status,
    estado: row.estado,
    ubicacionTipo: row.ubicacion_tipo || null,
    nombreLugar: row.nombre_lugar || null,
    motivoSinUbicar: row.motivo_sin_ubicar || null,
    ubicacion: parseUbicacionJson(row.ubicacion_json),
    // El correo no sale de acá hacia la API (server.js lo saca); la ruta
    // solo dice si se corrigió.
    corregidaPor: row.corregida_por || null,
    descarteMotivo: row.descarte_motivo || null,
  };
}

function parseUbicacionJson(texto) {
  if (!texto) return null;
  try {
    const valor = JSON.parse(texto);
    return valor && typeof valor === 'object' ? valor : null;
  } catch {
    return null;
  }
}

/**
 * Alta o actualización de un reclamo (análisis en vivo o import de Excel).
 * `id` y `comentarioId` los arma el llamador (ver src/reclamosFromAnalysis.js
 * y scripts/import-reclamos.js) para poder deduplicar entre corridas.
 */
/**
 * Guarda un reclamo; si ya existe (mismo id), lo actualiza.
 * @param {object} reclamo
 * @param {{ conservarGestion?: boolean }} [options] conservarGestion: lo usan
 *   los análisis de publicación (Instagram y X) al re-analizar: el reclamo
 *   existente conserva su estado, su primera detección y, si la dirección
 *   detectada no cambió, su geocodificado (upsertReclamoConservandoStmt).
 *   Sin la opción (el importador, el sembrado de prueba) pisa todo, como
 *   siempre.
 */
function upsertReclamo(reclamo, { conservarGestion = false } = {}) {
  // Última barrera: nada entra a la tabla sin pasar por la lista cerrada de
  // config/categorias-reclamos.json. Ya no hay CHECK en el esquema que ataje
  // una categoría inventada, así que la validación tiene que estar acá sí o sí.
  const { categoria, subcategoria } = normalizeClasificacion({
    categoria: reclamo.categoria,
    subcategoria: reclamo.subcategoria,
    contexto: reclamo.id,
  });

  (conservarGestion ? upsertReclamoConservandoStmt : upsertReclamoStmt).run({
    id: reclamo.id,
    comentarioId: reclamo.comentarioId || null,
    plataforma: reclamo.plataforma,
    postUrl: reclamo.postUrl || null,
    commentUrl: reclamo.commentUrl || null,
    autor: reclamo.autor || null,
    fecha: reclamo.fecha || null,
    detectedAt: reclamo.detectedAt || new Date().toISOString(),
    textoOriginal: reclamo.textoOriginal,
    categoria,
    subcategoria: subcategoria || null,
    precisionFecha: reclamo.precisionFecha || null,
    importOrigen: reclamo.importOrigen || null,
    direccionDetectada: reclamo.direccionDetectada || null,
    direccionNormalizada: reclamo.direccionNormalizada || null,
    calle: reclamo.calle || null,
    altura: reclamo.altura ?? null,
    cruce: reclamo.cruce || null,
    x: reclamo.x ?? null,
    y: reclamo.y ?? null,
    comuna: reclamo.comuna ?? null,
    barrio: reclamo.barrio || null,
    precision: reclamo.precision || null,
    geoStatus: reclamo.geoStatus || 'pendiente',
    estado: reclamo.estado || 'Pendiente',
    ubicacionTipo: reclamo.ubicacionTipo || null,
    nombreLugar: reclamo.nombreLugar || null,
    motivoSinUbicar: reclamo.motivoSinUbicar || null,
    ubicacionJson: reclamo.ubicacion ? JSON.stringify(reclamo.ubicacion) : null,
  });
}

/**
 * Reclamos filtrados para el mapa y para la descarga de CSV (comparten la
 * misma consulta: el CSV exporta todo lo que matchea, no solo lo con pin).
 * @param {{ categoria?: string[], subcategoria?: string[], estado?: string[], barrio?: string,
 *   comuna?: number, desde?: string, hasta?: string, q?: string }} filters
 */
function listReclamosFiltered(filters = {}, { incluirFueraDeCaba = false } = {}) {
  const { plataforma, categoria, subcategoria, estado, precision, barrio, comuna, desde, hasta, q } = filters;
  // Afuera, pasen los filtros que pasen: quedan marcados en la DB para poder
  // auditar el geocoding. Desde la fase H el Mapa los pide igual
  // (incluirFueraDeCaba) para listarlos en "Sin ubicar" con su motivo; nunca
  // tienen pin ni cuentan en las comunas.
  const clauses = incluirFueraDeCaba ? [] : [`geo_status IS NOT 'fuera_caba'`];
  const params = {};
  if (Array.isArray(precision) && precision.length > 0) {
    precision.forEach((p, i) => {
      params[`precision${i}`] = p;
    });
    clauses.push(`precision IN (${precision.map((_, i) => `@precision${i}`).join(',')})`);
  }

  if (plataforma) {
    clauses.push('plataforma = @plataforma');
    params.plataforma = plataforma;
  }

  if (Array.isArray(categoria) && categoria.length > 0) {
    const names = categoria.map((_, i) => `@categoria${i}`);
    categoria.forEach((c, i) => {
      params[`categoria${i}`] = c;
    });
    clauses.push(`categoria IN (${names.join(',')})`);
  }
  if (Array.isArray(subcategoria) && subcategoria.length > 0) {
    const names = subcategoria.map((_, i) => `@subcategoria${i}`);
    subcategoria.forEach((s, i) => {
      params[`subcategoria${i}`] = s;
    });
    clauses.push(`subcategoria IN (${names.join(',')})`);
  }
  if (Array.isArray(estado) && estado.length > 0) {
    const names = estado.map((_, i) => `@estado${i}`);
    estado.forEach((e, i) => {
      params[`estado${i}`] = e;
    });
    clauses.push(`estado IN (${names.join(',')})`);
  }
  if (barrio) {
    clauses.push('barrio = @barrio');
    params.barrio = barrio;
  }
  if (comuna != null && comuna !== '') {
    clauses.push('comuna = @comuna');
    params.comuna = Number(comuna);
  }
  if (desde) {
    clauses.push('fecha >= @desde');
    params.desde = desde;
  }
  if (hasta) {
    clauses.push('fecha <= @hasta');
    params.hasta = hasta;
  }
  if (q) {
    clauses.push('(texto_original LIKE @q OR direccion_normalizada LIKE @q)');
    params.q = `%${q}%`;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM reclamos ${where} ORDER BY fecha DESC`).all(params);
  return rows.map(mapReclamoRow);
}

/** Filas que vinieron de una importación puntual. Ver --revert del importador. */
function listReclamosPorOrigen(origen) {
  return db
    .prepare('SELECT * FROM reclamos WHERE import_origen = ?')
    .all(origen)
    .map(mapReclamoRow);
}

/** Borra SOLO lo importado desde ese archivo; el resto de la base no se toca. */
function deleteReclamosPorOrigen(origen) {
  return db.prepare('DELETE FROM reclamos WHERE import_origen = ?').run(origen).changes;
}

/**
 * Conteo por categoría sobre toda la tabla (sin filtros, salvo la exclusión de
 * fuera_caba que aplica siempre). Lo usa el mapa para decidir a qué categorías
 * les toca color propio: ese ranking tiene que salir del total y no de lo que
 * el usuario esté filtrando, o los pines cambiarían de color al mover un filtro.
 */
function contarReclamosPorCategoria(plataforma) {
  const clauses = [`geo_status IS NOT 'fuera_caba'`];
  const params = {};
  if (plataforma) {
    clauses.push('plataforma = @plataforma');
    params.plataforma = plataforma;
  }
  const filas = db
    .prepare(
      `SELECT categoria, COUNT(*) AS total FROM reclamos WHERE ${clauses.join(' AND ')} GROUP BY categoria`
    )
    .all(params);
  return Object.fromEntries(filas.map((f) => [f.categoria, f.total]));
}

function updateEstado(id, estado) {
  updateEstadoStmt.run(estado, id);
}

function listPendingGeoReclamos() {
  return listPendingGeoReclamosStmt.all().map(mapReclamoRow);
}

/**
 * Pasa a 'pendiente' los reclamos con dirección escrita y sin un punto
 * válido (y les borra el (0,0)), para que el geoWorker los vuelva a ubicar.
 * @returns {string[]} sus ids
 */
function reabrirSinCoordenadas() {
  const ids = listSinCoordenadasStmt.all().map((r) => r.id);
  db.exec('BEGIN');
  try {
    for (const id of ids) reabrirGeoStmt.run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return ids;
}

/** De esos ids, cuántos quedaron ubicados (ok, con un punto que no es el (0,0)). */
function contarUbicados(ids) {
  return Number(contarUbicadosStmt.get(JSON.stringify(ids || [])).n) || 0;
}

/** Aplica el resultado del geoWorker (USIG + comuna/barrio) a una fila. */
function updateReclamoGeo(id, fields) {
  updateReclamoGeoStmt.run({
    id,
    direccionNormalizada: fields.direccionNormalizada ?? null,
    calle: fields.calle ?? null,
    altura: fields.altura ?? null,
    cruce: fields.cruce ?? null,
    x: fields.x ?? null,
    y: fields.y ?? null,
    comuna: fields.comuna ?? null,
    barrio: fields.barrio ?? null,
    precision: fields.precision ?? null,
    geoStatus: fields.geoStatus,
    // ubicacionTipo sin dato no pisa el que había (el worker viejo no lo manda).
    ubicacionTipo: fields.ubicacionTipo ?? null,
    nombreLugar: fields.nombreLugar ?? null,
    motivoSinUbicar: fields.motivoSinUbicar ?? null,
  });
}

/** Un reclamo por id (o null), con la forma de mapReclamoRow. */
function getReclamo(id) {
  const row = getReclamoStmt.get(String(id));
  return row ? mapReclamoRow(row) : null;
}

/** Guarda la ubicación estructurada (la del modelo, o la del reproceso). */
function setReclamoUbicacion(id, { ubicacionTipo = null, ubicacion = null } = {}) {
  setReclamoUbicacionStmt.run({ id, ubicacionTipo, ubicacionJson: ubicacion ? JSON.stringify(ubicacion) : null });
}

/**
 * Marca un reclamo como corregido a mano (Mapa): quién y lo que escribió,
 * dentro de ubicacion_json junto a lo que había dicho el modelo. La
 * ubicación nueva la escribe updateReclamoGeo con lo que resolvió el resolver.
 */
function marcarReclamoCorregido(id, { corregidaPor, texto, ahora = new Date().toISOString() }) {
  const actual = getReclamoStmt.get(String(id));
  const previa = actual ? parseUbicacionJson(actual.ubicacion_json) : null;
  const ubicacion = { ...(previa || {}), correccion: { texto: String(texto || ''), fecha: ahora } };
  marcarReclamoCorregidoStmt.run({ id: String(id), corregidaPor: corregidaPor || 'equipo', ubicacionJson: JSON.stringify(ubicacion) });
}

/** "Descartar" del Mapa: no es un reclamo ubicable; queda sin punto, con el motivo. */
function descartarReclamo(id, { motivo, corregidaPor }) {
  descartarReclamoStmt.run({ id: String(id), motivo: String(motivo || '').trim() || null, corregidaPor: corregidaPor || 'equipo' });
}

function getLugarCache(clave) {
  const row = getLugarCacheStmt.get(clave);
  if (!row) return null;
  return { clave: row.clave, nombre: row.nombre, x: row.x, y: row.y, direccion: row.direccion, fuente: row.fuente, fetchedAt: row.fetched_at };
}

function setLugarCache(entry) {
  setLugarCacheStmt.run({
    clave: entry.clave,
    nombre: entry.nombre || null,
    x: entry.x ?? null,
    y: entry.y ?? null,
    direccion: entry.direccion || null,
    fuente: entry.fuente || null,
    fetchedAt: entry.fetchedAt || new Date().toISOString(),
  });
}

function countReclamos() {
  return db.prepare('SELECT COUNT(*) AS total FROM reclamos').get().total;
}

function getGeocodeCache(queryKey) {
  const row = getGeocodeCacheStmt.get(queryKey);
  if (!row) return null;
  return {
    queryKey: row.query_key,
    lat: row.lat,
    lng: row.lng,
    displayName: row.display_name,
    status: row.status,
    fetchedAt: row.fetched_at,
    calle: row.calle,
    altura: row.altura,
    cruce: row.cruce,
    comuna: row.comuna,
    barrio: row.barrio,
  };
}

function setGeocodeCache(entry) {
  setGeocodeCacheStmt.run({
    queryKey: entry.queryKey,
    lat: entry.lat ?? null,
    lng: entry.lng ?? null,
    displayName: entry.displayName || null,
    status: entry.status,
    fetchedAt: entry.fetchedAt || new Date().toISOString(),
    calle: entry.calle || null,
    altura: entry.altura ?? null,
    cruce: entry.cruce || null,
    comuna: entry.comuna ?? null,
    barrio: entry.barrio || null,
  });
}

// Total de posteos detectados en los últimos N días, para el resumen de
// menciones del dashboard (data/monitoring.db, detected_at es ISO 8601).
function countRecentPosts(days, plataforma) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return plataforma
    ? countRecentPostsByPlataformaStmt.get(cutoff, plataforma).total
    : countRecentPostsStmt.get(cutoff).total;
}

function mapAccountStatsRow(row) {
  return {
    account: row.account,
    plataforma: row.plataforma,
    postType: row.post_type,
    nPosts: row.n_posts,
    medianLikes: row.median_likes,
    medianComments: row.median_comments,
    computedAt: row.computed_at,
  };
}

function upsertAccountStats(row) {
  const params = {
    account: row.account,
    plataforma: row.plataforma,
    postType: row.postType ?? null,
    nPosts: row.nPosts,
    medianLikes: row.medianLikes,
    medianComments: row.medianComments,
    computedAt: row.computedAt || new Date().toISOString(),
  };
  const existing = getAccountStatsStmt.get(params.account, params.plataforma, params.postType);
  if (existing) {
    updateAccountStatsStmt.run(params);
  } else {
    insertAccountStatsStmt.run(params);
  }
}

function getAccountStats(account, plataforma, postType) {
  const row = getAccountStatsStmt.get(account, plataforma, postType ?? null);
  return row ? mapAccountStatsRow(row) : null;
}

/** @returns {string|null} ISO de la fila más nueva de esta cuenta, o null si no tiene ninguna. */
function getAccountStatsFreshness(account, plataforma) {
  return getAccountStatsFreshnessStmt.get(account, plataforma).lastComputedAt;
}

function listAllAccountStats() {
  return listAllAccountStatsStmt.all().map(mapAccountStatsRow);
}

function upsertAccountFollowers({ account, plataforma, followers, updatedAt }) {
  const params = { account, plataforma, followers: followers ?? null, updatedAt: updatedAt || new Date().toISOString() };
  const existing = getAccountFollowersStmt.get(account, plataforma);
  if (existing) {
    updateAccountFollowersStmt.run(params);
  } else {
    insertAccountFollowersStmt.run(params);
  }
}

/** @returns {number|null} Última cantidad de seguidores cacheada, o null si nunca se calculó. */
function getAccountFollowers(account, plataforma) {
  const row = getAccountFollowersStmt.get(account, plataforma);
  return row ? row.followers : null;
}

/** @returns {string[]} Cuentas distintas de una plataforma presentes en detected_posts (sin NULL ni 'N/D'). */
function listDistinctPostAccounts(plataforma) {
  requirePlataforma(plataforma, 'listDistinctPostAccounts');
  return listDistinctPostAccountsStmt.all(plataforma).map((row) => row.account);
}

/**
 * Cuentas de una plataforma con posteos visibles en detected_posts y su
 * situación frente al benchmark (ver el comentario del statement).
 * @param {string} plataforma
 * @param {number} recalcDays días entre el último cálculo y un posteo nuevo para volver a calcular
 * @returns {{account: string, lastDetectedAt: string, lastComputedAt: string|null, eligibleSince: string|null}[]}
 *   ordenadas por eligibleSince (las que no deben recalcularse, con NULL, van primero en SQLite).
 */
function listAccountBenchmarkActivity(plataforma, recalcDays) {
  return listAccountBenchmarkActivityStmt.all({ plataforma, recalcDays });
}

/** Avanza computed_at de todas las filas de la cuenta sin tocar medianas ni n_posts. @returns {number} filas tocadas */
function touchAccountStatsComputedAt(account, plataforma, computedAt) {
  return touchAccountStatsComputedAtStmt.run({ account, plataforma, computedAt: computedAt || new Date().toISOString() }).changes;
}

/**
 * Actualiza likes/comments/post_type de un posteo YA guardado si algo
 * cambió (ej. un recálculo de benchmark trae el mismo posteo con métricas
 * nuevas, o con un post_type que antes no se guardaba). No hace nada si el
 * id no existe en detected_posts — nunca inserta, solo actualiza lo que ya
 * está. keepIfMissing (regla única de métricas): un likes o comments
 * ausente, null o negativo conserva el valor guardado de ese campo.
 *
 * post_type SOLO se completa si faltaba (existing.post_type es NULL) —
 * nunca se pisa un valor ya conocido, a diferencia de likes/comments que sí
 * son métricas vivas y se actualizan siempre que cambien.
 * @returns {boolean} true si se escribió un cambio real. false si el id no
 * existe, está ignorado, o las métricas no cambiaron.
 */
function updatePostMetricsIfChanged(id, { likes, comments, postType }) {
  const existing = getPostMetricsStmt.get(id);
  if (!existing || existing.ignored) return false;
  const cleanLikes = keepIfMissing(likes, existing.likes);
  const cleanComments = keepIfMissing(comments, existing.comments);
  const nextPostType = existing.post_type != null ? existing.post_type : postType || null;

  if (existing.likes === cleanLikes && existing.comments === cleanComments && existing.post_type === nextPostType) {
    return false;
  }
  updatePostMetricsStmt.run({
    id,
    likes: cleanLikes,
    comments: cleanComments,
    postType: nextPostType,
    metricsUpdatedAt: new Date().toISOString(),
  });
  return true;
}

/** Propaga la cantidad de seguidores a TODOS los posteos ya guardados de una cuenta de esa plataforma (no solo a los nuevos). */
function updateFollowersForAccount(account, followers, plataforma) {
  requirePlataforma(plataforma, 'updateFollowersForAccount');
  updateFollowersForAccountStmt.run(followers ?? null, account, plataforma);
}

/** @returns {number} id de la fila nueva en apify_calls. Ver src/apifyCost.js (recordApifyCall), que es quien la llama. */
function insertApifyCall(row) {
  const result = insertApifyCallStmt.run({
    at: row.at || new Date().toISOString(),
    runId: row.runId ?? null,
    phase: row.phase || 'desconocida',
    plataforma: row.plataforma || 'instagram',
    actor: row.actor ?? null,
    queryType: row.queryType ?? null,
    target: row.target ?? null,
    resultsType: row.resultsType ?? null,
    items: Number(row.items) || 0,
    ok: row.ok ? 1 : 0,
    error: row.error ?? null,
    durationMs: row.durationMs == null ? null : Math.round(row.durationMs),
    usd: Number(row.usd) || 0,
    usdReal: row.usdReal == null || !Number.isFinite(Number(row.usdReal)) ? null : Number(row.usdReal),
    apifyRunId: row.apifyRunId ?? null,
    analisisId: row.analisisId ?? null,
    estado: row.estado ?? null,
    maxItems: row.maxItems == null || !Number.isFinite(Number(row.maxItems)) ? null : Math.floor(Number(row.maxItems)),
    until: row.until ?? null,
  });
  return Number(result.lastInsertRowid);
}

/**
 * Cierra una fila de apify_calls que se abrió al arrancar el run: lo que
 * trajo, cómo terminó y el usd estimado. No toca el run, la fase ni usd_real.
 * @returns {number} filas cambiadas (0 si el id no existe)
 */
function closeApifyCall(id, { items = 0, ok = false, error = null, durationMs = null, usd = 0, estado = null } = {}) {
  return closeApifyCallStmt.run({
    id,
    items: Number(items) || 0,
    ok: ok ? 1 : 0,
    error: error ?? null,
    durationMs: durationMs == null ? null : Math.round(durationMs),
    usd: Number(usd) || 0,
    estado: estado ?? null,
  }).changes;
}

/**
 * La llamada de esa corrida de Apify quedó esperando y su resultado se
 * levantó después: pasa a ok con lo que trajo (`items`) y su usd estimado,
 * estado `recuperada`, y se recalculan los totales del ciclo que la lanzó.
 * Solo toca filas que estaban `esperando` o `en_curso`.
 * @returns {number} filas cambiadas
 */
function markApifyCallRecovered(apifyRunId, { items = 0, usd = 0 } = {}) {
  if (!apifyRunId) return 0;
  const changed = markApifyCallRecoveredStmt.run({ apifyRunId: String(apifyRunId), items: Number(items) || 0, usd: Number(usd) || 0 }).changes;
  if (changed > 0) {
    for (const row of listApifyCallsByApifyRunStmt.all(String(apifyRunId))) {
      if (row.run_id != null) recomputeMonitoringRunTotalsStmt.run({ id: row.run_id });
    }
  }
  return changed;
}

/** Las llamadas fallidas y sin run de Apify de un ciclo (candidatas a un asiento). */
function listFailedCallsWithoutRun(runId) {
  return listFailedCallsWithoutRunStmt.all(Number(runId)).map((row) => ({ ...row }));
}

/** ¿Hay alguna llamada registrada con ese run de Apify? */
function hasApifyRun(apifyRunId) {
  return listApifyCallsByApifyRunStmt.all(String(apifyRunId)).length > 0;
}

/**
 * Anota en UNA llamada fallida y sin run el run de Apify que en realidad
 * corrió y lo que cobró, y recalcula el usd de su ciclo. No toca nada más
 * de la fila (sigue fallida: sus resultados no se usaron).
 * @returns {number} filas cambiadas (0 si ya tenía run)
 */
function settleApifyCall(id, { apifyRunId, usdReal }) {
  const usd = Number(usdReal);
  if (!apifyRunId || !Number.isFinite(usd) || usd < 0) throw new Error('settleApifyCall: falta el run o el costo');
  const changed = settleApifyCallStmt.run({ id: Number(id), apifyRunId: String(apifyRunId), usdReal: usd }).changes;
  if (changed > 0) {
    const row = getApifyCallStmt.get(Number(id));
    if (row && row.run_id != null) recomputeMonitoringRunUsdStmt.run({ id: row.run_id });
  }
  return changed;
}

/** Los runs de Apify que la app tiene registrados en llamadas desde `sinceIso`. @returns {Set<string>} */
function listApifyRunIdsSince(sinceIso) {
  return new Set(listApifyRunIdsSinceStmt.all(sinceIso).map((row) => row.id));
}

/**
 * Las últimas búsquedas buenas de un término en esa red (las recuperadas
 * también): cuánto trajo cada una, con qué tope y desde qué día.
 * @returns {{ items: number, maxItems: number|null, until: string|null, at: string }[]}
 */
function lastSearchCallsForTerm(plataforma, term, limit = 6) {
  requirePlataforma(plataforma, 'lastSearchCallsForTerm');
  const buscado = String(term ?? '').trim().toLowerCase();
  const max = Math.max(1, Math.floor(Number(limit)) || 6);
  const out = [];
  for (const row of lastSearchCallsStmt.all({ plataforma, limit: SEARCH_HISTORY_SCAN })) {
    if (String(row.target ?? '').trim().toLowerCase() !== buscado) continue;
    out.push({ items: Number(row.items) || 0, maxItems: row.maxItems == null ? null : Number(row.maxItems), until: row.until, at: row.at });
    if (out.length >= max) break;
  }
  return out;
}

/** La corrida de Apify de esa llamada ya no existe: la fila queda `perdida` (sigue fallida). @returns {number} filas cambiadas */
function markApifyCallLost(apifyRunId) {
  if (!apifyRunId) return 0;
  return markApifyCallLostStmt.run({ apifyRunId: String(apifyRunId) }).changes;
}

/** Una fila de apify_calls tal cual, o null. Para los tests y los scripts. */
function getApifyCall(id) {
  return getApifyCallStmt.get(id) || null;
}

/** Abre la fila del ciclo en monitoring_runs. @returns {number} id (el run_id de sus apify_calls). */
function startMonitoringRun({ trigger, plataforma, startedAt, honda = null } = {}) {
  const result = insertMonitoringRunStmt.run({
    startedAt: startedAt || new Date().toISOString(),
    trigger: trigger || 'manual',
    plataforma: plataforma || 'todas',
    // true / false con las corridas hondas activas; null si están apagadas.
    honda: honda == null ? null : honda ? 1 : 0,
  });
  return Number(result.lastInsertRowid);
}

/**
 * Cuándo terminó la última corrida honda (src/deepRun.js), o null si no
 * hubo ninguna. Cuenta la que cerró sin que el ciclo tirara y en la que
 * alguna búsqueda respondió o quedó en Apify.
 * @returns {string|null}
 */
function getLastFinishedDeepRunAt() {
  const row = getLastFinishedDeepRunAtStmt.get();
  return row && row.at ? row.at : null;
}

/**
 * Cierra la fila del ciclo sumando sus apify_calls: llamadas, resultados,
 * usd (el real donde Apify lo devolvió, si no el estimado) y si alguna
 * cortó por cuota. Devuelve los totales con el desglose por fase y, dentro
 * de cada fase, por actor (para la línea "[costo] ciclo #N ..." del
 * scheduler).
 * @returns {{ id: number, calls: number, results: number, usd: number, quotaExceeded: boolean,
 *   porFase: Object<string, {calls: number, results: number, usd: number,
 *     porActor: Object<string, {calls: number, results: number, usd: number, usdReal: number|null, withReal: number}>}> }}
 */
function finishMonitoringRun(id, { newPosts = 0, newCandidates = null, finishedAt, errorCode = null } = {}) {
  const byPhaseActor = sumApifyCallsByRunStmt.all(id);
  const totals = { calls: 0, results: 0, usd: 0, quotaExceeded: false };
  const porFase = {};
  for (const row of byPhaseActor) {
    totals.calls += row.calls;
    totals.results += row.results;
    totals.usd += row.usdBest;
    if (row.quotaErrors > 0) totals.quotaExceeded = true;
    const phase = porFase[row.phase] || (porFase[row.phase] = { calls: 0, results: 0, usd: 0, porActor: {} });
    phase.calls += row.calls;
    phase.results += row.results;
    phase.usd += row.usdBest;
    phase.porActor[row.actor] = { calls: row.calls, results: row.results, usd: row.usd, usdReal: row.usdReal, withReal: row.withReal };
  }
  finishMonitoringRunStmt.run({
    id,
    finishedAt: finishedAt || new Date().toISOString(),
    newPosts: Number(newPosts) || 0,
    newCandidates: newCandidates == null || !Number.isFinite(Number(newCandidates)) ? null : Math.max(0, Math.floor(Number(newCandidates))),
    calls: totals.calls,
    results: totals.results,
    usd: totals.usd,
    quotaExceeded: totals.quotaExceeded ? 1 : 0,
    errorCode: errorCode ? String(errorCode).slice(0, 60) : null,
  });
  return { id, ...totals, porFase };
}

function monitoringRunFromRow(row) {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    plataforma: row.plataforma,
    newPosts: row.new_posts,
    newCandidates: row.new_candidates ?? null,
    calls: row.calls,
    results: row.results,
    usd: row.usd,
    quotaExceeded: Boolean(row.quota_exceeded),
    errorCode: row.error_code ?? null,
  };
}

function runSourceFromRow(row) {
  return {
    id: Number(row.id),
    runId: row.run_id == null ? null : Number(row.run_id),
    plataforma: row.plataforma,
    tipo: row.tipo,
    fuente: row.fuente,
    clave: row.clave,
    intento: Number(row.intento) || 1,
    estado: row.estado,
    motivo: row.motivo,
    detalle: row.detalle,
    actor: row.actor,
    apifyRunId: row.apify_run_id,
    desdeIso: row.desde_iso,
    until: row.until,
    tope: row.tope == null ? null : Number(row.tope),
    items: row.items == null ? null : Number(row.items),
    nuevos: row.nuevos == null ? null : Number(row.nuevos),
    topeLleno: Boolean(row.tope_lleno),
    huecoDesde: row.hueco_desde,
    recuperadaEn: row.recuperada_en == null ? null : Number(row.recuperada_en),
    recuperadaAt: row.recuperada_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    duracionMs: row.duracion_ms == null ? null : Number(row.duracion_ms),
  };
}

const RUN_SOURCE_COLUMNS = {
  estado: 'estado',
  motivo: 'motivo',
  detalle: 'detalle',
  actor: 'actor',
  apifyRunId: 'apify_run_id',
  desdeIso: 'desde_iso',
  until: 'until',
  tope: 'tope',
  items: 'items',
  nuevos: 'nuevos',
  topeLleno: 'tope_lleno',
  huecoDesde: 'hueco_desde',
  recuperadaEn: 'recuperada_en',
  recuperadaAt: 'recuperada_at',
  finishedAt: 'finished_at',
  duracionMs: 'duracion_ms',
};

/** El texto crudo de un error para la columna `detalle`: una línea, sin HTML, hasta 200 caracteres. */
function cleanSourceDetail(text) {
  if (text === undefined || text === null || text === '') return null;
  return String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

/**
 * Abre la fila de una consulta de detección. `runId` puede ser null (el
 * ciclo no pudo abrir su fila): la consulta se registra igual, para que una
 * corrida que quede esperando se pueda levantar.
 * @returns {number} id de la fila
 */
function startRunSource({ runId = null, plataforma, tipo, fuente = null, clave = null, intento = 1, estado = 'en curso', motivo = null, detalle = null,
  actor = null, apifyRunId = null, desdeIso = null, until = null, tope = null, items = null, nuevos = null, topeLleno = false, huecoDesde = null,
  startedAt, finishedAt = null, duracionMs = null } = {}) {
  requirePlataforma(plataforma, 'startRunSource');
  const result = insertRunSourceStmt.run({
    runId: runId == null ? null : Number(runId),
    plataforma,
    tipo: String(tipo),
    fuente: fuente == null ? null : String(fuente),
    clave: clave == null ? null : String(clave),
    intento: Number(intento) || 1,
    estado: String(estado),
    motivo: motivo ?? null,
    detalle: cleanSourceDetail(detalle),
    actor: actor ?? null,
    apifyRunId: apifyRunId ?? null,
    desdeIso: desdeIso ?? null,
    until: until ?? null,
    tope: tope == null ? null : Math.floor(Number(tope)),
    items: items == null ? null : Math.floor(Number(items)),
    nuevos: nuevos == null ? null : Math.floor(Number(nuevos)),
    topeLleno: topeLleno ? 1 : 0,
    huecoDesde: huecoDesde ?? null,
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: finishedAt ?? null,
    duracionMs: duracionMs == null ? null : Math.round(Number(duracionMs)),
  });
  return Number(result.lastInsertRowid);
}

/**
 * Cambia lo que venga en `fields` de una fila de monitoring_run_sources
 * (estado, motivo, detalle, apifyRunId, items, nuevos, topeLleno,
 * huecoDesde, recuperadaEn, recuperadaAt, finishedAt, duracionMs…). Lo que
 * no viene no se toca. @returns {number} filas cambiadas
 */
function updateRunSource(id, fields = {}) {
  const sets = [];
  const params = { id };
  for (const [key, column] of Object.entries(RUN_SOURCE_COLUMNS)) {
    if (!Object.hasOwn(fields, key) || fields[key] === undefined) continue;
    let value = fields[key];
    if (key === 'detalle') value = cleanSourceDetail(value);
    else if (key === 'topeLleno') value = value ? 1 : 0;
    else if (['tope', 'items', 'nuevos', 'recuperadaEn', 'duracionMs'].includes(key)) value = value == null ? null : Math.round(Number(value));
    sets.push(`${column} = @${key}`);
    params[key] = value ?? null;
  }
  if (sets.length === 0) return 0;
  return db.prepare(`UPDATE monitoring_run_sources SET ${sets.join(', ')} WHERE id = @id`).run(params).changes;
}

function getRunSource(id) {
  const row = getRunSourceStmt.get(id);
  return row ? runSourceFromRow(row) : null;
}

/** Las consultas de detección de una corrida para una red, en el orden en que se lanzaron. */
function listRunSources({ runId, plataforma }) {
  requirePlataforma(plataforma, 'listRunSources');
  if (runId == null) return [];
  return listRunSourcesStmt.all(Number(runId), plataforma).map(runSourceFromRow);
}

/** Todas las consultas de detección de una corrida, de todas sus redes (el cierre del ciclo). */
function listRunSourcesOfRun(runId) {
  if (runId == null) return [];
  return listRunSourcesAllStmt.all(Number(runId)).map(runSourceFromRow);
}

/** Las búsquedas de esa red que quedaron esperando en una corrida anterior y que ESTA corrida levantó. */
function listRunSourcesRecoveredIn({ runId, plataforma }) {
  requirePlataforma(plataforma, 'listRunSourcesRecoveredIn');
  if (runId == null) return [];
  return listRunSourcesRecoveredInStmt.all(Number(runId), plataforma).map(runSourceFromRow);
}

/** Las consultas de una red que quedaron esperando (o abiertas por un proceso que se cayó): la cola de lo que hay que levantar. */
function listPendingRunSources(plataforma) {
  requirePlataforma(plataforma, 'listPendingRunSources');
  return listPendingRunSourcesStmt.all(plataforma).map(runSourceFromRow);
}

/**
 * Saca la marca de "tope lleno" de la primera consulta de una fuente en una
 * corrida (cuando su segunda consulta, levantada después, lo cubrió).
 * @returns {number} filas cambiadas
 */
function clearTopeLlenoPrimerIntento({ runId, plataforma, tipo, clave }) {
  requirePlataforma(plataforma, 'clearTopeLlenoPrimerIntento');
  if (runId == null || clave == null) return 0;
  return clearTopeLlenoPrimerIntentoStmt.run(Number(runId), plataforma, String(tipo), String(clave)).changes;
}

/** Las últimas `limit` consultas cerradas de una fuente (primer intento), de la más nueva a la más vieja. */
function lastRunSourcesForKey({ plataforma, tipo, clave, limit = 2 }) {
  requirePlataforma(plataforma, 'lastRunSourcesForKey');
  return lastRunSourcesForKeyStmt.all(plataforma, String(tipo), String(clave), Math.max(1, Math.floor(Number(limit)) || 2)).map(runSourceFromRow);
}

function getMonitoringRun(id) {
  const row = getMonitoringRunStmt.get(id);
  return row ? monitoringRunFromRow(row) : null;
}

/**
 * La última corrida terminada de esa plataforma (sola o junto con otras),
 * con lo que trajeron sus consultas de detección en esa red (`fetched`,
 * null si la corrida no hizo ninguna). Para el Pipeline del Monitoreo.
 * @returns {object|null} la fila de getMonitoringRun más `fetched`, o null.
 */
function getLastFinishedRun(plataforma) {
  requirePlataforma(plataforma, 'getLastFinishedRun');
  const row = getLastFinishedRunStmt.get(plataforma);
  if (!row) return null;
  const detection = sumDetectionItemsStmt.get(row.id, plataforma);
  return {
    ...monitoringRunFromRow(row),
    fetched: detection.calls > 0 ? detection.items : null,
    fuentes: listRunSourcesStmt.all(row.id, plataforma).map(runSourceFromRow),
  };
}

/** Posteos no ignorados de esa plataforma con detected_at entre fromIso y toIso (inclusive). */
function listPostsDetectedBetween(plataforma, fromIso, toIso) {
  requirePlataforma(plataforma, 'listPostsDetectedBetween');
  return listPostsDetectedBetweenStmt.all(plataforma, fromIso, toIso);
}

/**
 * Cuándo terminó la última corrida de esa plataforma (sola o junto con
 * otras), para la línea "Última corrida a las HH:MM" del Monitoreo. Sale de
 * monitoring_runs: sobrevive a un reinicio, a diferencia de la hora en
 * memoria del scheduler.
 * @returns {string|null} ISO, o null si nunca terminó ninguna.
 */
function getLastFinishedRunAt(plataforma) {
  requirePlataforma(plataforma, 'getLastFinishedRunAt');
  const row = getLastFinishedRunAtStmt.get(plataforma);
  return row ? row.finished_at : null;
}

/**
 * Cuándo terminó la última corrida, de cualquier plataforma: el estado de la
 * escucha de la barra superior del inicio (dashboard.html), que no es de
 * ninguna red. No es un default de getLastFinishedRunAt: es otra pregunta.
 * @returns {string|null} ISO, o null si nunca terminó ninguna.
 */
function getLastFinishedRunAtAny() {
  const row = getLastFinishedRunAtAnyStmt.get();
  return row ? row.finished_at : null;
}

/**
 * Posteos visibles (ignored = 0) de una plataforma publicados entre desdeIso
 * (incluido) y hastaIso (excluido), en orden de publicación. Para
 * Estadísticas (src/stats.js), que cuenta y calcula el alcance de cada uno.
 * @returns {{id: string, account: string|null, title: string|null, caption: string|null,
 *   sentiment: string|null, tema: string|null, likes: number|null, comments: number|null,
 *   followers: number|null, post_type: string|null, posted_at: string,
 *   matched_reason: string|null}[]}
 */
function listPostsForStats({ plataforma, desdeIso, hastaIso }) {
  requirePlataforma(plataforma, 'listPostsForStats');
  return listPostsForStatsStmt.all(plataforma, desdeIso, hastaIso);
}

/**
 * El motivo (matched_reason) de los posteos ignorados de una plataforma
 * publicados entre desdeIso (incluido) y hastaIso (excluido): las menciones
 * de Estadísticas los cuentan como detectados por su término.
 * @returns {(string|null)[]}
 */
function listIgnoredPostsForStats({ plataforma, desdeIso, hastaIso }) {
  requirePlataforma(plataforma, 'listIgnoredPostsForStats');
  return listIgnoredPostsForStatsStmt.all(plataforma, desdeIso, hastaIso).map((row) => row.matched_reason);
}

/**
 * Resultados de búsqueda descartados por el clasificador (search_seen con
 * outcome 'descartado'), por término, vistos por primera vez entre desdeIso
 * (incluido) y hastaIso (excluido).
 * @returns {{term: string, n: number}[]}
 */
function countDiscardedSearchesForStats({ plataforma, desdeIso, hastaIso }) {
  requirePlataforma(plataforma, 'countDiscardedSearchesForStats');
  return countDiscardedSearchesForStatsStmt.all(plataforma, desdeIso, hastaIso).map((row) => ({ term: row.term, n: Number(row.n) }));
}

/**
 * Instantes (ISO) que muestran que hubo una corrida de la plataforma entre
 * desdeIso (incluido) y hastaIso (excluido): el arranque de las corridas
 * terminadas que detectaron algo o al menos consultaron una fuente que
 * respondió (una corrida con todas sus fuentes caídas, o que no buscó nada,
 * no cuenta) y, para lo anterior a monitoring_runs, las detecciones de
 * posteos y de resultados de búsqueda. Sin repetidos.
 * @returns {string[]}
 */
function listRunTracesForStats({ plataforma, desdeIso, hastaIso }) {
  requirePlataforma(plataforma, 'listRunTracesForStats');
  if (!listRunTracesForStatsStmt) listRunTracesForStatsStmt = db.prepare(LIST_RUN_TRACES_FOR_STATS_SQL);
  return listRunTracesForStatsStmt.all({ plataforma, desde: desdeIso, hasta: hastaIso }).map((row) => row.t);
}

/** @returns {string|null} posted_at (ISO) del primer posteo visible de la plataforma, o null si no hay ninguno. */
function getFirstPostedAt(plataforma) {
  requirePlataforma(plataforma, 'getFirstPostedAt');
  const row = getFirstPostedAtStmt.get(plataforma);
  return row ? row.first : null;
}

/**
 * Posteos visibles de TODAS las redes publicados desde desdeIso (incluido):
 * el resumen público del login, que no es de ninguna red. No es un default
 * de una función por plataforma: es otra pregunta.
 * @returns {number}
 */
function countPostedSinceAllPlatforms(desdeIso) {
  return Number(countPostedSinceAllStmt.get(desdeIso).n) || 0;
}

/**
 * Posteos visibles de todas las redes por tema, publicados desde desdeIso:
 * solo el tema (null = sin tema) y la cantidad.
 * @returns {{tema: string|null, n: number}[]}
 */
function countTemasSinceAllPlatforms(desdeIso) {
  return countTemasSinceAllStmt.all(desdeIso).map((row) => ({ tema: row.tema, n: Number(row.n) }));
}

/** @returns {string|null} detected_at (ISO) del primer posteo detectado de cualquier red, o null si no hay ninguno. */
function getFirstDetectedAtAny() {
  const row = getFirstDetectedAtAnyStmt.get();
  return row ? row.first : null;
}

/** @returns {number} los reclamos de todas las redes que tienen pin en el mapa. */
function countReclamosEnMapa() {
  return Number(countReclamosEnMapaStmt.get().n) || 0;
}

/**
 * Las corridas de la plataforma (o de "todas") que arrancaron entre desdeIso
 * (incluido) y hastaIso (excluido), en orden: terminadas (finishedAt) o no
 * (en curso, o que quedaron sin cerrar porque el proceso se cayó). `plataforma`
 * es la de la fila: "instagram", "todas" o una lista ("instagram,x").
 * @returns {{ id: number, startedAt: string, finishedAt: string|null, trigger: string, plataforma: string,
 *   newCandidates: number|null, newPosts: number, quotaExceeded: boolean }[]}
 */
function listRunsBetween({ plataforma, desdeIso, hastaIso }) {
  requirePlataforma(plataforma, 'listRunsBetween');
  return listRunsBetweenStmt.all(desdeIso, hastaIso, plataforma).map((row) => ({
    id: Number(row.id),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    plataforma: row.plataforma,
    newCandidates: row.new_candidates === null || row.new_candidates === undefined ? null : Number(row.new_candidates),
    newPosts: Number(row.new_posts) || 0,
    quotaExceeded: Boolean(row.quota_exceeded),
    errorCode: row.error_code ?? null,
    // Las consultas de detección de esa corrida en ESTA red (src/runStatus.js).
    fuentes: listRunSourcesStmt.all(row.id, plataforma).map(runSourceFromRow),
  }));
}

/**
 * Seguidores por cuenta de una plataforma, para Estadísticas: el de
 * account_followers y, si la cuenta no está ahí, el del posteo más reciente
 * de la cuenta que lo trae.
 * @returns {Map<string, number>}
 */
function listFollowersForStats(plataforma) {
  requirePlataforma(plataforma, 'listFollowersForStats');
  const map = new Map();
  for (const row of listLatestPostFollowersStmt.all(plataforma)) map.set(row.account, row.followers);
  for (const row of listCachedFollowersStmt.all(plataforma)) map.set(row.account, row.followers); // la caché manda
  return map;
}

/** @returns {{id: number, runId: number|null, apifyRunId: string, usd: number, at: string}[]} llamadas con run conocido y sin costo real, con `at` entre newerThanIso y olderThanIso. */
function listApifyCallsPendingRealCost({ olderThanIso, newerThanIso, limit = 100 }) {
  return listApifyCallsPendingRealCostStmt.all({ olderThanIso, newerThanIso, limit: Math.max(1, Math.floor(Number(limit)) || 100) });
}

/** Guarda lo que Apify cobró de verdad por esa llamada. */
function setApifyCallRealCost(id, usdReal) {
  return setApifyCallRealCostStmt.run({ id, usdReal: Number(usdReal) }).changes;
}

/** Recalcula el usd del ciclo desde sus llamadas (real donde exista, si no estimado). */
function recomputeMonitoringRunUsd(id) {
  return recomputeMonitoringRunUsdStmt.run({ id }).changes;
}

/**
 * apify_calls desde sinceIso, agrupadas por fase y actor.
 * @returns {{phase: string, actor: string, calls: number, results: number, failed: number,
 *   usd: number, usdReal: number|null, withReal: number, usdBest: number}[]}
 */
function sumApifyCallsSince(sinceIso) {
  return sumApifyCallsSinceStmt.all(sinceIso);
}

/** Lista de términos sin vacíos ni repetidos (sin distinguir mayúsculas), en el orden en que llegan. */
function mergeSearchTerms(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const term = String(raw ?? '').trim();
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/** El JSON de search_seen.terminos como lista; algo roto o vacío es una lista vacía. */
function parseSearchTerms(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return mergeSearchTerms(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

/**
 * @returns {{postId: string, plataforma: string, url: string|null, term: string|null, outcome: string, firstSeenAt: string,
 *   postedAt: string|null, motivo: string|null, llmUsd: number|null, runId: number|null, terminos: string[]}|null}
 *   terminos: todos los términos que trajeron el posteo; en una fila anterior a la columna, solo `term`.
 */
function getSearchSeen(postId, plataforma) {
  requirePlataforma(plataforma, 'getSearchSeen');
  const row = getSearchSeenStmt.get(String(postId), plataforma);
  if (!row) return null;
  return { ...row, terminos: mergeSearchTerms(row.term ? [row.term] : [], parseSearchTerms(row.terminos)) };
}

function isSearchSeen(postId, plataforma) {
  requirePlataforma(plataforma, 'isSearchSeen');
  return Boolean(getSearchSeenStmt.get(String(postId), plataforma));
}

/**
 * Anota lo que se decidió sobre un resultado de búsqueda. Si ya estaba,
 * cambia el outcome, completa lo que llegue (fecha de publicación, motivo,
 * costo, corrida) y SUMA los términos; nunca pisa first_seen_at ni `term`.
 */
function markSearchSeen({ postId, plataforma, url = null, term = null, outcome, firstSeenAt, postedAt = null, motivo = null, llmUsd = null, runId = null, terminos = null }) {
  requirePlataforma(plataforma, 'markSearchSeen');
  const previo = getSearchSeenStmt.get(String(postId), plataforma);
  const lista = mergeSearchTerms(previo && previo.term ? [previo.term] : [], previo ? parseSearchTerms(previo.terminos) : [], term ? [term] : [], terminos);
  const usd = Number(llmUsd);
  markSearchSeenStmt.run({
    postId: String(postId),
    plataforma,
    url: url || null,
    term: term || lista[0] || null,
    outcome: String(outcome),
    firstSeenAt: firstSeenAt || new Date().toISOString(),
    postedAt: postedAt || null,
    motivo: motivo ? String(motivo).slice(0, 500) : null,
    llmUsd: llmUsd != null && Number.isFinite(usd) ? usd : null,
    runId: runId == null ? null : Number(runId),
    terminos: lista.length > 0 ? JSON.stringify(lista) : null,
  });
}

/**
 * Suma términos a un resultado ya anotado (otra búsqueda lo volvió a traer).
 * Sin fila no hace nada: los términos son de lo ya decidido.
 * @returns {boolean} true si la lista cambió
 */
function addSearchSeenTerms(postId, plataforma, terminos) {
  requirePlataforma(plataforma, 'addSearchSeenTerms');
  const previo = getSearchSeenStmt.get(String(postId), plataforma);
  if (!previo) return false;
  const antes = mergeSearchTerms(previo.term ? [previo.term] : [], parseSearchTerms(previo.terminos));
  const lista = mergeSearchTerms(antes, terminos);
  if (lista.length === antes.length && previo.terminos) return false;
  if (lista.length === 0) return false;
  setSearchSeenTermsStmt.run({ postId: String(postId), plataforma, terminos: JSON.stringify(lista) });
  return lista.length !== antes.length;
}

/**
 * Cuántos resultados de búsqueda decidió el clasificador en esa corrida
 * (guardados y descartados) y lo que costó, estimado; `usd` null si ninguno
 * informó su costo. De todas las redes de la corrida.
 * @returns {{ n: number, usd: number|null }}
 */
function sumSearchSeenByRun(runId) {
  if (runId == null) return { n: 0, usd: null };
  const row = sumSearchSeenByRunStmt.get(Number(runId));
  return { n: Number(row.n) || 0, usd: row.usd == null ? null : Number(row.usd) };
}

/** Borra los vistos anteriores a olderThanIso. @returns {number} filas borradas */
function purgeSearchSeen(olderThanIso) {
  return purgeSearchSeenStmt.run(olderThanIso).changes;
}

function getRefreshState(key) {
  const row = getRefreshStateStmt.get(key);
  return row ? row.value : null;
}

function setRefreshState(key, value) {
  setRefreshStateStmt.run({ key, value });
}

/** Borra una clave de refresh_state. @returns {number} filas borradas */
function deleteRefreshState(key) {
  return deleteRefreshStateStmt.run(String(key)).changes;
}

/** Las claves de refresh_state que empiezan con `prefix` (comparación exacta, sin comodines). */
function listRefreshStateByPrefix(prefix) {
  return listRefreshStateByPrefixStmt.all({ prefix: String(prefix) }).map((row) => ({ key: row.key, value: row.value }));
}

/**
 * Una marca de tiempo (ISO) que solo avanza: guarda `iso` si la clave no
 * existe, si lo guardado no es una fecha o si `iso` es posterior. Nunca
 * retrocede ni guarda una fecha del futuro (se recorta a ahora).
 * @returns {boolean} true si cambió
 */
function advanceRefreshState(key, iso, { now = Date.now() } = {}) {
  let ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  if (ms > now) ms = now;
  const actual = Date.parse(getRefreshState(key) || '');
  if (Number.isFinite(actual) && actual >= ms) return false;
  setRefreshState(key, new Date(ms).toISOString());
  return true;
}

/** Guarda `iso` solo si la clave no tiene una fecha válida todavía. @returns {boolean} true si la guardó */
function initRefreshState(key, iso) {
  if (Number.isFinite(Date.parse(getRefreshState(key) || '')) || !Number.isFinite(Date.parse(iso))) return false;
  setRefreshState(key, new Date(Date.parse(iso)).toISOString());
  return true;
}

/**
 * Cuentas con al menos un posteo con posted_at en (sinceIso, untilIso] que
 * cumpla la cadencia (cadenceIso null = sin filtro de metrics_updated_at).
 * @returns {{account: string, mostRecentPostedAt: string, postCount: number}[]}
 */
function listAccountsDueForRefresh({ sinceIso, untilIso, cadenceIso = null, plataforma }) {
  requirePlataforma(plataforma, 'listAccountsDueForRefresh');
  return listAccountsDueForRefreshStmt.all({ sinceIso, untilIso, cadenceIso, plataforma });
}

/**
 * Posteos (no ignorados ni frenados) con posted_at en (sinceIso, untilIso]
 * cuya última escritura de métricas (metrics_updated_at, o detected_at si
 * nunca se refrescó) es anterior a cadenceIso (null = sin filtro), de lo
 * más atrasado a lo más reciente. Refresco por URL (REFRESH_MODE=url).
 * @returns {{id: string, url: string, account: string|null, postedAt: string,
 *   detectedAt: string, metricsUpdatedAt: string|null, lastWriteAt: string}[]}
 */
function listPostsDueForRefresh({ sinceIso, untilIso, cadenceIso = null, plataforma }) {
  requirePlataforma(plataforma, 'listPostsDueForRefresh');
  return listPostsDueForRefreshStmt.all({ sinceIso, untilIso, cadenceIso, plataforma });
}

/**
 * Anota que se pidió el posteo por su URL y el run (que terminó bien) no lo
 * devolvió: suma 1 a refresh_misses y, al llegar a stopAfter intentos
 * seguidos, escribe refresh_stopped_at (el posteo deja de pedirse). Nunca
 * toca likes/comments ni metrics_updated_at: las métricas quedan en su
 * último valor conocido. No hace nada con un ignorado.
 * @returns {{misses: number, stopped: boolean, account: string|null, url: string}|null}
 *   null si el id no está guardado o está ignorado.
 */
function registerRefreshMiss(id, { stopAfter, at = new Date().toISOString() }) {
  const changes = registerRefreshMissStmt.run({ id, stopAfter, at }).changes;
  if (changes === 0) return null;
  const row = getRefreshMissStmt.get(id);
  return { misses: row.misses, stopped: Boolean(row.stoppedAt), account: row.account, url: row.url };
}

/**
 * Refresca likes/comments de un posteo YA guardado (nunca inserta, nunca
 * toca título/sentimiento/post_type). A diferencia de
 * updatePostMetricsIfChanged, SIEMPRE escribe (y por lo tanto SIEMPRE
 * actualiza metrics_updated_at), haya cambiado el valor o no — es lo que
 * permite que la cadencia del tramo tibio/frío (que compara contra
 * metrics_updated_at) funcione: un posteo estable que no creció tiene que
 * poder marcarse como "ya lo revisé recién", no quedar con la marca vieja
 * y parecer eternamente pendiente.
 *
 * Regla única de métricas (keepIfMissing): cada métrica que llega ausente,
 * null o negativa conserva el valor guardado de ESE campo (vale para las
 * cuatro columnas; Instagram no manda retweets/views y X sí); solo un número
 * >= 0 pisa. `changed` solo es true si algún valor realmente cambió.
 * @returns {{changed: boolean, account: string, postedAt: string,
 *   previousLikes: number|null, previousComments: number|null,
 *   likes: number|null, comments: number|null}|null} null si el id no está
 *   guardado o está ignorado (no se escriben métricas de un ignorado).
 */
function applyMetricsRefresh(id, { likes, comments, retweets, views } = {}) {
  const existing = getPostForMetricsRefreshStmt.get(id);
  if (!existing || existing.ignored) return null;
  const cleanLikes = keepIfMissing(likes, existing.likes);
  const cleanComments = keepIfMissing(comments, existing.comments);
  const cleanRetweets = keepIfMissing(retweets, existing.retweets);
  const cleanViews = keepIfMissing(views, existing.views);
  const changed =
    existing.likes !== cleanLikes ||
    existing.comments !== cleanComments ||
    existing.retweets !== cleanRetweets ||
    existing.views !== cleanViews;

  applyMetricsRefreshStmt.run({
    id,
    likes: cleanLikes,
    comments: cleanComments,
    retweets: cleanRetweets,
    views: cleanViews,
    metricsUpdatedAt: new Date().toISOString(),
  });

  return {
    changed,
    account: existing.account,
    postedAt: existing.posted_at,
    previousLikes: existing.likes,
    previousComments: existing.comments,
    likes: cleanLikes,
    comments: cleanComments,
  };
}

// --------------------------------------------------------------------------
// Foto del posteo (ver las columnas image_* más arriba). Por id Y plataforma,
// como las acciones de la tabla, y sin default de plataforma.
// --------------------------------------------------------------------------
const getPostImageStmt = db.prepare(`
  SELECT image_source_url AS sourceUrl, image_status AS status, image_saved_at AS savedAt,
         image_width AS width, image_height AS height
  FROM detected_posts
  WHERE id = ? AND plataforma = ?
`);
const markPostImageSavedStmt = db.prepare(`
  UPDATE detected_posts
  SET image_source_url = @sourceUrl,
      image_status = 'ok',
      image_saved_at = @savedAt,
      image_width = @width,
      image_height = @height
  WHERE id = @id AND plataforma = @plataforma
`);
// A propósito NO toca image_saved_at ni las medidas: si había copias
// guardadas, siguen ahí y se siguen mostrando.
const markPostImageFailedStmt = db.prepare(`
  UPDATE detected_posts
  SET image_source_url = @sourceUrl,
      image_status = @status
  WHERE id = @id AND plataforma = @plataforma
`);
const POST_IMAGE_FAILED_STATUSES = ['vencido', 'error'];
// Fotos que quedaron para reintentar: hay link guardado y la descarga no se
// llegó a hacer o falló por algo pasajero (src/postImageSync.js).
const listPostsWithPendingImageStmt = db.prepare(`
  SELECT id, image_source_url AS url
  FROM detected_posts
  WHERE plataforma = ? AND image_status = 'pendiente' AND image_source_url IS NOT NULL AND ignored = 0
  ORDER BY COALESCE(metrics_updated_at, detected_at) DESC, id
  LIMIT ?
`);

/** Medida en píxeles: entero mayor que cero, o NULL. */
function pixelsOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * Cómo está la foto de un posteo. `savedAt` distinto de null = hay copias
 * guardadas; `status` es cómo salió el último intento (null = nunca hubo).
 * @returns {{sourceUrl: string|null, status: 'ok'|'vencido'|'error'|'pendiente'|null,
 *   savedAt: string|null, width: number|null, height: number|null}|null}
 *   null si ese id no está guardado en esa plataforma.
 */
function getPostImage(id, plataforma) {
  requirePlataforma(plataforma, 'getPostImage');
  return getPostImageStmt.get(id, plataforma) || null;
}

/**
 * Anota que se guardaron las dos copias de la foto (postImages.savePostImage
 * devolvió ok).
 * @returns {boolean} false si ese id no está guardado en esa plataforma.
 */
function markPostImageSaved(id, plataforma, { sourceUrl, width, height, savedAt = new Date().toISOString() } = {}) {
  requirePlataforma(plataforma, 'markPostImageSaved');
  const result = markPostImageSavedStmt.run({
    id,
    plataforma,
    sourceUrl: sourceUrl || null,
    savedAt,
    width: pixelsOrNull(width),
    height: pixelsOrNull(height),
  });
  return result.changes > 0;
}

/**
 * Anota un intento fallido: el link que se probó y por qué no anduvo
 * ('vencido' | 'error'). No toca image_saved_at ni las medidas.
 * @returns {boolean} false si ese id no está guardado en esa plataforma.
 * @throws {Error} si el estado no es uno de los dos: es un error de
 *   programación, no un dato.
 */
function markPostImageFailed(id, plataforma, { sourceUrl, status } = {}) {
  requirePlataforma(plataforma, 'markPostImageFailed');
  if (!POST_IMAGE_FAILED_STATUSES.includes(status)) {
    throw new Error(`markPostImageFailed: estado inválido "${status}" (${POST_IMAGE_FAILED_STATUSES.join(' | ')}).`);
  }
  const result = markPostImageFailedStmt.run({ id, plataforma, sourceUrl: sourceUrl || null, status });
  return result.changes > 0;
}

/**
 * Deja la foto de un posteo para reintentar en el próximo ciclo: guarda el
 * link y el estado 'pendiente'. Es para cuando la descarga no se llegó a
 * hacer o falló por algo pasajero (ver src/postImageSync.js). No toca
 * image_saved_at ni las medidas.
 * @returns {boolean} false si ese id no está guardado en esa plataforma.
 */
function markPostImagePending(id, plataforma, { sourceUrl } = {}) {
  requirePlataforma(plataforma, 'markPostImagePending');
  const result = markPostImageFailedStmt.run({ id, plataforma, sourceUrl: sourceUrl || null, status: 'pendiente' });
  return result.changes > 0;
}

/**
 * Posteos con la foto pendiente de reintentar y el link guardado. Primero
 * los que recibieron el link hace menos (el último refresco o, si nunca se
 * refrescó, la detección): son los links con más vida por delante. Los
 * ignorados no entran.
 * @returns {{ id: string, url: string }[]}
 */
function listPostsWithPendingImage(plataforma, limit = 150) {
  requirePlataforma(plataforma, 'listPostsWithPendingImage');
  const max = Number.isInteger(limit) && limit > 0 ? limit : 150;
  return listPostsWithPendingImageStmt.all(plataforma, max);
}

function insertMagicLink({ tokenHash, email, expiresAt }) {
  insertMagicLinkStmt.run({ tokenHash, email, expiresAt });
}

/**
 * Marca el token como usado solo si todavía es válido. Devuelve el email
 * o null si ya se usó, expiró o no existe.
 */
function claimMagicLink(tokenHash, nowIso) {
  const result = claimMagicLinkStmt.run(nowIso, tokenHash, nowIso);
  if (result.changes === 0) return null;
  const row = getMagicLinkStmt.get(tokenHash);
  return row ? { email: row.email } : null;
}

/**
 * Borra los links todavía no usados de un email. Se llama al emitir uno
 * nuevo: pedir otro link invalida el anterior, para que no queden varios
 * tokens válidos dando vueltas por la misma casilla.
 */
function deleteUnusedMagicLinks(email) {
  deleteUnusedMagicLinksStmt.run(email);
}

// --------------------------------------------------------------------
// Sesiones (tabla sessions). Reciben el SHA-256 del id, nunca el id: lo
// arma src/auth/session.js.
// --------------------------------------------------------------------
function createSession({ idHash, email, createdAt, lastSeenAt = createdAt }) {
  createSessionStmt.run({ idHash, email, createdAt, lastSeenAt });
}

/** La fila de la sesión (también revocada o vencida: decide session.js), o null. */
function getSession(idHash) {
  const row = getSessionStmt.get(idHash);
  if (!row) return null;
  return {
    idHash: row.id_hash,
    email: row.email,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    revoked: Number(row.revoked) === 1,
  };
}

function touchSession(idHash, at) {
  return touchSessionStmt.run(at, idHash).changes > 0;
}

function revokeSession(idHash) {
  return revokeSessionStmt.run(idHash).changes > 0;
}

/** Revoca todas las sesiones abiertas de un correo; devuelve cuántas. */
function revokeSessionsByEmail(email) {
  return revokeSessionsByEmailStmt.run(email).changes;
}

/**
 * Borra las revocadas y las vencidas (sin actividad desde antes de
 * `idleBefore`, o creadas antes de `createdBefore`); devuelve cuántas.
 */
function purgeSessions({ idleBefore, createdBefore }) {
  return purgeSessionsStmt.run({ idleBefore, createdBefore }).changes;
}

// --------------------------------------------------------------------
// Análisis de publicación (tabla analisis). Todas por plataforma, sin
// default. Los campos JSON se leen con parseJsonColumn: un valor roto
// queda null, nunca tira.
// --------------------------------------------------------------------

function parseJsonColumn(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const numberOrNull = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));

function analisisLiviano(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    plataforma: row.plataforma,
    url: row.url,
    postCode: row.post_code || null,
    postId: row.post_id || null,
    estado: row.estado,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    cuenta: row.cuenta || null,
    cuentaNombre: row.cuenta_nombre || null,
    caption: row.caption || '',
    postedAt: row.posted_at || null,
    likes: numberOrNull(row.likes),
    comentariosTotal: numberOrNull(row.comentarios_total),
    traidos: numberOrNull(row.traidos),
    analizados: numberOrNull(row.analizados),
    tonos: {
      positivos: numberOrNull(row.positivos),
      neutrales: numberOrNull(row.neutrales),
      negativos: numberOrNull(row.negativos),
      ruido: numberOrNull(row.ruido),
    },
    imageSavedAt: row.image_saved_at || null,
    pctNeg: numberOrNull(row.pct_neg),
    tieneHecho: Number(row.tiene_hecho) === 1,
    nVerificados: numberOrNull(row.n_verificados),
    temaEstrella: row.tema_estrella || null,
    nReclamos: numberOrNull(row.reclamos_post),
  };
}

function analisisCompleto(row) {
  if (!row) return null;
  return {
    ...analisisLiviano(row),
    error: row.error || null,
    postType: row.post_type || null,
    vistas: numberOrNull(row.vistas),
    unicos: numberOrNull(row.unicos),
    enviados: numberOrNull(row.enviados),
    positivoPct: numberOrNull(row.positivo_pct),
    negativoPct: numberOrNull(row.negativo_pct),
    nivel: row.nivel || null,
    resultado: parseJsonColumn(row.resultado),
    temas: parseJsonColumn(row.temas) || [],
    comentarios: parseJsonColumn(row.comentarios) || [],
    cuando: parseJsonColumn(row.cuando),
    reporteAntes: row.reporte_antes || '',
    reporteDespues: row.reporte_despues || '',
    csv: row.csv || '',
    reclamos: numberOrNull(row.reclamos),
    usdApify: numberOrNull(row.usd_apify),
    usdModelo: numberOrNull(row.usd_modelo),
    tokens: numberOrNull(row.tokens),
    image: {
      sourceUrl: row.image_source_url || null,
      status: row.image_status || null,
      savedAt: row.image_saved_at || null,
      width: numberOrNull(row.image_width),
      height: numberOrNull(row.image_height),
    },
  };
}

/** Abre la fila de un análisis en "en curso". @returns {number} el id. */
function startAnalisis({ plataforma, url, postCode = null, analizadoPor = null, startedAt = new Date().toISOString() }) {
  requirePlataforma(plataforma, 'startAnalisis');
  return Number(insertAnalisisStmt.run({ plataforma, url, postCode, startedAt, analizadoPor }).lastInsertRowid);
}

/** Los datos de la publicación, apenas llegan (también quedan si después falla). */
function saveAnalisisPost(id, plataforma, post) {
  requirePlataforma(plataforma, 'saveAnalisisPost');
  updateAnalisisPostStmt.run({
    id,
    plataforma,
    postId: post.id ?? null,
    // 'N/D' es el relleno del informe (normalizePost): en la fila es "sin dato".
    cuenta: post.ownerUsername && post.ownerUsername !== 'N/D' ? post.ownerUsername : null,
    cuentaNombre: post.ownerFullName && post.ownerFullName !== 'N/D' ? post.ownerFullName : null,
    caption: post.caption ?? null,
    postedAt: post.postedAt ?? null,
    postType: post.postType ?? null,
    likes: numberOrNull(post.likesCount),
    comentariosTotal: numberOrNull(post.commentsCount),
    vistas: numberOrNull(post.videoPlayCount),
  });
}

/** Cierra un análisis que terminó bien, con todo lo que muestra la pantalla. */
function finishAnalisis(id, plataforma, data) {
  requirePlataforma(plataforma, 'finishAnalisis');
  const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
  finishAnalisisStmt.run({
    id,
    plataforma,
    finishedAt: data.finishedAt || new Date().toISOString(),
    traidos: numberOrNull(data.traidos),
    unicos: numberOrNull(data.unicos),
    enviados: numberOrNull(data.enviados),
    analizados: numberOrNull(data.analizados),
    positivos: numberOrNull(data.tonos && data.tonos.positivos),
    neutrales: numberOrNull(data.tonos && data.tonos.neutrales),
    negativos: numberOrNull(data.tonos && data.tonos.negativos),
    ruido: numberOrNull(data.tonos && data.tonos.ruido),
    positivoPct: numberOrNull(data.positivoPct),
    negativoPct: numberOrNull(data.negativoPct),
    nivel: data.nivel ?? null,
    resultado: json(data.resultado),
    temas: json(data.temas || []),
    comentarios: json(data.comentarios || []),
    cuando: json(data.cuando),
    reporteAntes: data.reporteAntes ?? null,
    reporteDespues: data.reporteDespues ?? null,
    csv: data.csv ?? null,
    reclamos: numberOrNull(data.reclamos),
    usdApify: numberOrNull(data.usdApify),
    usdModelo: numberOrNull(data.usdModelo),
    tokens: numberOrNull(data.tokens),
    pctNeg: numberOrNull(data.pctNeg),
    tieneHecho: data.tieneHecho ? 1 : 0,
    nVerificados: numberOrNull(data.nVerificados),
    temaEstrella: data.temaEstrella ?? null,
  });
}

/** Cierra un análisis que no terminó bien: 'sin comentarios' o 'error', con el mensaje para la persona. */
function failAnalisis(id, plataforma, { estado = 'error', error = null, traidos = null, usdApify = null, usdModelo = null, tokens = null } = {}) {
  requirePlataforma(plataforma, 'failAnalisis');
  failAnalisisStmt.run({
    id,
    plataforma,
    estado,
    error,
    finishedAt: new Date().toISOString(),
    traidos: numberOrNull(traidos),
    usdApify: numberOrNull(usdApify),
    usdModelo: numberOrNull(usdModelo),
    tokens: numberOrNull(tokens),
  });
}

/** Lo que pasó con la foto (postImages.savePostImage o la del Monitoreo). */
function markAnalisisImage(id, plataforma, { sourceUrl = null, status = null, savedAt = null, width = null, height = null } = {}) {
  requirePlataforma(plataforma, 'markAnalisisImage');
  markAnalisisImageStmt.run({ id, plataforma, sourceUrl, status, savedAt, width: numberOrNull(width), height: numberOrNull(height) });
}

/** @returns {object|null} el análisis entero, o null si no es de esa plataforma. */
function getAnalisis(id, plataforma) {
  requirePlataforma(plataforma, 'getAnalisis');
  return analisisCompleto(getAnalisisStmt.get(Number(id), plataforma));
}

/** Los terminados bien, el más reciente primero (livianos). */
function listAnalisis({ plataforma, limit = 12 } = {}) {
  requirePlataforma(plataforma, 'listAnalisis');
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 12)));
  return listAnalisisStmt.all(plataforma, n).map(analisisLiviano);
}

/** El último análisis terminado bien de ese link (ya normalizado), o null. */
function findAnalisisByUrl({ plataforma, url }) {
  requirePlataforma(plataforma, 'findAnalisisByUrl');
  return analisisLiviano(findAnalisisByUrlStmt.get(plataforma, url));
}

/**
 * Los temas editados de un análisis terminado. Con `columnas`
 * (analysisMetrics.columnasDeVista de la vista con los temas nuevos: unir
 * temas puede cambiar la estrella y el hecho dominante), también las de la
 * galería; con `temaEstrella` solo, esa.
 * @returns {boolean} si había uno.
 */
function updateAnalisisTemas(id, plataforma, temas, { temaEstrella, columnas } = {}) {
  requirePlataforma(plataforma, 'updateAnalisisTemas');
  const ok = updateAnalisisTemasStmt.run(JSON.stringify(temas || []), Number(id), plataforma).changes > 0;
  if (ok && columnas) {
    updateColumnasGaleriaStmt.run({
      pctNeg: columnas.pctNeg ?? null,
      tieneHecho: columnas.tieneHecho ? 1 : 0,
      nVerificados: columnas.nVerificados ?? null,
      temaEstrella: columnas.temaEstrella ?? null,
      id: Number(id),
      plataforma,
    });
  } else if (ok && temaEstrella !== undefined) updateTemaEstrellaStmt.run(temaEstrella, Number(id), plataforma);
  return ok;
}

// Sin acentos ni mayúsculas, para la búsqueda de la galería.
function plegar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

const GALERIA_ORDEN = {
  recent: () => 0, // ya vienen del más reciente al más viejo
  c: (a, b) => (b.comentariosTotal ?? -1) - (a.comentariosTotal ?? -1),
  neg: (a, b) => (b.pctNeg ?? -1) - (a.pctNeg ?? -1),
  ver: (a, b) => (b.nVerificados ?? -1) - (a.nVerificados ?? -1),
};
const GALERIA_FILTRO = {
  all: () => true,
  ev: (a) => a.tieneHecho,
  neg: (a) => a.pctNeg !== null && a.pctNeg >= 40,
  ver: (a) => (a.nVerificados || 0) > 0,
};

/**
 * La galería de análisis terminados: búsqueda (cuenta, texto, tema estrella;
 * sin acentos), filtro (all | ev con hecho dominante | neg 40 % o más |
 * ver con verificados) y orden (recent | c comentarios | neg | ver).
 * @returns {{ items: object[], total: number, desde: string|null, coinciden: number }}
 *   total y desde (el primero) son de todos los terminados, no del filtro;
 *   coinciden, los que pasan la búsqueda y el filtro (antes del tope).
 */
function listAnalisisGaleria({ plataforma, q = '', f = 'all', ord = 'recent', limit = 100 } = {}) {
  requirePlataforma(plataforma, 'listAnalisisGaleria');
  const buscado = plegar(q).trim();
  // Object.hasOwn: "constructor" o "toString" en el pedido no son un filtro.
  const filtro = Object.hasOwn(GALERIA_FILTRO, f) ? GALERIA_FILTRO[f] : GALERIA_FILTRO.all;
  const orden = Object.hasOwn(GALERIA_ORDEN, ord) ? GALERIA_ORDEN[ord] : GALERIA_ORDEN.recent;
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const resumen = resumenGaleriaStmt.get(plataforma);
  const total = Number(resumen.total) || 0;
  const desde = resumen.desde || null;
  // Sin búsqueda, filtro ni orden (el inicio pide 4 por minuto): directo con LIMIT.
  if (!buscado && filtro === GALERIA_FILTRO.all && orden === GALERIA_ORDEN.recent) {
    return { items: listAnalisisStmt.all(plataforma, n).map(analisisLiviano), total, desde, coinciden: total };
  }
  const todos = listAnalisisGaleriaStmt
    .all(plataforma)
    .map(analisisLiviano)
    .filter((a) => filtro(a) && (!buscado || plegar(`${a.cuenta || ''} ${a.caption} ${a.temaEstrella || ''}`).includes(buscado)));
  // coinciden: cuántos pasan la búsqueda y el filtro antes del tope (la galería avisa si corta).
  const items = todos
    .map((a, i) => ({ a, i }))
    .sort((x, y) => orden(x.a, y.a) || x.i - y.i)
    .slice(0, n)
    .map((x) => x.a);
  return { items, total, desde, coinciden: todos.length };
}

/**
 * Los análisis anteriores de una cuenta (sin el actual ni otros de la misma
 * publicación), el más reciente primero, con sus comentarios para contar.
 */
function listAnterioresDeCuenta({ plataforma, cuenta, id, antesDe, postCode = null, limit = 12 }) {
  requirePlataforma(plataforma, 'listAnterioresDeCuenta');
  if (!cuenta) return [];
  return listAnterioresDeCuentaStmt
    .all({ plataforma, cuenta, id: Number(id) || 0, antesDe, postCode, limit: Math.max(1, Math.min(50, Number(limit) || 12)) })
    .map((row) => ({
      id: Number(row.id),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      pctNeg: numberOrNull(row.pct_neg),
      comentariosTotal: numberOrNull(row.comentarios_total),
      nVerificados: numberOrNull(row.n_verificados),
      comentarios: parseJsonColumn(row.comentarios) || [],
      temas: parseJsonColumn(row.temas),
    }));
}

/** Los reclamos que guardó el análisis de una publicación, con `enMapa` (la regla del pin). */
function listReclamosDePost({ plataforma, postUrl }) {
  requirePlataforma(plataforma, 'listReclamosDePost');
  return listReclamosDePostStmt.all(plataforma, postUrl).map((r) => ({
    id: r.id,
    autor: r.autor || null,
    categoria: r.categoria,
    subcategoria: r.subcategoria || null,
    direccion: r.direccion_normalizada || r.direccion_detectada || null,
    direccionDetectada: r.direccion_detectada || null,
    direccionNormalizada: r.direccion_normalizada || null,
    barrio: r.barrio || null,
    comuna: numberOrNull(r.comuna),
    x: numberOrNull(r.x),
    y: numberOrNull(r.y),
    geoStatus: r.geo_status || null,
    estado: r.estado,
    precision: r.precision || null,
    ubicacionTipo: r.ubicacion_tipo || null,
    nombreLugar: r.nombre_lugar || null,
    motivoSinUbicar: r.motivo_sin_ubicar || null,
    texto: r.texto_original || null,
    fecha: r.fecha || null,
    enMapa: Number(r.en_mapa) === 1,
  }));
}

/**
 * Borra un análisis ("Eliminar análisis" de la galería); uno en curso no (lo
 * está escribiendo el trabajo: tira con code ANALISIS_EN_CURSO). Los reclamos
 * de la publicación son de todos sus análisis (cada uno los muestra): se van
 * solo con el último, y nunca los importados de un Excel. La foto la borra
 * quien llama si `fotoLibre` (el post_id): ningún otro análisis ni el
 * Monitoreo la usan.
 * @returns {{ reclamos: number, fotoLibre: string|null } | null} null si no existe en esa plataforma.
 */
function deleteAnalisis(id, plataforma) {
  requirePlataforma(plataforma, 'deleteAnalisis');
  const row = getAnalisisStmt.get(Number(id), plataforma);
  if (!row) return null;
  if (row.estado === 'en curso') {
    const err = new Error('Ese análisis todavía está en curso.');
    err.code = 'ANALISIS_EN_CURSO';
    throw err;
  }
  db.exec('BEGIN');
  try {
    const ultimo = countOtrosAnalisisDeUrlStmt.get(plataforma, row.url, row.id).n === 0;
    const reclamos = ultimo ? Number(deleteReclamosDePostStmt.run(plataforma, row.url).changes) : 0;
    const fotoLibre =
      row.post_id && countOtrosAnalisisDePostIdStmt.get(plataforma, row.post_id, row.id).n === 0 && !isDetectedPostStmt.get(row.post_id, plataforma)
        ? String(row.post_id)
        : null;
    deleteAnalisisStmt.run(row.id, plataforma);
    db.exec('COMMIT');
    return { reclamos, fotoLibre };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** El id de la publicación del Monitoreo con ese link (no ignorada), o null. */
function findMonitoredPostIdByUrl({ plataforma, url }) {
  requirePlataforma(plataforma, 'findMonitoredPostIdByUrl');
  const row = url ? findMonitoredPostByUrlStmt.get(plataforma, url) : null;
  return row ? String(row.id) : null;
}

// --------------------------------------------------------------------
// Figuras públicas (src/figuras.js valida). creado_por es un correo: las
// rutas no lo mandan al navegador.
// --------------------------------------------------------------------

function figuraDeFila(row) {
  if (!row) return null;
  return {
    username: row.username,
    nombre: row.nombre || null,
    rol: row.rol,
    alineacion: row.alineacion || null,
    origen: row.origen,
    notas: row.notas || null,
    creadoPor: row.creado_por || null,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

function listFiguras() {
  return listFigurasStmt.all().map(figuraDeFila);
}

function getFigura(username) {
  return figuraDeFila(getFiguraStmt.get(figurasModelo.normalizeUsername(username)));
}

/** @returns {Map<string, object>} usuario (minúsculas) → figura, de los que están en la tabla. */
function getFigurasPorUsernames(usernames) {
  const lista = [...new Set((usernames || []).map(figurasModelo.normalizeUsername).filter(Boolean))];
  if (!lista.length) return new Map();
  return new Map(getFigurasPorUsernamesStmt.all(JSON.stringify(lista)).map((row) => [row.username, figuraDeFila(row)]));
}

/**
 * Una figura nueva cargada por el equipo. Si ya estaba como sugerencia (o
 * descartada), pasa al equipo con estos datos. Tira con code
 * 'FIGURA_EXISTE' si ya es del equipo.
 */
function createFigura(input, { creadoPor = null, ahora = new Date().toISOString() } = {}) {
  const datos = figurasModelo.validarFigura(input);
  const actual = getFigura(datos.username);
  if (actual && actual.origen === 'equipo') {
    const e = new Error(`@${datos.username} ya está en la lista.`);
    e.userMessage = e.message;
    e.code = 'FIGURA_EXISTE';
    throw e;
  }
  if (actual) updateFiguraStmt.run({ ...datos, origen: 'equipo', creadoPor, ahora });
  else insertFiguraStmt.run({ ...datos, origen: 'equipo', creadoPor, ahora });
  return getFigura(datos.username);
}

/**
 * Cambia una figura (los campos que no vienen quedan); siempre queda como
 * del equipo (confirmar una sugerencia es esto). `por`: el correo de quien
 * la cambió, que queda como creado_por si no tenía (una sugerida no tiene).
 * @returns {object|null}
 */
function updateFigura(username, patch, { por = null, ahora = new Date().toISOString() } = {}) {
  const actual = getFigura(username);
  if (!actual) return null;
  const datos = figurasModelo.validarFigura(patch, { actual });
  updateFiguraStmt.run({ ...datos, origen: 'equipo', creadoPor: por, ahora });
  return getFigura(datos.username);
}

/** @returns {boolean} si estaba. */
function deleteFigura(username) {
  return deleteFiguraStmt.run(figurasModelo.normalizeUsername(username)).changes > 0;
}

/**
 * El equipo descarta una sugerencia del modelo (fase F2): queda en la tabla
 * con origen 'descartada', así el modelo no la vuelve a sugerir. Tira con
 * code 'FIGURA_NO_SUGERIDA' si es del equipo o ya estaba descartada.
 * @returns {object|null} la figura; null si no está en la tabla.
 */
function descartarFigura(username, { ahora = new Date().toISOString() } = {}) {
  const actual = getFigura(username);
  if (!actual) return null;
  if (actual.origen !== 'sugerida') {
    const e = new Error(`@${actual.username} no es una sugerencia del modelo.`);
    e.userMessage = actual.origen === 'equipo' ? `@${actual.username} es del equipo: para sacarla de la lista, quitala.` : `@${actual.username} ya estaba descartada.`;
    e.code = 'FIGURA_NO_SUGERIDA';
    throw e;
  }
  descartarFiguraStmt.run({ username: actual.username, ahora });
  return getFigura(actual.username);
}

/**
 * Lo que sugirió el modelo para un verificado: entra como 'sugerida' si no
 * estaba; si ya era sugerida, se actualiza; si es del equipo o el equipo la
 * descartó, no se toca.
 * @returns {'nueva'|'actualizada'|'del equipo'|'descartada por el equipo'|'descartada'}
 */
function upsertFiguraSugerida(raw, { ahora = new Date().toISOString() } = {}) {
  const s = figurasModelo.sanitizarSugerencia(raw);
  if (!s) return 'descartada';
  const actual = getFigura(s.username);
  if (actual && actual.origen === 'equipo') return 'del equipo';
  if (actual && actual.origen === 'descartada') return 'descartada por el equipo';
  if (actual) {
    updateFiguraSugeridaStmt.run({ ...s, ahora });
    return 'actualizada';
  }
  insertFiguraStmt.run({ ...s, nombre: null, notas: null, origen: 'sugerida', creadoPor: null, ahora });
  return 'nueva';
}

/**
 * Los análisis que quedaron "en curso" de un arranque anterior pasan a
 * "interrumpido". Lo llama SOLO server.js al arrancar: un script que abre
 * la base mientras la app corre no tiene que tocar un análisis vivo.
 * @returns {number} cuántos
 */
function markInterruptedAnalisis(now = new Date().toISOString()) {
  return Number(markInterruptedAnalisisStmt.run(now).changes) || 0;
}

/** Lo que costó en Apify un análisis (sus filas de apify_calls). */
function sumApifyUsdForAnalisis(id) {
  const row = sumApifyUsdForAnalisisStmt.get(Number(id));
  return { usd: Number(row.usd) || 0, calls: Number(row.calls) || 0 };
}

module.exports = {
  startAnalisis,
  saveAnalisisPost,
  finishAnalisis,
  failAnalisis,
  markAnalisisImage,
  getAnalisis,
  listAnalisis,
  findAnalisisByUrl,
  updateAnalisisTemas,
  listAnalisisGaleria,
  listAnterioresDeCuenta,
  listReclamosDePost,
  deleteAnalisis,
  findMonitoredPostIdByUrl,
  listFiguras,
  getFigura,
  getFigurasPorUsernames,
  createFigura,
  updateFigura,
  deleteFigura,
  descartarFigura,
  upsertFiguraSugerida,
  markInterruptedAnalisis,
  sumApifyUsdForAnalisis,
  findExistingPostId,
  isKnownPost,
  saveDetectedPost,
  listDetectedPosts,
  countRecentPosts,
  listUnclassified,
  updateClassification,
  updateTema,
  updateSentiment,
  ignorePost,
  getPostIgnoreState,
  upsertAccountStats,
  getAccountStats,
  getAccountStatsFreshness,
  listAllAccountStats,
  upsertAccountFollowers,
  getAccountFollowers,
  listDistinctPostAccounts,
  listAccountBenchmarkActivity,
  touchAccountStatsComputedAt,
  updatePostMetricsIfChanged,
  updateFollowersForAccount,
  getRefreshState,
  setRefreshState,
  deleteRefreshState,
  listRefreshStateByPrefix,
  advanceRefreshState,
  initRefreshState,
  getSearchSeen,
  isSearchSeen,
  markSearchSeen,
  addSearchSeenTerms,
  purgeSearchSeen,
  insertApifyCall,
  closeApifyCall,
  getApifyCall,
  markApifyCallRecovered,
  markApifyCallLost,
  lastSearchCallsForTerm,
  sumSearchSeenByRun,
  listFailedCallsWithoutRun,
  hasApifyRun,
  settleApifyCall,
  listApifyRunIdsSince,
  startMonitoringRun,
  getLastFinishedDeepRunAt,
  finishMonitoringRun,
  getMonitoringRun,
  startRunSource,
  updateRunSource,
  getRunSource,
  listRunSources,
  listRunSourcesOfRun,
  listPendingRunSources,
  listRunSourcesRecoveredIn,
  lastRunSourcesForKey,
  clearTopeLlenoPrimerIntento,
  getLastFinishedRunAt,
  getLastFinishedRunAtAny,
  getLastFinishedRun,
  listPostsDetectedBetween,
  listPostsForStats,
  listIgnoredPostsForStats,
  listRunTracesForStats,
  countDiscardedSearchesForStats,
  getFirstPostedAt,
  countPostedSinceAllPlatforms,
  countTemasSinceAllPlatforms,
  getFirstDetectedAtAny,
  countReclamosEnMapa,
  listRunsBetween,
  listFollowersForStats,
  sumApifyCallsSince,
  listApifyCallsPendingRealCost,
  setApifyCallRealCost,
  recomputeMonitoringRunUsd,
  listAccountsDueForRefresh,
  listPostsDueForRefresh,
  registerRefreshMiss,
  applyMetricsRefresh,
  getPostImage,
  markPostImageSaved,
  markPostImageFailed,
  markPostImagePending,
  listPostsWithPendingImage,
  upsertReclamo,
  listReclamosFiltered,
  contarReclamosPorCategoria,
  listReclamosPorOrigen,
  deleteReclamosPorOrigen,
  updateEstado,
  listPendingGeoReclamos,
  reabrirSinCoordenadas,
  contarUbicados,
  updateReclamoGeo,
  getReclamo,
  setReclamoUbicacion,
  marcarReclamoCorregido,
  descartarReclamo,
  getLugarCache,
  setLugarCache,
  countReclamos,
  getGeocodeCache,
  setGeocodeCache,
  insertMagicLink,
  claimMagicLink,
  deleteUnusedMagicLinks,
  createSession,
  getSession,
  touchSession,
  revokeSession,
  revokeSessionsByEmail,
  purgeSessions,
  upsertXInfluencer,
  upsertXInfluencers,
  getXInfluencer,
  listXInfluencers,
  countXInfluencers,
  getXInfluencerMap,
};
