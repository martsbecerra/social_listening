// ==========================================================================
// sessionConfig.js
// --------------------------------------------------------------------------
// Los dos topes de la sesión, del .env (sin dependencias: server.js lo valida
// al arrancar, antes de cargar la base, como IG_ACTOR y REFRESH_MODE):
//   SESSION_IDLE_MIN   minutos sin actividad que corta la sesión (30)
//   SESSION_MAX_HOURS  horas desde el login, aunque haya actividad (8)
// Enteros positivos, sin separador de miles. Un valor mal escrito tira con
// userMessage y el arranque aborta (el mensaje va solo a la consola, por eso
// puede nombrar la variable).
// ==========================================================================

const DEFAULT_IDLE_MIN = 30;
const DEFAULT_MAX_HOURS = 8;

function leerEnteroPositivo(env, nombre, porDefecto) {
  const raw = env[nombre];
  if (raw == null || String(raw).trim() === '') return porDefecto;
  const texto = String(raw).trim();
  if (!/^\d+$/.test(texto) || Number(texto) <= 0) {
    const e = new Error(`${nombre}="${raw}" no es válido: tiene que ser un entero positivo, sin puntos ni comas (por defecto ${porDefecto}).`);
    e.userMessage = e.message;
    throw e;
  }
  return Number(texto);
}

function resolveSessionConfig(env = process.env) {
  const idleMin = leerEnteroPositivo(env, 'SESSION_IDLE_MIN', DEFAULT_IDLE_MIN);
  const maxHours = leerEnteroPositivo(env, 'SESSION_MAX_HOURS', DEFAULT_MAX_HOURS);
  return { idleMin, maxHours, idleMs: idleMin * 60 * 1000, maxMs: maxHours * 60 * 60 * 1000 };
}

function describeSessionConfig(cfg = resolveSessionConfig()) {
  return `se corta con ${cfg.idleMin} min sin actividad o a las ${cfg.maxHours} h del login`;
}

module.exports = {
  resolveSessionConfig,
  describeSessionConfig,
  leerEnteroPositivo,
  DEFAULT_IDLE_MIN,
  DEFAULT_MAX_HOURS,
};
