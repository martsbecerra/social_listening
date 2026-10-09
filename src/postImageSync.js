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
// Cada foto se anota en la base apenas termina. Cómo queda (image_status):
//   - ok: las dos copias guardadas;
//   - vencido: el servidor de imágenes dijo que ese link ya no sirve;
//   - error: el link o la imagen no se aceptan (no es imagen, formato o
//     tamaño no permitidos, ilegible). Con ese mismo link va a pasar lo mismo;
//   - pendiente: hay link y la foto todavía no se pudo bajar por algo
//     pasajero: no se llegó a intentar (la tanda se cortó o llegó a su tope
//     de tiempo), la red no llegó, el servidor de imágenes respondió con un
//     error suyo, o no se pudo escribir en la carpeta.
// Las pendientes se reintentan al principio del ciclo siguiente
// (retryPendingPostImages), con el link ya guardado: así una foto que no
// salió no tiene que esperar al próximo refresco de métricas del posteo, que
// en el tramo frío es a los 7 días. "vencido" y "error" no se reintentan con
// el mismo link: esperan a que un refresco traiga uno nuevo.
//
// NUNCA tira: una foto que no se pudo guardar no frena el ciclo. Con
// POST_IMAGES=0 (o sin sharp) no hace nada, ni anota nada.
//
// Logs: una línea de resumen por ciclo (la imprime el scheduler con
// takeCycleSummary) y, si una foto falla, su renglón de detalle (lo escribe
// postImages.js). Nada por cada foto que sale bien.
// ==========================================================================

const db = require('./db');
const postImages = require('./postImages');
const progress = require('./monitoringProgress');

const PHASE_LABEL = 'Guardando fotos';
const PENDING_PHASE_LABEL = 'Guardando fotos pendientes';
// Cuántas pendientes se reintentan por ciclo y por plataforma, las más
// recientes primero (son los links con más vida por delante).
const PENDING_RETRY_LIMIT = 150;

function emptyStats() {
  return { candidates: 0, alreadySaved: 0, saved: 0, expired: 0, failed: 0, pending: 0 };
}

// Lo que va del ciclo en curso (los reintentos, la detección y el refresco
// suman acá). Dos ciclos no corren a la vez: el scheduler lo garantiza.
let cycleStats = emptyStats();

/**
 * Anota en la base cómo salió una foto y lo suma a la cuenta. Nunca tira.
 * @returns {boolean} false si la base no pudo anotarlo.
 */
function record(plataforma, item, result, stats) {
  try {
    // Fotos apagadas a mitad de tanda: no hay nada que anotar.
    if (!result || (result.skipped && (result.reason === 'apagado' || result.reason === 'sin-sharp'))) return true;
    if (result.ok) {
      db.markPostImageSaved(item.id, plataforma, {
        sourceUrl: result.sourceUrl || item.url,
        width: result.width,
        height: result.height,
        savedAt: result.savedAt,
      });
      stats.saved += 1;
      return true;
    }
    if (result.skipped || result.retry) {
      // No se llegó a intentar, o falló por algo pasajero: queda el link y
      // se reintenta en el próximo ciclo.
      db.markPostImagePending(item.id, plataforma, { sourceUrl: result.sourceUrl || item.url });
      stats.pending += 1;
      return true;
    }
    const status = result.status === 'vencido' ? 'vencido' : 'error';
    db.markPostImageFailed(item.id, plataforma, { sourceUrl: result.sourceUrl || item.url, status });
    if (status === 'vencido') stats.expired += 1;
    else stats.failed += 1;
    return true;
  } catch (err) {
    stats.failed += 1;
    console.error(`[imagenes] (${plataforma}) ${item.id}: no se pudo anotar el resultado de la foto en la base:`, err && err.message);
    return false;
  }
}

/**
 * Guarda la foto de los posteos que todavía no la tienen. NUNCA tira.
 *
 * @param {string} plataforma
 * @param {{ id: string, url: string }[]} items posteos YA guardados en
 *   detected_posts, con el link de imagen que vino en la respuesta. Los que
 *   no traen link se ignoran.
 * @param {object} [deps] los de postImages.savePostImages (para los tests),
 *   más phaseLabel: el nombre de la fase en el progreso.
 * @returns {Promise<{candidates: number, alreadySaved: number, saved: number,
 *   expired: number, failed: number, pending: number}>} candidates: posteos
 *   con link; alreadySaved: ya tenían sus copias; saved / expired / failed:
 *   cómo salieron los intentos; pending: quedaron para reintentar en el
 *   próximo ciclo (sin intentar, o con un fallo pasajero).
 */
async function syncPostImages(plataforma, items, deps = {}) {
  const stats = emptyStats();
  try {
    if (!postImages.isEnabled()) return stats;
    if (!Object.prototype.hasOwnProperty.call(postImages.IMAGE_HOSTS, plataforma)) return stats;
    const { phaseLabel = PHASE_LABEL, ...batchDeps } = deps || {};

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
      if (state.savedAt && postImages.hasLocalCopy(plataforma, id, batchDeps.mediaDir)) {
        stats.alreadySaved += 1;
        // Estaba para reintentar y las copias están (volvió la carpeta): al día.
        if (state.status === 'pendiente') {
          db.markPostImageSaved(id, plataforma, { sourceUrl: state.sourceUrl, width: state.width, height: state.height, savedAt: state.savedAt });
        }
        continue;
      }
      pending.push({ plataforma, id, url });
    }

    if (pending.length > 0) {
      // Una fase más del progreso de "Actualizar ahora" (sin trabajo, no se
      // anuncia), con su contador y sin mover el porcentaje global: ver
      // src/monitoringProgress.js.
      progress.startPhase(phaseLabel, pending.length, { countsInPercent: false });
      // Cada foto se anota en la base apenas termina, no al final de la
      // tanda: si el proceso se corta en el medio, lo ya bajado queda
      // marcado y no se vuelve a bajar. Si la base no pudo anotar, se avisa
      // con false: para la tanda es un fallo más, y cinco seguidos la cortan.
      const recorded = new Array(pending.length).fill(false);
      const results = await postImages.savePostImages(pending, {
        ...batchDeps,
        onResult: (result, index) => {
          recorded[index] = true;
          const noted = record(plataforma, pending[index], result, stats);
          // Bien: guardada y anotada. Las que quedan pendientes no cuentan
          // ni como bien ni como error en el cierre de la fase.
          const left = noted && result && !result.ok && Boolean(result.skipped || result.retry);
          progress.tick(1, { ok: left ? null : Boolean(result && result.ok && noted) });
          return noted;
        },
      });
      // Por las dudas: un resultado que no pasó por el aviso se anota acá.
      results.forEach((result, index) => {
        if (!recorded[index]) record(plataforma, pending[index], result, stats);
      });
    }
  } catch (err) {
    console.error(`[imagenes] (${plataforma}) falló la tanda de fotos (el ciclo sigue):`, err && err.message);
  }
  for (const key of Object.keys(cycleStats)) cycleStats[key] += stats[key];
  return stats;
}

/**
 * Reintenta las fotos que quedaron pendientes en ciclos anteriores, con el
 * link ya guardado en la base: no le pide nada a Apify. NUNCA tira.
 *
 * Va al principio del ciclo (src/scheduler.js), antes de la detección: lo
 * que falle en ESTE ciclo se reintenta recién en el siguiente.
 *
 * En esta pasada un link vencido no cuenta para el corte de la tanda: los
 * links guardados vencen a los pocos días y acá es la respuesta esperable,
 * no una señal de que algo anda mal. El posteo queda "vencido" y espera a
 * que un refresco le traiga un link nuevo.
 *
 * @param {{ plataformas?: string[]|null }} [options] subconjunto de
 *   plataformas del ciclo; sin lista, todas las que tienen fotos.
 * @param {object} [deps] para los tests (los de syncPostImages).
 * @returns {Promise<object>} la misma cuenta que syncPostImages, sumada.
 */
async function retryPendingPostImages({ plataformas } = {}, deps = {}) {
  const total = emptyStats();
  try {
    if (!postImages.isEnabled()) return total;
    for (const plataforma of Object.keys(postImages.IMAGE_HOSTS)) {
      if (Array.isArray(plataformas) && !plataformas.includes(plataforma)) continue;
      const items = db.listPostsWithPendingImage(plataforma, PENDING_RETRY_LIMIT);
      if (items.length === 0) continue;
      const stats = await syncPostImages(
        plataforma,
        items.map((item) => ({ id: item.id, url: item.url })),
        { ...deps, phaseLabel: PENDING_PHASE_LABEL, cutOnExpired: false }
      );
      for (const key of Object.keys(total)) total[key] += stats[key];
    }
  } catch (err) {
    console.error('[imagenes] falló el reintento de las fotos pendientes (el ciclo sigue):', err && err.message);
  }
  return total;
}

/** Devuelve la cuenta del ciclo y la deja en cero para el siguiente. */
function takeCycleSummary() {
  const stats = cycleStats;
  cycleStats = emptyStats();
  return stats;
}

/**
 * La línea de resumen del ciclo, o null si no hubo ningún posteo con link
 * de imagen (no hay nada que contar).
 */
function formatCycleSummary(stats) {
  if (!stats || stats.candidates === 0) return null;
  const parts = [`${stats.saved} guardada(s)`, `${stats.alreadySaved} ya estaban`];
  if (stats.expired > 0) parts.push(`${stats.expired} con el link vencido`);
  if (stats.failed > 0) parts.push(`${stats.failed} con error`);
  if (stats.pending > 0) parts.push(`${stats.pending} pendiente(s) para el próximo ciclo`);
  return `[imagenes] fotos del ciclo: ${parts.join(', ')}.`;
}

module.exports = {
  syncPostImages,
  retryPendingPostImages,
  takeCycleSummary,
  formatCycleSummary,
  PHASE_LABEL,
  PENDING_PHASE_LABEL,
  PENDING_RETRY_LIMIT,
};
