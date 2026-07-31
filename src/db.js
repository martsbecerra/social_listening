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
const deletePostStmt = db.prepare('DELETE FROM detected_posts WHERE id = ?');

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

module.exports = {
  isKnownPost,
  saveDetectedPost,
  markNotified,
  listDetectedPosts,
  listUnnotified,
  listUnclassified,
  updateClassification,
  deletePost,
};
