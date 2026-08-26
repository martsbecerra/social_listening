// ==========================================================================
// viralJumpDetector.js
// --------------------------------------------------------------------------
// Detecta y loguea cuando likes/comentarios de un posteo pegaron un salto
// fuerte entre dos mediciones. Módulo chico y sin dependencias a propósito:
// lo usan tanto src/metricsRefresh.js (el refresco dedicado) como
// src/monitor.js (el refresco "gratis" que aprovecha el scraping que ya hace
// runMonitoringCycle contra posteos ya conocidos) — si viviera adentro de
// metricsRefresh.js, monitor.js no podría importarlo sin crear una
// dependencia circular (metricsRefresh ya requiere monitor.js para
// scrapeAccount).
// ==========================================================================

const VIRAL_JUMP_FACTOR = Number(process.env.VIRAL_JUMP_FACTOR) || 3;
// Umbral mínimo absoluto para el caso "desde cero": sin esto, un 0 -> 3
// (matemáticamente "infinito") ensuciaría el log con saltos irrelevantes.
const VIRAL_JUMP_FROM_ZERO_MIN = Number(process.env.VIRAL_JUMP_FROM_ZERO_MIN) || 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compara el valor anterior de una métrica (likes o comentarios) contra el
 * nuevo y, si hubo un salto fuerte, lo loguea. Dos formas de salto:
 *   - Desde cero: previous === 0 y current >= VIRAL_JUMP_FROM_ZERO_MIN. No
 *     se puede expresar como "Nx" (división por cero), pero es el caso que
 *     más importa detectar — un posteo con 0 comentarios en la detección
 *     que hoy tiene cientos.
 *   - Por ratio: previous > 0 y current/previous >= VIRAL_JUMP_FACTOR.
 * Si previous es null (nunca se supo, ej. el centinela -1 de Apify) no se
 * loguea nada: no hay una base real contra la cual medir el salto.
 *
 * @param {{ account: string, id: string, postedAt: string|null,
 *   metric: string, previous: number|null, current: number|null }} params
 * @returns {boolean} true si se logueó un salto.
 */
function checkAndLogJump({ account, id, postedAt, metric, previous, current }) {
  if (current == null) return false;

  let detail = null;
  if (previous === 0) {
    if (current >= VIRAL_JUMP_FROM_ZERO_MIN) detail = `${previous} -> ${current} (desde cero)`;
  } else if (previous != null && previous > 0) {
    const ratio = current / previous;
    if (ratio >= VIRAL_JUMP_FACTOR) detail = `${previous} -> ${current} (${ratio.toFixed(1)}x)`;
  }
  if (!detail) return false;

  const ageDays = postedAt ? Math.round((Date.now() - new Date(postedAt).getTime()) / DAY_MS) : null;
  const ageText = ageDays != null ? ` — posteo de hace ${ageDays} día${ageDays === 1 ? '' : 's'}` : '';
  console.log(`[metricsRefresh] SALTO: @${account} ${id} ${metric} ${detail}${ageText}`);
  return true;
}

module.exports = { checkAndLogJump, VIRAL_JUMP_FACTOR, VIRAL_JUMP_FROM_ZERO_MIN };
