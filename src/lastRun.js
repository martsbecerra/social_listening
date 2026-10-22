// ==========================================================================
// lastRun.js
// --------------------------------------------------------------------------
// Resumen de la última corrida terminada de una plataforma, para el
// Pipeline del Monitoreo (diseño v4): cuánto trajeron las búsquedas, cuántos
// eran nuevos, cuántos quedaron guardados, cuántos de esos se despegaron de
// lo normal de su cuenta, cuánto duró y cuánto costó. Sale de
// monitoring_runs y apify_calls (src/db.js); el destacado, de la misma regla
// que el listado (accountStats.classifyPostAgainstBenchmark, `top.level`).
// ==========================================================================

const db = require('./db');
const accountStats = require('./accountStats');

/**
 * @param {string} plataforma
 * @param {{ hasBenchmark?: boolean }} [opts] hasBenchmark: el adapter de esa
 *   red calcula alcance (sin eso, `highlighted` va null: no hay con qué).
 * @returns {null | { finishedAt: string, durationSec: number|null, fetched: number|null,
 *   newCandidates: number|null, saved: number, highlighted: number|null, usd: number }}
 *   null si esa plataforma nunca terminó una corrida. `fetched` null: la
 *   corrida no hizo consultas de detección en esa red; `newCandidates` null:
 *   corrida anterior a la columna o caída antes de contar.
 */
function buildLastRun(plataforma, { hasBenchmark = false } = {}) {
  const run = db.getLastFinishedRun(plataforma);
  if (!run) return null;

  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  const durationSec = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? Math.round((finished - started) / 1000)
    : null;

  let highlighted = null;
  if (hasBenchmark) {
    const posts = db.listPostsDetectedBetween(plataforma, run.startedAt, run.finishedAt);
    const statsMap = posts.length > 0 ? accountStats.buildAccountStatsMap() : null;
    highlighted = posts.filter((post) => {
      const benchmark = accountStats.classifyPostAgainstBenchmark({
        account: post.account,
        plataforma,
        postType: post.post_type,
        likes: post.likes,
        comments: post.comments,
        statsMap,
      });
      return Boolean(benchmark && benchmark.top && benchmark.top.level === 'alto');
    }).length;
  }

  return {
    finishedAt: run.finishedAt,
    durationSec,
    fetched: run.fetched,
    newCandidates: run.newCandidates,
    saved: Number(run.newPosts) || 0,
    highlighted,
    usd: Number(run.usd) || 0,
  };
}

module.exports = { buildLastRun };
