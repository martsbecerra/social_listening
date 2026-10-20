// ==========================================================================
// replicaFiles.js — Copias de archivos del snapshot de las réplicas.
// --------------------------------------------------------------------------
// Lo comparten la publicación (data/media -> carpeta de publicación) y la
// sincronización de la réplica (clon del repo de datos -> data/media).
// No conoce la base ni git.
// ==========================================================================

const fs = require('fs');
const path = require('path');

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function removeEmptyDirs(dir, keepRoot = true) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name), false);
  }
  if (!keepRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Deja `dest` igual a `src`: copia lo que falta o cambió de tamaño y borra
 * lo que ya no está. Las fotos no cambian una vez guardadas: con el tamaño
 * alcanza para saber si hay que copiar. `src` inexistente = vacío.
 * @returns {{ copied: number, removed: number }}
 */
function mirrorDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const wanted = new Set(listFiles(src));
  let copied = 0;
  let removed = 0;
  for (const rel of wanted) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  }
  for (const rel of listFiles(dest)) {
    if (wanted.has(rel)) continue;
    fs.unlinkSync(path.join(dest, rel));
    removed += 1;
  }
  removeEmptyDirs(dest);
  return { copied, removed };
}

/** Copia a un temporal al lado y renombra: quien lee nunca ve un archivo a medias. */
function copyFileAtomic(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/** Escribe un archivo con el mismo cuidado que copyFileAtomic. */
function writeFileAtomic(to, content) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, to);
}

module.exports = { mirrorDir, copyFileAtomic, writeFileAtomic, listFiles };
