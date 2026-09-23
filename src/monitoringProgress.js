// ==========================================================================
// monitoringProgress.js
// --------------------------------------------------------------------------
// Progreso REAL del ciclo de monitoreo en curso, en memoria (un solo ciclo a
// la vez, igual que cycleInProgress en scheduler.js). No persiste ni
// sobrevive a un reinicio del proceso: es solo para que "Actualizar ahora"
// muestre una fase y un contador reales mientras espera la respuesta.
//
// Modelo: cada fase declara cuánto trabajo tiene al arrancar (startPhase) y
// el total global conocido crece con ella; el porcentaje es el trabajo
// completado (tick) sobre ese total, recalculado en cada arranque de fase y
// en cada tick — tal como lo pidió el dueño: "un porcentaje global calculado
// como llamadas completadas sobre el total conocido, que se recalcula cuando
// una fase arranca y define cuánto trabajo tiene". No es estrictamente
// monótono (una fase nueva puede bajarlo un toque si agrega trabajo antes de
// completar nada), pero eso es real, no un defecto: es exactamente cuánto se
// sabe en ese instante.
//
// Fases con total 0 no se anuncian (getProgress no las muestra): así una
// plataforma sin esa capability (X sin benchmark/refresco, o un ciclo sin
// búsquedas por palabra clave) simplemente no genera esa fase, sin que haga
// falta ningún caso especial por plataforma.
//
// Cambio G (diagnóstico del cuelgue): cada fase loguea cuándo arranca y
// cuándo termina (duración, cuántos ticks salieron bien y cuántos mal), y
// lastActivityAt (todo tick la actualiza) es lo que src/scheduler.js usa
// para el heartbeat — "hace cuánto que ninguna llamada termina".
// ==========================================================================

let current = null; // { phase, totalDone, totalWork, percent }
let lastActivityAt = null;

function logPhaseEnd(phase) {
  const durationMs = Date.now() - phase.startedAt;
  console.log(`[fase] termina ${phase.label} (${durationMs}ms, ${phase.ok} ok, ${phase.error} error, ${phase.done}/${phase.total})`);
}

function startCycle() {
  current = { phase: null, totalDone: 0, totalWork: 0, percent: 0 };
  lastActivityAt = Date.now();
}

function endCycle() {
  if (current && current.phase) logPhaseEnd(current.phase);
  current = null;
}

function recompute() {
  current.percent = current.totalWork > 0 ? Math.min(100, Math.round((current.totalDone / current.totalWork) * 100)) : 0;
}

/** Arranca (o reemplaza) la fase visible. Con total <= 0 no hace nada: esa fase no existió para este ciclo. */
function startPhase(label, total) {
  if (!current || !Number.isFinite(total) || total <= 0) return;
  if (current.phase) logPhaseEnd(current.phase);
  current.phase = { label, done: 0, total: Math.floor(total), ok: 0, error: 0, startedAt: Date.now() };
  current.totalWork += current.phase.total;
  console.log(`[fase] arranca ${label} (total ${current.phase.total})`);
  recompute();
}

/** Avanza la fase visible en n (default 1); {ok:false} cuenta ese paso como error. Sin fase activa, no hace nada (llamada de más, inofensiva). */
function tick(n = 1, { ok = true } = {}) {
  if (!current || !current.phase) return;
  const step = Math.min(n, current.phase.total - current.phase.done);
  if (step <= 0) return;
  current.phase.done += step;
  current.totalDone += step;
  if (ok) current.phase.ok += step;
  else current.phase.error += step;
  lastActivityAt = Date.now();
  recompute();
}

/** @returns {{phase: string, done: number, total: number, percent: number}|null} null si no hay ciclo corriendo o todavía no arrancó ninguna fase. */
function getProgress() {
  if (!current || !current.phase) return null;
  return { phase: current.phase.label, done: current.phase.done, total: current.phase.total, percent: current.percent };
}

/** Hace cuánto (ms) que no se registra ningún tick — para el heartbeat de src/scheduler.js. null si no hay ciclo corriendo. */
function getLastActivityAt() {
  return lastActivityAt;
}

module.exports = { startCycle, endCycle, startPhase, tick, getProgress, getLastActivityAt };
