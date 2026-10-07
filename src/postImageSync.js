// ==========================================================================
// postImageSync.js — Las fotos de los posteos dentro del ciclo de monitoreo.
// --------------------------------------------------------------------------
// Une las dos mitades (ver openspec/changes/monitoreo-fotos):
//   - src/postImages.js baja la imagen y deja las dos copias en disco, sin
//     saber nada de la base;
//   - src/db.js guarda el link, el estado y cuándo se guardaron las copias.
// El ciclo le pasa los posteos de una respuesta que ya pidió (el detalle al
// detectar, el refresco por URL) con el link de imagen que vino en esa misma
// respuesta. Acá NUNCA se le pide nada a Apify ni a la plataforma: si la
// respuesta no trajo link, el posteo queda sin foto.
//
// Se baja solo lo que falta: un posteo con sus copias guardadas no se vuelve
// a bajar. "Tiene copias" es la marca de la base Y los archivos en disco: si
// se restauró una base sin su carpeta data/media, la foto se baja de nuevo.
//
// NUNCA tira: una foto que no se pudo guardar no frena el ciclo. Con
// POST_IMAGES=0 (o sin sharp) no hace nada.
//
// Logs: una línea de resumen por ciclo (la imprime el scheduler con
// takeCycleSummary) y, si una foto falla, su renglón de detalle (lo escribe
// postImages.js). Nada por cada foto que sale bien.
// ==========================================================================

const db = require('./db');
const postImages = require('./postImages');
const progress = require('./monitoringProgress');

const PHASE_LABEL = 'Guardando fotos';

function emptyStats() {
  return { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, skipped: 0 };
}

// Lo que va del ciclo en curso (la detección y el refresco suman acá). Dos
// ciclos no corren a la vez: el scheduler lo garantiza.
let cycleStats = emptyStats();

/** Anota en la base cómo salió una foto y lo suma a la cuenta. Nunca tira. */
function record(plataforma, item, result, stats) {
  try {
    if (!result || result.skipped) {
      stats.skipped += 1;
      return;
    }
    if (result.ok) {
      db.markPostImageSaved(item.id, plataforma, {
        sourceUrl: result.sourceUrl || item.url,
        width: result.width,
        height: result.height,
        savedAt: result.savedAt,
      });
      stats.saved += 1;
      return;
    }
    const status = result.status === 'vencido' ? 'vencido' : 'error';
    db.markPostImageFailed(item.id, plataforma, { sourceUrl: result.sourceUrl || item.url, status });
    if (status === 'vencido') stats.expired += 1;
    else stats.failed += 1;
  } catch (err) {
    stats.failed += 1;
    console.error(`[imagenes] (${plataforma}) ${item.id}: no se pudo anotar el resultado de la foto en la base:`, err && err.message);
  }
}

/**
 * Guarda la foto de los posteos que todavía no la tienen. NUNCA tira.
 *
 * @param {string} plataforma
 * @param {{ id: string, url: string }[]} items posteos YA guardados en
 *   detected_posts, con el link de imagen que vino en la respuesta. Los que
 *   no traen link se ignoran.
 * @param {object} [deps] para los tests (los de postImages.savePostImage).
 * @returns {Promise<{candidates: number, alreadySaved: number, saved: number,
 *   expired: number, failed: number, skipped: number}>} candidates: posteos
 *   con link; alreadySaved: ya tenían sus copias; saved / expired / failed:
 *   cómo salieron los intentos; skipped: no se llegaron a intentar (se cortó
 *   la tanda por fallos de red).
 */
async function syncPostImages(plataforma, items, deps = {}) {
  const stats = emptyStats();
  try {
    if (!postImages.isEnabled()) return stats;
    if (!Object.prototype.hasOwnProperty.call(postImages.IMAGE_HOSTS, plataforma)) return stats;

    // Un link por posteo (si un posteo vino dos veces, vale el último).
    const linkById = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.id === undefined || item.id === null) continue;
      if (typeof item.url !== 'string' || !item.url.trim()) continue;
      linkById.set(String(item.id), item.url.trim());
    }

    const pending = [];
    for (const [id, url] of linkById) {
      const state = db.getPostImage(id, plataforma);
      if (!state) continue; // no es un posteo guardado de esta plataforma
      stats.candidates += 1;
      if (state.savedAt && postImages.hasLocalCopy(plataforma, id, deps.mediaDir)) {
        stats.alreadySaved += 1;
        continue;
      }
      pending.push({ plataforma, id, url });
    }

    if (pending.length > 0) {
      // Una fase más del progreso de "Actualizar ahora" (sin trabajo, no se anuncia).
      progress.startPhase(PHASE_LABEL, pending.length);
      const results = await postImages.savePostImages(pending, {
        ...deps,
        onResult: (result) => progress.tick(1, { ok: Boolean(result && result.ok) }),
      });
      pending.forEach((item, index) => record(plataforma, item, results[index], stats));
    }
  } catch (err) {
    console.error(`[imagenes] (${plataforma}) falló la tanda de fotos (el ciclo sigue):`, err && err.message);
  }
  for (const key of Object.keys(cycleStats)) cycleStats[key] += stats[key];
  return stats;
}

/** Devuelve la cuenta del ciclo y la deja en cero para el siguiente. */
function takeCycleSummary() {
  const stats = cycleStats;
  cycleStats = emptyStats();
  return stats;
}

/**
 * La línea de resumen del ciclo, o null si ninguna respuesta trajo un link
 * de imagen (no hay nada que contar).
 */
function formatCycleSummary(stats) {
  if (!stats || stats.candidates === 0) return null;
  const parts = [`${stats.saved} guardada(s)`, `${stats.alreadySaved} ya estaban`];
  if (stats.expired > 0) parts.push(`${stats.expired} con el link vencido`);
  if (stats.failed > 0) parts.push(`${stats.failed} con error`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} sin intentar (se cortó la tanda por fallos de red)`);
  return `[imagenes] fotos del ciclo: ${parts.join(', ')}.`;
}

module.exports = { syncPostImages, takeCycleSummary, formatCycleSummary, PHASE_LABEL };
