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
const { estadoCorrida, resumenFallidas } = require('./runStatus');

// De menos a más grave, para quedarse con el peor estado entre varias redes.
const ORDEN_ESTADO = ['ok', 'incompleta', 'cortada'];

/**
 * @param {string} plataforma
 * @param {{ hasBenchmark?: boolean }} [opts] hasBenchmark: el adapter de esa
 *   red calcula alcance (sin eso, `highlighted` va null: no hay con qué).
 * @returns {null | { finishedAt: string, durationSec: number|null, fetched: number|null,
 *   newCandidates: number|null, saved: number, highlighted: number|null, usd: number,
 *   estado: string, fallidas: object|null }}
 *   null si esa plataforma nunca terminó una corrida. `fetched` null: la
 *   corrida no hizo consultas de detección en esa red; `newCandidates` null:
 *   corrida anterior a la columna o caída antes de contar. `estado`: ok |
 *   incompleta | cortada (src/runStatus.js); `fallidas`: qué falló, en
 *   textos para una persona (runStatus.resumenFallidas), o null.
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

  // Lo que esta corrida levantó de búsquedas que habían quedado en Apify:
  // esas publicaciones pasaron por ESTA corrida (se clasificaron y guardaron
  // acá), así que cuentan entre las traídas, y la pantalla lo aclara.
  const levantadas = db.listRunSourcesRecoveredIn({ runId: run.id, plataforma });
  const recuperadas = levantadas.reduce((sum, f) => sum + (Number(f.items) || 0), 0);
  const estado = estadoCorrida(run, run.fuentes);
  return {
    finishedAt: run.finishedAt,
    durationSec,
    fetched: run.fetched == null && levantadas.length === 0 ? null : (Number(run.fetched) || 0) + recuperadas,
    newCandidates: run.newCandidates,
    saved: Number(run.newPosts) || 0,
    highlighted,
    usd: Number(run.usd) || 0,
    estado,
    fallidas: resumenFallidas(run.fuentes, { estado }),
    recuperadas: levantadas.length > 0 ? recuperadasTexto(recuperadas, levantadas) : null,
  };
}

/** "12:00": la hora de Argentina (UTC-3 fija). */
function horaArgentina(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(11, 16) : '—';
}

/** "Incluye 500 publicaciones recuperadas de la corrida de las 12:00." (o "de corridas anteriores" si son de varias). */
function recuperadasTexto(total, filas) {
  const horas = [...new Set(filas.map((f) => horaArgentina(f.startedAt)))];
  const miles = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const de = horas.length === 1 ? `de la corrida de las ${horas[0]}` : 'de corridas anteriores';
  return `Incluye ${miles} ${total === 1 ? 'publicación recuperada' : 'publicaciones recuperadas'} ${de}.`;
}

/**
 * Cómo salió la última corrida terminada entre las redes del ciclo
 * automático: el estado de la escucha del inicio, que no es de ninguna red
 * (una corrida manual de una red en pausa no lo cambia). Si esa corrida fue
 * de varias redes, vale el peor estado.
 * @param {string[]} redes las redes del cron
 * @returns {null | { finishedAt: string, estado: string, fallidas: object|null }}
 */
function estadoUltimaCorrida(redes) {
  let ultima = null;
  for (const red of redes || []) {
    const run = db.getLastFinishedRun(red);
    if (!run) continue;
    const estado = estadoCorrida(run, run.fuentes);
    const propia = { finishedAt: run.finishedAt, id: run.id, estado, fallidas: resumenFallidas(run.fuentes, { estado }) };
    if (!ultima || propia.finishedAt > ultima.finishedAt) ultima = propia;
    else if (propia.id === ultima.id && ORDEN_ESTADO.indexOf(propia.estado) > ORDEN_ESTADO.indexOf(ultima.estado)) ultima = propia;
  }
  return ultima ? { finishedAt: ultima.finishedAt, estado: ultima.estado, fallidas: ultima.fallidas } : null;
}

module.exports = { buildLastRun, estadoUltimaCorrida };
