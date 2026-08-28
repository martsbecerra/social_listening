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
// normalizeMonitorPost para armar el id (raw.id vs shortCode), sin este
// índice se insertaría una segunda fila y se re-notificaría.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS detected_posts_url_unique ON detected_posts(url)');

const isKnownPostStmt = db.prepare('SELECT 1 FROM detected_posts WHERE id = ?');
const getPostIdByUrlStmt = db.prepare('SELECT id FROM detected_posts WHERE url = ?');
// OR IGNORE: un segundo ciclo en paralelo (cron + "Actualizar ahora") no
// puede tirar abajo toda la corrida con UNIQUE constraint failed. Si el
// posteo ya está, changes === 0 y el llamador lo trata como conocido.
const insertPostStmt = db.prepare(`
  INSERT OR IGNORE INTO detected_posts
    (id, account, url, caption, matched_reason, likes, comments, posted_at, detected_at, notified, title, sentiment, post_type, followers)
  VALUES
    (@id, @account, @url, @caption, @matchedReason, @likes, @comments, @postedAt, @detectedAt, 0, @title, @sentiment, @postType, @followers)
`);
const setNotifiedStmt = db.prepare('UPDATE detected_posts SET notified = ? WHERE id = ?');
const countPostsStmt = db.prepare('SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0');
const countRecentPostsStmt = db.prepare('SELECT COUNT(*) AS total FROM detected_posts WHERE ignored = 0 AND detected_at >= ?');
const listPostsPageStmt = db.prepare('SELECT * FROM detected_posts WHERE ignored = 0 ORDER BY detected_at DESC LIMIT ? OFFSET ?');
const listUnclassifiedStmt = db.prepare('SELECT id, caption FROM detected_posts WHERE title IS NULL AND ignored = 0 ORDER BY detected_at ASC');
const updateClassificationStmt = db.prepare('UPDATE detected_posts SET title = ?, sentiment = ? WHERE id = ?');
const updateSentimentStmt = db.prepare('UPDATE detected_posts SET sentiment = ? WHERE id = ?');
// Solo la primera vez: si ya estaba ignorado, ignored_at se conserva.
const ignorePostStmt = db.prepare(
  'UPDATE detected_posts SET ignored = 1, ignored_at = ? WHERE id = ? AND ignored = 0'
);
const getPostIgnoredAtStmt = db.prepare('SELECT ignored, ignored_at FROM detected_posts WHERE id = ?');

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

// Mediana de likes/comentarios por cuenta (y por tipo de posteo, si se pudo
// determinar) — la referencia contra la que se clasifica un posteo detectado
// como alto/normal/bajo. Ver src/accountStats.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS account_stats (
    account TEXT NOT NULL,
    platform TEXT NOT NULL,
    post_type TEXT CHECK(post_type IN ('reel','imagen','carrusel') OR post_type IS NULL),
    n_posts INTEGER NOT NULL,
    median_likes REAL,
    median_comments REAL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (account, platform, post_type)
  )
`);

// INSERT/UPDATE separados en vez de "INSERT ... ON CONFLICT": SQLite trata
// cada NULL como distinto de cualquier otro NULL a los fines de la
// restricción UNIQUE/PRIMARY KEY, así que "ON CONFLICT(account, platform,
// post_type)" nunca dispara cuando post_type es NULL — cada recálculo de una
// cuenta sin tipo detectado insertaría una fila nueva en vez de actualizar
// la existente. Con el SELECT previo (que sí usa "IS") no depende de esa
// semántica de NULL para nada.
const insertAccountStatsStmt = db.prepare(`
  INSERT INTO account_stats (account, platform, post_type, n_posts, median_likes, median_comments, computed_at)
  VALUES (@account, @platform, @postType, @nPosts, @medianLikes, @medianComments, @computedAt)
`);
const updateAccountStatsStmt = db.prepare(`
  UPDATE account_stats
  SET n_posts = @nPosts, median_likes = @medianLikes, median_comments = @medianComments, computed_at = @computedAt
  WHERE account = @account AND platform = @platform AND post_type IS @postType
`);
// "post_type IS ?" (no "=") porque "= NULL" nunca matchea en SQL, ni para
// las cuentas sin desglose por tipo (post_type NULL de los dos lados).
const getAccountStatsStmt = db.prepare(`
  SELECT * FROM account_stats WHERE account = ? AND platform = ? AND post_type IS ?
`);
const getAccountStatsFreshnessStmt = db.prepare(`
  SELECT MAX(computed_at) AS lastComputedAt FROM account_stats WHERE account = ? AND platform = ?
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
    platform TEXT NOT NULL,
    followers INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account, platform)
  )
`);
const insertAccountFollowersStmt = db.prepare(`
  INSERT INTO account_followers (account, platform, followers, updated_at)
  VALUES (@account, @platform, @followers, @updatedAt)
`);
const updateAccountFollowersStmt = db.prepare(`
  UPDATE account_followers SET followers = @followers, updated_at = @updatedAt
  WHERE account = @account AND platform = @platform
`);
const getAccountFollowersStmt = db.prepare(
  'SELECT followers FROM account_followers WHERE account = ? AND platform = ?'
);

// Carga inicial / recálculo forzado del benchmark (ver scripts/recalc-
// account-stats.js): el universo de cuentas a procesar es la unión de las
// trackeadas (config/monitoring.json) con las que ya aparecen en
// detected_posts (llegaron por hashtag, nunca se trackearon explícitamente).
const listDistinctPostAccountsStmt = db.prepare(
  `SELECT DISTINCT account FROM detected_posts WHERE ignored = 0 AND account IS NOT NULL AND account != 'N/D' ORDER BY account`
);
// Freshness de TODAS las cuentas de una, no una query por cuenta — con
// 100-150 cuentas en el universo ampliado, N queries individuales ya no es
// gratis (ver accountStats.refreshStaleAccountStats).
const getAllAccountStatsFreshnessStmt = db.prepare(
  'SELECT account, MAX(computed_at) AS lastComputedAt FROM account_stats WHERE platform = ? GROUP BY account'
);
const getPostMetricsStmt = db.prepare('SELECT likes, comments, post_type, ignored FROM detected_posts WHERE id = ?');
const updatePostMetricsStmt = db.prepare(
  'UPDATE detected_posts SET likes = @likes, comments = @comments, post_type = @postType, metrics_updated_at = @metricsUpdatedAt WHERE id = @id'
);
const updateFollowersForAccountStmt = db.prepare('UPDATE detected_posts SET followers = ? WHERE account = ?');

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
  WHERE ignored = 0 AND account IS NOT NULL AND account != 'N/D' AND posted_at IS NOT NULL
    AND posted_at > @sinceIso AND posted_at <= @untilIso
    AND (@cadenceIso IS NULL OR metrics_updated_at IS NULL OR metrics_updated_at < @cadenceIso)
  GROUP BY account
`);

const getPostForMetricsRefreshStmt = db.prepare(
  'SELECT likes, comments, account, posted_at, ignored FROM detected_posts WHERE id = ?'
);
const applyMetricsRefreshStmt = db.prepare(
  'UPDATE detected_posts SET likes = @likes, comments = @comments, metrics_updated_at = @metricsUpdatedAt WHERE id = @id'
);

const upsertReclamoStmt = db.prepare(`
  INSERT INTO reclamos (
    id, comentario_id, plataforma, post_url, comment_url, autor, fecha,
    detected_at, texto_original, categoria, subcategoria, precision_fecha, import_origen, direccion_detectada,
    direccion_normalizada, calle, altura, cruce, x, y, comuna, barrio,
    precision, geo_status, estado
  ) VALUES (
    @id, @comentarioId, @plataforma, @postUrl, @commentUrl, @autor, @fecha,
    @detectedAt, @textoOriginal, @categoria, @subcategoria, @precisionFecha, @importOrigen, @direccionDetectada,
    @direccionNormalizada, @calle, @altura, @cruce, @x, @y, @comuna, @barrio,
    @precision, @geoStatus, @estado
  )
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
    estado = excluded.estado
`);
const listPendingGeoReclamosStmt = db.prepare(`SELECT * FROM reclamos WHERE geo_status = 'pendiente'`);
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
      geo_status = @geoStatus
  WHERE id = @id
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

/**
 * @returns {boolean} true si se insertó una fila nueva. false si ya existía
 * (mismo id o misma url) — no tira UNIQUE.
 */
function saveDetectedPost(post) {
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
    postType: post.postType || null,
    followers: post.followers ?? null,
  });
  return result.changes > 0;
}

/**
 * Marca a mano si un posteo ya se comunicó o no (columna "Notificado" de la
 * tabla de monitoreo). Es un campo puramente manual: las notificaciones
 * automáticas por email se eliminaron.
 */
function setNotified(id, notified) {
  setNotifiedStmt.run(notified ? 1 : 0, id);
}

/**
 * Página de posteos detectados (los más nuevos primero) + el total de filas,
 * para poder armar la paginación en la interfaz. Los ignorados no salen:
 * siguen en la tabla SQLite para el dedupe, pero no en este listado.
 */
function listDetectedPosts({ page = 1, pageSize = 20 } = {}) {
  const total = countPostsStmt.get().total;
  const offset = (page - 1) * pageSize;
  const posts = listPostsPageStmt.all(pageSize, offset);
  return { posts, total };
}

/**
 * Posteos guardados a los que todavía no se les generó título/sentimiento
 * (posteos viejos de antes de esta funcionalidad, o alguno que falló al
 * clasificar). Sirve para el "backfill" manual.
 */
function listUnclassified() {
  return listUnclassifiedStmt.all();
}

function updateClassification(id, { title, sentiment }) {
  updateClassificationStmt.run(title, sentiment, id);
}

/**
 * Corrección manual del sentimiento de un registro (por si Haiku se
 * equivocó). No toca el título ni ningún otro campo.
 */
function updateSentiment(id, sentiment) {
  updateSentimentStmt.run(sentiment, id);
}

/**
 * Marca un posteo como ignorado (cruz de la tabla de monitoreo). La fila
 * se queda: findExistingPostId y el unique de url siguen viéndola, así que
 * la próxima corrida no la re-detecta ni re-notifica. No hay deshacer en
 * la UI; ignored_at queda para auditoría. Si ya estaba ignorado, no pisa
 * la fecha original.
 */
function ignorePost(id) {
  ignorePostStmt.run(new Date().toISOString(), id);
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
  };
}

/**
 * Alta o actualización de un reclamo (análisis en vivo o import de Excel).
 * `id` y `comentarioId` los arma el llamador (ver src/reclamosFromAnalysis.js
 * y scripts/import-reclamos.js) para poder deduplicar entre corridas.
 */
function upsertReclamo(reclamo) {
  // Última barrera: nada entra a la tabla sin pasar por la lista cerrada de
  // config/categorias-reclamos.json. Ya no hay CHECK en el esquema que ataje
  // una categoría inventada, así que la validación tiene que estar acá sí o sí.
  const { categoria, subcategoria } = normalizeClasificacion({
    categoria: reclamo.categoria,
    subcategoria: reclamo.subcategoria,
    contexto: reclamo.id,
  });

  upsertReclamoStmt.run({
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
  });
}

/**
 * Reclamos filtrados para el mapa y para la descarga de CSV (comparten la
 * misma consulta: el CSV exporta todo lo que matchea, no solo lo con pin).
 * @param {{ categoria?: string[], subcategoria?: string[], estado?: string[], barrio?: string,
 *   comuna?: number, desde?: string, hasta?: string, q?: string }} filters
 */
function listReclamosFiltered(filters = {}) {
  const { categoria, subcategoria, estado, barrio, comuna, desde, hasta, q } = filters;
  // Siempre afuera, pasen los filtros que pasen: quedan marcados en la DB
  // para poder auditar el geocoding, pero nunca se muestran ni se exportan.
  const clauses = [`geo_status IS NOT 'fuera_caba'`];
  const params = {};

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
function contarReclamosPorCategoria() {
  const filas = db
    .prepare("SELECT categoria, COUNT(*) AS total FROM reclamos WHERE geo_status IS NOT 'fuera_caba' GROUP BY categoria")
    .all();
  return Object.fromEntries(filas.map((f) => [f.categoria, f.total]));
}

function updateEstado(id, estado) {
  updateEstadoStmt.run(estado, id);
}

function listPendingGeoReclamos() {
  return listPendingGeoReclamosStmt.all().map(mapReclamoRow);
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
function countRecentPosts(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return countRecentPostsStmt.get(cutoff).total;
}

function mapAccountStatsRow(row) {
  return {
    account: row.account,
    platform: row.platform,
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
    platform: row.platform,
    postType: row.postType ?? null,
    nPosts: row.nPosts,
    medianLikes: row.medianLikes,
    medianComments: row.medianComments,
    computedAt: row.computedAt || new Date().toISOString(),
  };
  const existing = getAccountStatsStmt.get(params.account, params.platform, params.postType);
  if (existing) {
    updateAccountStatsStmt.run(params);
  } else {
    insertAccountStatsStmt.run(params);
  }
}

function getAccountStats(account, platform, postType) {
  const row = getAccountStatsStmt.get(account, platform, postType ?? null);
  return row ? mapAccountStatsRow(row) : null;
}

/** @returns {string|null} ISO de la fila más nueva de esta cuenta, o null si no tiene ninguna. */
function getAccountStatsFreshness(account, platform) {
  return getAccountStatsFreshnessStmt.get(account, platform).lastComputedAt;
}

function listAllAccountStats() {
  return listAllAccountStatsStmt.all().map(mapAccountStatsRow);
}

function upsertAccountFollowers({ account, platform, followers, updatedAt }) {
  const params = { account, platform, followers: followers ?? null, updatedAt: updatedAt || new Date().toISOString() };
  const existing = getAccountFollowersStmt.get(account, platform);
  if (existing) {
    updateAccountFollowersStmt.run(params);
  } else {
    insertAccountFollowersStmt.run(params);
  }
}

/** @returns {number|null} Última cantidad de seguidores cacheada, o null si nunca se calculó. */
function getAccountFollowers(account, platform) {
  const row = getAccountFollowersStmt.get(account, platform);
  return row ? row.followers : null;
}

/** @returns {string[]} Cuentas distintas presentes en detected_posts (sin NULL ni 'N/D'). */
function listDistinctPostAccounts() {
  return listDistinctPostAccountsStmt.all().map((row) => row.account);
}

/** @returns {{account: string, lastComputedAt: string|null}[]} Freshness de account_stats para TODAS las cuentas que tengan al menos una fila, de una sola query. */
function getAllAccountStatsFreshness(platform) {
  return getAllAccountStatsFreshnessStmt.all(platform);
}

/**
 * Actualiza likes/comments/post_type de un posteo YA guardado si algo
 * cambió (ej. un recálculo de benchmark trae el mismo posteo con métricas
 * nuevas, o con un post_type que antes no se guardaba). No hace nada si el
 * id no existe en detected_posts — nunca inserta, solo actualiza lo que ya
 * está. rejectNegative evita reabrir la puerta al centinela -1 de Apify por
 * esta vía.
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
  const cleanLikes = rejectNegative(likes ?? null);
  const cleanComments = rejectNegative(comments ?? null);
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

/** Propaga la cantidad de seguidores a TODOS los posteos ya guardados de una cuenta (no solo a los nuevos). */
function updateFollowersForAccount(account, followers) {
  updateFollowersForAccountStmt.run(followers ?? null, account);
}

function getRefreshState(key) {
  const row = getRefreshStateStmt.get(key);
  return row ? row.value : null;
}

function setRefreshState(key, value) {
  setRefreshStateStmt.run({ key, value });
}

/**
 * Cuentas con al menos un posteo con posted_at en (sinceIso, untilIso] que
 * cumpla la cadencia (cadenceIso null = sin filtro de metrics_updated_at).
 * @returns {{account: string, mostRecentPostedAt: string, postCount: number}[]}
 */
function listAccountsDueForRefresh({ sinceIso, untilIso, cadenceIso = null }) {
  return listAccountsDueForRefreshStmt.all({ sinceIso, untilIso, cadenceIso });
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
 * @returns {{changed: boolean, account: string, postedAt: string,
 *   previousLikes: number|null, previousComments: number|null,
 *   likes: number|null, comments: number|null}|null} null si el id no está
 *   guardado o está ignorado (no se escriben métricas de un ignorado).
 */
function applyMetricsRefresh(id, { likes, comments }) {
  const existing = getPostForMetricsRefreshStmt.get(id);
  if (!existing || existing.ignored) return null;
  const cleanLikes = rejectNegative(likes ?? null);
  const cleanComments = rejectNegative(comments ?? null);
  const changed = existing.likes !== cleanLikes || existing.comments !== cleanComments;

  applyMetricsRefreshStmt.run({
    id,
    likes: cleanLikes,
    comments: cleanComments,
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

module.exports = {
  findExistingPostId,
  isKnownPost,
  saveDetectedPost,
  setNotified,
  listDetectedPosts,
  countRecentPosts,
  listUnclassified,
  updateClassification,
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
  getAllAccountStatsFreshness,
  updatePostMetricsIfChanged,
  updateFollowersForAccount,
  getRefreshState,
  setRefreshState,
  listAccountsDueForRefresh,
  applyMetricsRefresh,
  upsertReclamo,
  listReclamosFiltered,
  contarReclamosPorCategoria,
  listReclamosPorOrigen,
  deleteReclamosPorOrigen,
  updateEstado,
  listPendingGeoReclamos,
  updateReclamoGeo,
  countReclamos,
  getGeocodeCache,
  setGeocodeCache,
  insertMagicLink,
  claimMagicLink,
  upsertXInfluencer,
  upsertXInfluencers,
  getXInfluencer,
  listXInfluencers,
  countXInfluencers,
  getXInfluencerMap,
};
