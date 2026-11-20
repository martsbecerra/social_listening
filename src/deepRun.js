// ==========================================================================
// deepRun.js
// --------------------------------------------------------------------------
// Corridas hondas (noviembre 2026, openspec/changes/ventana-por-fuente). Sin
// dependencias: server.js lo valida al arrancar, como IG_ACTOR.
//
// Con la ventana de 1 día la búsqueda del actor devuelve una fracción chica
// de lo publicado (sonda del 16/11/2026: entre el 4 y el 19 %); con 7 días,
// cerca del 70 % por pasada. Una búsqueda de 7 días cuesta bastante más (se
// paga cada resultado, también los ya vistos), así que no todas las corridas
// son hondas: se elige en qué horas del cron.
//
//   MONITOR_DEEP_HOURS    horas del cron (0 a 23, separadas por coma, hora
//                         local del server como MONITOR_CRON) en las que la
//                         corrida es honda: "8,16". Vacía o ausente: no hay
//                         corridas hondas y todo queda como siempre.
//   MONITOR_DEEP_WINDOW   la ventana mínima de las búsquedas en una corrida
//                         honda, en el formato de MONITOR_LOOKBACK ("7 days").
//                         Default 7 días. Sin MONITOR_DEEP_HOURS no hace nada.
//
// Reglas (decisión del dueño, 20/11/2026):
//   - en una corrida honda, la ventana mínima de TODAS las búsquedas es la
//     honda en vez de MONITOR_MIN_WINDOW;
//   - es honda la corrida programada que cae en una de esas horas;
//   - si pasaron más de 24 h desde la última corrida honda terminada (o no
//     hubo ninguna), la próxima corrida PROGRAMADA es honda aunque no sea su
//     hora: una máquina apagada a las 8 y a las 16 no deja el día sin honda;
//   - "Actualizar ahora" es siempre corta.
// Cambiar cuántas hondas hay por día es cambiar MONITOR_DEEP_HOURS.
// ==========================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEEP_WINDOW = '7 days';
// Pasado esto sin una honda terminada, la próxima programada es honda.
const OVERDUE_MS = DAY_MS;

function invalid(name, raw, hint) {
  // El nombre de la variable va en el message (al log); el userMessage, sin él.
  const e = new Error(`${name}="${raw}" no es válido: ${hint}.`);
  e.userMessage = 'Falta configuración del servidor.';
  return e;
}

/** "7 days", "36 hours", "1 week"... a milisegundos; null si no se entiende. */
function parseWindow(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|days?|weeks?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const unitMs = unit.startsWith('min') ? 60 * 1000 : unit.startsWith('hour') ? 60 * 60 * 1000 : unit.startsWith('week') ? 7 * DAY_MS : DAY_MS;
  return n > 0 ? n * unitMs : null;
}

/** "7 días", "1 día", "36 horas": para los textos del log. */
function describeWindow(ms) {
  const dias = ms / DAY_MS;
  if (Number.isInteger(dias)) return `${dias} ${dias === 1 ? 'día' : 'días'}`;
  const horas = Math.round((ms / (60 * 60 * 1000)) * 10) / 10;
  return `${String(horas).replace('.', ',')} ${horas === 1 ? 'hora' : 'horas'}`;
}

/** "8 y 16", "8, 12 y 16", "8". */
function listarHoras(hours) {
  const t = hours.map(String);
  if (t.length <= 1) return t.join('');
  return `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
}

/**
 * La configuración en uso. Un valor mal escrito tira (server.js aborta el
 * arranque con ese mensaje).
 * @returns {{ enabled: boolean, hours: number[], windowMs: number, windowText: string, windowSinHoras: boolean }}
 *   `windowSinHoras`: está MONITOR_DEEP_WINDOW pero no MONITOR_DEEP_HOURS (no
 *   hay corridas hondas; el arranque lo avisa).
 */
function resolveDeepConfig(env = process.env) {
  const rawHours = env.MONITOR_DEEP_HOURS;
  const rawWindow = env.MONITOR_DEEP_WINDOW;
  const hayVentana = rawWindow !== undefined && String(rawWindow).trim() !== '';

  let windowMs = parseWindow(DEFAULT_DEEP_WINDOW);
  if (hayVentana) {
    windowMs = parseWindow(rawWindow);
    if (windowMs == null) throw invalid('MONITOR_DEEP_WINDOW', rawWindow, 'tiene que ser una duración como "7 days" o "36 hours"');
  }

  let hours = [];
  if (rawHours !== undefined && String(rawHours).trim() !== '') {
    const partes = String(rawHours)
      .split(',')
      .map((p) => p.trim());
    for (const p of partes) {
      if (!/^\d{1,2}$/.test(p) || Number(p) > 23) {
        throw invalid('MONITOR_DEEP_HOURS', rawHours, 'tiene que ser una lista de horas de 0 a 23 separadas por coma, como "8,16"');
      }
    }
    hours = [...new Set(partes.map(Number))].sort((a, b) => a - b);
  }

  return {
    enabled: hours.length > 0,
    hours,
    windowMs,
    windowText: describeWindow(windowMs),
    windowSinHoras: hayVentana && hours.length === 0,
  };
}

/** Lo mismo, pero un valor mal escrito apaga las hondas (para el ciclo, que no puede tirar por esto: ya se validó al arrancar). */
function deepConfig(env = process.env) {
  try {
    return resolveDeepConfig(env);
  } catch {
    return { enabled: false, hours: [], windowMs: parseWindow(DEFAULT_DEEP_WINDOW), windowText: describeWindow(parseWindow(DEFAULT_DEEP_WINDOW)), windowSinHoras: false };
  }
}

/**
 * ¿Esta corrida es honda?
 * @param {{ trigger?: string, now?: number|Date, lastDeepFinishedAt?: string|null, config?: object }} options
 *   `now`: cuándo arranca la corrida (su hora LOCAL es la que se compara con
 *   las horas, como hace el cron). `lastDeepFinishedAt`: cuándo terminó la
 *   última corrida honda (db.getLastFinishedDeepRunAt), o null si no hubo.
 * @returns {{ honda: boolean, motivo: 'hora'|'atrasada'|null, windowMs: number|null, windowText: string|null }}
 */
function decidirHonda({ trigger = 'manual', now = Date.now(), lastDeepFinishedAt = null, config = deepConfig() } = {}) {
  const corta = { honda: false, motivo: null, windowMs: null, windowText: null };
  if (!config || !config.enabled) return corta;
  // "Actualizar ahora" es siempre corta.
  if (trigger !== 'cron') return corta;
  const cuando = now instanceof Date ? now : new Date(now);
  const honda = (motivo) => ({ honda: true, motivo, windowMs: config.windowMs, windowText: config.windowText });
  if (config.hours.includes(cuando.getHours())) return honda('hora');
  const lastMs = Date.parse(lastDeepFinishedAt || '');
  if (!Number.isFinite(lastMs) || cuando.getTime() - lastMs > OVERDUE_MS) return honda('atrasada');
  return corta;
}

/** Por qué es honda, para el log: "por la hora" / "pasaron más de 24 h desde la última honda" / "todavía no hubo ninguna honda". */
function describeMotivo(motivo, lastDeepFinishedAt = null) {
  if (motivo === 'hora') return 'por la hora';
  if (motivo === 'atrasada') return lastDeepFinishedAt ? 'pasaron más de 24 h desde la última honda' : 'todavía no hubo ninguna honda';
  return '';
}

/** Para la línea del arranque. */
function describeDeepConfig(config = deepConfig()) {
  if (!config.enabled) {
    return config.windowSinHoras
      ? 'apagadas: está la ventana pero faltan las horas (todas las corridas son cortas)'
      : 'apagadas (todas las corridas usan la ventana mínima de siempre)';
  }
  return (
    `a las ${listarHoras(config.hours)} h con ventana mínima de ${config.windowText}; las demás, cortas. ` +
    'Si pasan más de 24 h sin una honda terminada, la siguiente programada es honda; "Actualizar ahora" es siempre corta'
  );
}

/** Horas hondas que el cron no dispara nunca (para avisar al arrancar). */
function horasFueraDelCron(config, cronHours) {
  if (!config || !config.enabled || !Array.isArray(cronHours)) return [];
  return config.hours.filter((h) => !cronHours.includes(h));
}

module.exports = {
  resolveDeepConfig,
  deepConfig,
  decidirHonda,
  describeMotivo,
  describeDeepConfig,
  describeWindow,
  horasFueraDelCron,
  parseWindow,
  DEFAULT_DEEP_WINDOW,
  OVERDUE_MS,
};
