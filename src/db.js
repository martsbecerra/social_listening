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
// notificarlo dos veces en corridas futuras.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeTematica } = require('./tematica');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'monitoring.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

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

const isKnownPostStmt = db.prepare('SELECT 1 FROM detected_posts WHERE id = ?');
const insertPostStmt = db.prepare(`
  INSERT INTO detected_posts
    (id, account, url, caption, matched_reason, likes, comments, posted_at, detected_at, notified, title, sentiment)
  VALUES
    (@id, @account, @url, @caption, @matchedReason, @likes, @comments, @postedAt, @detectedAt, 0, @title, @sentiment)
`);
const markNotifiedStmt = db.prepare('UPDATE detected_posts SET notified = 1 WHERE id = ?');
const countPostsStmt = db.prepare('SELECT COUNT(*) AS total FROM detected_posts');
const listPostsPageStmt = db.prepare('SELECT * FROM detected_posts ORDER BY detected_at DESC LIMIT ? OFFSET ?');
const listUnnotifiedStmt = db.prepare('SELECT * FROM detected_posts WHERE notified = 0 ORDER BY detected_at ASC');
const listUnclassifiedStmt = db.prepare('SELECT id, caption FROM detected_posts WHERE title IS NULL ORDER BY detected_at ASC');
const updateClassificationStmt = db.prepare('UPDATE detected_posts SET title = ?, sentiment = ? WHERE id = ?');
const updateSentimentStmt = db.prepare('UPDATE detected_posts SET sentiment = ? WHERE id = ?');
const deletePostStmt = db.prepare('DELETE FROM detected_posts WHERE id = ?');

db.exec(`
  CREATE TABLE IF NOT EXISTS reclamos (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    username TEXT,
    comment_text TEXT NOT NULL,
    post_url TEXT,
    comment_url TEXT,
    tematica TEXT NOT NULL,
    direccion_detectada TEXT,
    direccion_normalizada TEXT,
    lat REAL,
    lng REAL,
    geocode_status TEXT,
    posted_at TEXT,
    imported_at TEXT NOT NULL
  )
`);

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

const upsertReclamoStmt = db.prepare(`
  INSERT INTO reclamos (
    id, source, username, comment_text, post_url, comment_url, tematica,
    direccion_detectada, direccion_normalizada, lat, lng, geocode_status,
    posted_at, imported_at
  ) VALUES (
    @id, @source, @username, @commentText, @postUrl, @commentUrl, @tematica,
    @direccionDetectada, @direccionNormalizada, @lat, @lng, @geocodeStatus,
    @postedAt, @importedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    source = excluded.source,
    username = excluded.username,
    comment_text = excluded.comment_text,
    post_url = excluded.post_url,
    comment_url = excluded.comment_url,
    tematica = excluded.tematica,
    direccion_detectada = excluded.direccion_detectada,
    direccion_normalizada = excluded.direccion_normalizada,
    lat = excluded.lat,
    lng = excluded.lng,
    geocode_status = excluded.geocode_status,
    posted_at = excluded.posted_at,
    imported_at = excluded.imported_at
`);
const listReclamosStmt = db.prepare('SELECT * FROM reclamos ORDER BY imported_at ASC');
const listPendingGeocodeStmt = db.prepare(`
  SELECT DISTINCT direccion_normalizada AS direccionNormalizada
  FROM reclamos
  WHERE geocode_status = 'pending'
    AND direccion_normalizada IS NOT NULL
    AND TRIM(direccion_normalizada) != ''
`);
const applyGeocodeStmt = db.prepare(`
  UPDATE reclamos
  SET lat = ?, lng = ?, geocode_status = ?
  WHERE direccion_normalizada = ?
`);
const getGeocodeCacheStmt = db.prepare('SELECT * FROM geocode_cache WHERE query_key = ?');
const setGeocodeCacheStmt = db.prepare(`
  INSERT INTO geocode_cache (query_key, lat, lng, display_name, status, fetched_at)
  VALUES (@queryKey, @lat, @lng, @displayName, @status, @fetchedAt)
  ON CONFLICT(query_key) DO UPDATE SET
    lat = excluded.lat,
    lng = excluded.lng,
    display_name = excluded.display_name,
    status = excluded.status,
    fetched_at = excluded.fetched_at
`);
const countReclamosStmt = db.prepare('SELECT COUNT(*) AS total FROM reclamos');
const deleteReclamosBySourceStmt = db.prepare('DELETE FROM reclamos WHERE source = ?');
const updateReclamoTematicaStmt = db.prepare('UPDATE reclamos SET tematica = ? WHERE id = ?');

function isKnownPost(id) {
  return Boolean(isKnownPostStmt.get(id));
}

function saveDetectedPost(post) {
  insertPostStmt.run({
    id: post.id,
    account: post.account || null,
    url: post.url,
    caption: post.caption || '',
    matchedReason: post.matchedReason || '',
    likes: post.likes ?? null,
    comments: post.comments ?? null,
    postedAt: post.postedAt || null,
    detectedAt: new Date().toISOString(),
    title: post.title || null,
    sentiment: post.sentiment || null,
  });
}

function markNotified(id) {
  markNotifiedStmt.run(id);
}

/**
 * Página de posteos detectados (los más nuevos primero) + el total de filas,
 * para poder armar la paginación en la interfaz.
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
 * Borra un registro puntual de la tabla (ej. un posteo que no sirve, o un
 * "posteo" basura guardado por un bug). No hay deshacer.
 */
function deletePost(id) {
  deletePostStmt.run(id);
}

/**
 * Posteos guardados que todavía no se notificaron con éxito: incluye tanto
 * los recién detectados en esta corrida como los de corridas anteriores
 * donde el envío de email falló (para reintentarlo en vez de perderlos
 * para siempre). Devuelve el mismo formato camelCase que espera notify.js.
 */
function listUnnotified() {
  return listUnnotifiedStmt.all().map((row) => ({
    id: row.id,
    account: row.account,
    url: row.url,
    caption: row.caption,
    matchedReason: row.matched_reason,
    likes: row.likes,
    comments: row.comments,
    postedAt: row.posted_at,
  }));
}

function mapReclamoRow(row) {
  return {
    id: row.id,
    source: row.source,
    username: row.username,
    commentText: row.comment_text,
    postUrl: row.post_url,
    commentUrl: row.comment_url,
    tematica: row.tematica,
    direccionDetectada: row.direccion_detectada,
    direccionNormalizada: row.direccion_normalizada,
    lat: row.lat,
    lng: row.lng,
    geocodeStatus: row.geocode_status,
    postedAt: row.posted_at,
    importedAt: row.imported_at,
  };
}

function upsertReclamo(reclamo) {
  upsertReclamoStmt.run({
    id: reclamo.id,
    source: reclamo.source,
    username: reclamo.username || null,
    commentText: reclamo.commentText,
    postUrl: reclamo.postUrl || null,
    commentUrl: reclamo.commentUrl || null,
    tematica: normalizeTematica(reclamo.tematica),
    direccionDetectada: reclamo.direccionDetectada || null,
    direccionNormalizada: reclamo.direccionNormalizada || null,
    lat: reclamo.lat ?? null,
    lng: reclamo.lng ?? null,
    geocodeStatus: reclamo.geocodeStatus || 'no_address',
    postedAt: reclamo.postedAt || null,
    importedAt: reclamo.importedAt || new Date().toISOString(),
  });
}

function listReclamos() {
  return listReclamosStmt.all().map(mapReclamoRow);
}

function listPendingGeocode() {
  return listPendingGeocodeStmt
    .all()
    .map((row) => row.direccionNormalizada)
    .filter(Boolean);
}

function applyGeocodeToReclamos(direccionNormalizada, { lat, lng, status }) {
  applyGeocodeStmt.run(lat ?? null, lng ?? null, status, direccionNormalizada);
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
  });
}

function countReclamos() {
  return countReclamosStmt.get().total;
}

function deleteReclamosBySource(source) {
  const result = deleteReclamosBySourceStmt.run(source);
  return result.changes;
}

function updateReclamoTematica(id, tematica) {
  updateReclamoTematicaStmt.run(normalizeTematica(tematica), id);
}

module.exports = {
  isKnownPost,
  saveDetectedPost,
  markNotified,
  listDetectedPosts,
  listUnnotified,
  listUnclassified,
  updateClassification,
  updateSentiment,
  deletePost,
  upsertReclamo,
  listReclamos,
  listPendingGeocode,
  applyGeocodeToReclamos,
  getGeocodeCache,
  setGeocodeCache,
  countReclamos,
  deleteReclamosBySource,
  updateReclamoTematica,
};
