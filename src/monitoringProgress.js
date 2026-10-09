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
// Las fotos son la excepción (startPhase con countsInPercent: false): su
// fase se anuncia con su nombre y su contador, pero su trabajo no entra en
// el porcentaje global. Bajar fotos es un agregado que no llama a Apify y
// que arranca cuando el resto ya terminó: sumarlo hacía volver la barra de
// 100 % a cerca de la mitad justo al final del ciclo. Mientras dura esa
// fase, el porcentaje queda donde lo dejó la anterior.
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
//
// Líneas para la pantalla (getView): además de la fase y el contador, el
// ciclo arma una lista corta, escrita para una persona y no para el log:
//   - una línea por fuente de la detección (startItem / finishItem): en
//     curso mientras se consulta ("«macri» · buscando…") y, al terminar,
//     cómo salió ("«macri» · 50 encontrados, 6 nuevos" o "«PDLC» · falló");
//   - una línea de resumen por cada fase que termina ("Relevancia · 4
//     relevantes, 7 descartados"): la deja quien corre la fase con
//     setPhaseSummary; si no, sale una genérica con el contador.
// getView devuelve las últimas VIEW_MAX_LINES y, terminado el ciclo, las
// deja disponibles (finished: true) hasta que arranque el siguiente: la
// última fase cierra su resumen recién en endCycle, cuando ya no hay nada
// "en curso" que consultar. getProgress no cambia: sigue siendo el estado
// del ciclo en curso, null sin ciclo.
// ==========================================================================

// Cuántas líneas ve la pantalla, y cuántas de ellas pueden ser de algo en
// curso: las búsquedas salen todas juntas, y con ocho ruedas girando no
// quedaría lugar para lo que ya terminó.
const VIEW_MAX_LINES = 6;
const VIEW_MAX_RUNNING = 3;

let current = null; // { phase, totalDone, totalWork, percent, lines, ended }
let lastActivityAt = null;
// Las líneas del último ciclo terminado (ver getView). null con uno en curso.
let lastFinished = null;

function logPhaseEnd(phase) {
  const durationMs = Date.now() - phase.startedAt;
  console.log(`[fase] termina ${phase.label} (${durationMs}ms, ${phase.ok} ok, ${phase.error} error, ${phase.done}/${phase.total})`);
}

// Cierra la fase visible: el log de siempre y su línea de resumen.
function closePhase(phase) {
  logPhaseEnd(phase);
  if (phase.summary === false) return;
  const summary = phase.summary || {
    label: phase.label,
    detail: `${phase.done} de ${phase.total}${phase.error > 0 ? `, ${phase.error} con error` : ''}`,
    ok: !(phase.error > 0 && phase.ok === 0),
  };
  current.ended += 1;
  current.lines.push({ key: null, state: summary.ok === false ? 'err' : 'ok', label: summary.label, detail: summary.detail, ended: current.ended });
}

function startCycle() {
  current = { phase: null, totalDone: 0, totalWork: 0, percent: 0, lines: [], ended: 0 };
  lastFinished = null;
  lastActivityAt = Date.now();
}

function endCycle() {
  if (!current) return;
  if (current.phase) closePhase(current.phase);
  // Lo que quedó "en curso" no terminó nunca: no va al cierre.
  lastFinished = { lines: current.lines.filter((line) => line.state !== 'run') };
  current = null;
}

function recompute() {
  current.percent = current.totalWork > 0 ? Math.min(100, Math.round((current.totalDone / current.totalWork) * 100)) : 0;
}

/**
 * Arranca (o reemplaza) la fase visible. Con total <= 0 no hace nada: esa
 * fase no existió para este ciclo. Con countsInPercent: false la fase se
 * muestra con su contador pero no mueve el porcentaje global (las fotos).
 *
 * Para la pantalla (getView): `suffix` es la palabra que sigue al contador
 * ("5 de 8 listas"), y `summary: false` hace que la fase no deje línea de
 * resumen al terminar (la detección: sus líneas son las de cada fuente).
 */
function startPhase(label, total, { countsInPercent = true, suffix = '', summary = null } = {}) {
  if (!current || !Number.isFinite(total) || total <= 0) return;
  if (current.phase) closePhase(current.phase);
  current.phase = {
    label,
    done: 0,
    total: Math.floor(total),
    ok: 0,
    error: 0,
    startedAt: Date.now(),
    countsInPercent: countsInPercent !== false,
    suffix: suffix || '',
    summary: summary === false ? false : null,
  };
  if (current.phase.countsInPercent) current.totalWork += current.phase.total;
  console.log(`[fase] arranca ${label} (total ${current.phase.total})`);
  recompute();
}

/**
 * Avanza la fase visible en n (default 1); {ok:false} cuenta ese paso como
 * error y {ok:null} no lo cuenta ni como bien ni como error (un paso que
 * queda para después). Sin fase activa, no hace nada (llamada de más,
 * inofensiva).
 */
function tick(n = 1, { ok = true } = {}) {
  if (!current || !current.phase) return;
  const step = Math.min(n, current.phase.total - current.phase.done);
  if (step <= 0) return;
  current.phase.done += step;
  if (current.phase.countsInPercent) current.totalDone += step;
  if (ok === null) {
    // ni bien ni error
  } else if (ok) current.phase.ok += step;
  else current.phase.error += step;
  lastActivityAt = Date.now();
  recompute();
}

/**
 * Una fuente de la detección empieza a consultarse: deja su línea "en
 * curso". `key` la identifica para cerrarla después; `label` y `detail` son
 * el texto que se ve ("«macri»", "buscando…"). Sin ciclo, no hace nada.
 */
function startItem(key, label, detail = '') {
  if (!current) return;
  current.lines.push({ key, state: 'run', label, detail, ended: 0 });
}

/** La fuente terminó: su línea pasa a bien o a falló, con el texto final. */
function finishItem(key, { ok = true, detail = '' } = {}) {
  if (!current) return;
  const line = current.lines.find((l) => l.key === key && l.state === 'run');
  if (!line) return;
  current.ended += 1;
  Object.assign(line, { state: ok ? 'ok' : 'err', detail, ended: current.ended });
}

/**
 * Resumen que deja la fase visible cuando termine ("Métricas · 148
 * actualizadas, 2 sin respuesta"). Lo llama quien corre la fase, apenas
 * termina su trabajo y antes de que arranque la siguiente. `phaseLabel` es
 * el nombre con el que la arrancó: si la fase visible es otra (la suya no
 * llegó a anunciarse, por no tener trabajo), no hace nada.
 */
function setPhaseSummary(phaseLabel, { label, detail, ok = true } = {}) {
  if (!current || !current.phase || current.phase.label !== phaseLabel || current.phase.summary === false) return;
  current.phase.summary = { label: label || phaseLabel, detail: detail || '', ok: ok !== false };
}

/** @returns {{phase: string, done: number, total: number, percent: number}|null} null si no hay ciclo corriendo o todavía no arrancó ninguna fase. */
function getProgress() {
  if (!current || !current.phase) return null;
  return { phase: current.phase.label, done: current.phase.done, total: current.phase.total, percent: current.percent };
}

// Las líneas que ve la pantalla: primero lo que terminó, en el orden en que
// terminó; abajo, lo que sigue en curso (como mucho VIEW_MAX_RUNNING líneas:
// las primeras y "y N más"). El lugar que sobra es para lo último terminado.
function viewLines(lines) {
  const finished = lines.filter((line) => line.state !== 'run').sort((a, b) => a.ended - b.ended);
  let running = lines.filter((line) => line.state === 'run');
  if (running.length > VIEW_MAX_RUNNING) {
    const shown = running.slice(0, VIEW_MAX_RUNNING - 1);
    running = [...shown, { state: 'run', label: `y ${running.length - shown.length} más`, detail: running[0].detail }];
  }
  return [...finished.slice(-(VIEW_MAX_LINES - running.length)), ...running].map(({ state, label, detail }) => ({ state, label, detail }));
}

/**
 * Lo que dibuja la pantalla mientras espera "Actualizar ahora"
 * (GET /api/monitoring/progress):
 *   - con un ciclo en curso: la fase, su contador (y `suffix`, la palabra
 *     que lo sigue), el porcentaje y las últimas líneas;
 *   - terminado el ciclo y hasta que arranque otro: { finished: true, lines }
 *     con el cierre completo;
 *   - null si nunca corrió un ciclo o el que corre todavía no arrancó
 *     ninguna fase.
 */
function getView() {
  if (!current) return lastFinished ? { finished: true, lines: viewLines(lastFinished.lines) } : null;
  if (!current.phase) return null;
  const { label, done, total, suffix } = current.phase;
  return { phase: label, done, total, suffix, percent: current.percent, lines: viewLines(current.lines) };
}

/** Hace cuánto (ms) que no se registra ningún tick — para el heartbeat de src/scheduler.js. null si no hay ciclo corriendo. */
function getLastActivityAt() {
  return lastActivityAt;
}

module.exports = {
  VIEW_MAX_LINES,
  VIEW_MAX_RUNNING,
  startCycle,
  endCycle,
  startPhase,
  tick,
  startItem,
  finishItem,
  setPhaseSummary,
  getProgress,
  getView,
  getLastActivityAt,
};
