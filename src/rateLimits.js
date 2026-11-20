// ==========================================================================
// rateLimits.js
// --------------------------------------------------------------------------
// Límite de pedidos (noviembre 2026, rama rate-limit-y-salud; OWASP ASVS
// V2.4). express-rate-limit con su almacén en memoria: la app es un solo
// proceso, y un reinicio vuelve los contadores a cero.
//
// La clave es el correo de la sesión (req.auth, lo pone el gate) y, sin
// sesión, la IP: todo el equipo sale por la misma IP de la oficina, así que
// con sesión nunca se cuenta por IP. Detrás de Railway, req.ip es la del
// cliente por `trust proxy` 1 (httpSecurity.trustProxySetting).
//
//   límite      qué cuenta                                  clave   default
//   general     todo /api, salvo sondeo, fotos y resumen     correo  600 / 15 min
//   sondeo      GET status y progress (ciclo y análisis)     correo  4000 / 15 min
//   imagenes    GET de las dos rutas de fotos                correo  2000 / 15 min
//   resumen     GET /api/public/resumen                      IP      200 / 15 min
//   gasto       las rutas de RUTAS_GASTO (también general)   correo  20 / hora
//   rechazados  solo las respuestas 401 y 403 de /api, ANTES IP      300 / 15 min
//               del gate; con una sesión válida no frena
//
// Los números salen de RATE_LIMIT_* del .env (server.js los valida al
// arrancar); las ventanas son fijas. Los de la medición del 20/11/2026 (una
// pestaña en 15 minutos): general 34 como mucho (el inicio); sondeo 559 con
// "Actualizar ahora" en curso (cada 1,5 s) y 819 con un análisis en curso
// (cada 1 s); fotos 273 con el feed de 30 días; el login pide el resumen una
// vez por carga. Ver "Límite de pedidos" en el README.
//
// Sondeo, fotos, resumen y gasto se registran con app.get / app.post sobre
// las MISMAS rutas que sus handlers (registrarLimites): Express las compara
// igual (sin mayúsculas, con o sin barra final), así que /API/... no los
// saltea. Toda ruta nueva que gaste va en RUTAS_GASTO (test/limitePedidos
// .test.js lo controla contra el código).
//
// El límite del login (src/auth/rateLimit.js, magic link) es aparte y no
// cambió. /health no tiene límite (server.js lo registra antes de todo).
// ==========================================================================

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;

const DEMASIADOS_BODY = Object.freeze({ error: 'Demasiados pedidos. Esperá unos minutos.' });

const LIMITES = Object.freeze({
  general: { variable: 'RATE_LIMIT_API_MAX', porDefecto: 600, ventanaMs: 15 * MINUTO },
  sondeo: { variable: 'RATE_LIMIT_SONDEO_MAX', porDefecto: 4000, ventanaMs: 15 * MINUTO },
  imagenes: { variable: 'RATE_LIMIT_IMAGENES_MAX', porDefecto: 2000, ventanaMs: 15 * MINUTO },
  resumen: { variable: 'RATE_LIMIT_RESUMEN_MAX', porDefecto: 200, ventanaMs: 15 * MINUTO },
  gasto: { variable: 'RATE_LIMIT_GASTO_MAX', porDefecto: 20, ventanaMs: HORA },
  rechazados: { variable: 'RATE_LIMIT_RECHAZOS_MAX', porDefecto: 300, ventanaMs: 15 * MINUTO },
});

// Las rutas, escritas igual que sus handlers.
const RUTAS_SONDEO = Object.freeze(['/api/monitoring/status', '/api/monitoring/progress', '/api/analyze/progress']);
const RUTAS_IMAGENES = Object.freeze(['/api/monitoring/posts/:id/image', '/api/analisis/:id/image']);
const RUTA_RESUMEN = '/api/public/resumen';
// Todas POST: lo que llama a Apify o al modelo a pedido de una persona.
const RUTAS_GASTO = Object.freeze([
  '/api/monitoring/run-now',
  '/api/monitoring/backfill-classification',
  '/api/x/analyze',
  '/api/analyze',
  '/api/analyze/:id/confirmar',
]);

/**
 * Los números del .env, con sus defaults. Un valor que no sea un entero
 * mayor que 0 (sin separador de miles: "2.000" se leería como 2) tira con
 * userMessage: server.js aborta el arranque.
 * @returns {{ general: number, sondeo: number, imagenes: number, resumen: number, gasto: number, rechazados: number }}
 */
function resolveRateLimitConfig(env = process.env) {
  const config = {};
  const errores = [];
  for (const [nombre, def] of Object.entries(LIMITES)) {
    const crudo = env[def.variable];
    if (crudo === undefined || String(crudo).trim() === '') {
      config[nombre] = def.porDefecto;
      continue;
    }
    const texto = String(crudo).trim();
    const n = Number(texto);
    if (!/^\d+$/.test(texto) || !Number.isSafeInteger(n) || n < 1) {
      errores.push(`${def.variable}="${crudo}" no es válido: tiene que ser un entero mayor que 0, sin separador de miles (por ejemplo ${def.porDefecto}).`);
      continue;
    }
    config[nombre] = n;
  }
  if (errores.length > 0) {
    const err = new Error(errores.join(' '));
    err.userMessage = err.message;
    throw err;
  }
  return config;
}

/** La línea del arranque. */
function describeRateLimitConfig(c) {
  return (
    `general ${c.general}, sondeo ${c.sondeo} y fotos ${c.imagenes} cada 15 min por correo · ` +
    `gasto ${c.gasto} por hora por correo · resumen público ${c.resumen} y rechazados (401/403) ${c.rechazados} cada 15 min por IP`
  );
}

// El correo de la sesión o, sin sesión, la IP (con ipKeyGenerator: una
// dirección IPv6 cuenta por su /56, si no se saltea el límite cambiando de
// dirección dentro de la misma red).
function claveCorreoOIp(req) {
  const email = req.auth && req.auth.email;
  if (email) return `correo:${String(email).trim().toLowerCase()}`;
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}

function describirClave(req, porIp) {
  if (!porIp && req.auth && req.auth.email) return `correo ${String(req.auth.email).trim().toLowerCase()}`;
  return `IP ${req.ip || 'desconocida'}`;
}

// La respuesta de un límite superado: 429 con el texto de siempre y
// Retry-After (los segundos que faltan para que la ventana vuelva a cero).
// Una línea de log por clave y ventana: la del primer pedido de más.
function responder429(nombre, ventanaMs, porIp) {
  return (req, res) => {
    const info = req.rateLimit;
    if (info && info.used === info.limit + 1) {
      console.warn(`[limite] ${nombre}: más de ${info.limit} pedidos (${describirClave(req, porIp)}) · ${req.method} ${req.path}`);
    }
    const resetMs = info && info.resetTime ? info.resetTime.getTime() - Date.now() : ventanaMs;
    res.set('Retry-After', String(Math.max(1, Math.ceil(resetMs / 1000))));
    res.status(429).json(DEMASIADOS_BODY);
  };
}

// ¿El pedido trae una sesión válida de alguien que sigue en la allowlist?
// Solo lo pregunta el límite de rechazados, cuando ya se pasó: una ráfaga de
// pedidos sin sesión desde la IP de la oficina no deja afuera a quien ya
// entró. Requerido acá adentro: session.js abre la base.
function tieneSesionValida(req) {
  try {
    const session = require('./auth/session').readSession(req);
    return Boolean(session && session.role);
  } catch {
    return false;
  }
}

function esApi(req) {
  const canonical = require('./auth/gate').canonicalPath(req.path);
  return canonical !== null && (canonical === '/api' || canonical.startsWith('/api/'));
}

/**
 * Arma los seis middlewares, cada uno con su almacén en memoria.
 * @param {ReturnType<typeof resolveRateLimitConfig>} config
 */
function crearLimites(config) {
  const comun = (nombre) => ({
    windowMs: LIMITES[nombre].ventanaMs,
    limit: config[nombre],
    // Sin los encabezados RateLimit: el frontend no los usa. Retry-After va
    // en el 429 (responder429).
    standardHeaders: false,
    legacyHeaders: false,
  });
  const porCorreo = (nombre, extra = {}) =>
    rateLimit({ ...comun(nombre), keyGenerator: claveCorreoOIp, handler: responder429(nombre, LIMITES[nombre].ventanaMs, false), ...extra });
  // Por IP: el keyGenerator de la librería, que además avisa si `trust
  // proxy` está mal puesto para un X-Forwarded-For.
  const porIp = (nombre, extra = {}) =>
    rateLimit({ ...comun(nombre), handler: responder429(nombre, LIMITES[nombre].ventanaMs, true), ...extra });

  const avisoRechazados = responder429('rechazados', LIMITES.rechazados.ventanaMs, true);
  return {
    general: porCorreo('general', {
      // Lo que no es /api (páginas, estáticos) no cuenta, y lo que ya contó
      // su propio límite (sondeo, fotos, resumen) tampoco.
      skip: (req) => req.limiteAparte === true || !esApi(req),
    }),
    sondeo: porCorreo('sondeo'),
    imagenes: porCorreo('imagenes'),
    gasto: porCorreo('gasto'),
    resumen: porIp('resumen'),
    rechazados: porIp('rechazados', {
      // Solo /api (los 401 y 403 salen de ahí; una página sin sesión es una
      // redirección al login): pasado el límite, la pantalla de login sigue
      // cargando y dice lo suyo con el 429 de sus pedidos. /health no es /api.
      skip: (req) => !esApi(req),
      // Cuentan solo los 401 y 403: el resto se descuenta al terminar.
      skipSuccessfulRequests: true,
      requestWasSuccessful: (req, res) => res.statusCode !== 401 && res.statusCode !== 403,
      handler: (req, res, next) => (tieneSesionValida(req) ? next() : avisoRechazados(req, res)),
    }),
  };
}

let instancias = null;
/** Los límites de la app, armados una vez con la config del .env. */
function limites() {
  if (!instancias) instancias = crearLimites(resolveRateLimitConfig());
  return instancias;
}

/**
 * Sondeo, fotos y resumen (marcados para que el general no los cuente dos
 * veces) y el general; después, el de gasto. Va DESPUÉS del gate (la clave
 * es el correo de la sesión) y antes de las rutas.
 */
function registrarLimites(app, l = limites()) {
  const aparte = (limite) => (req, res, next) => {
    req.limiteAparte = true;
    return limite(req, res, next);
  };
  app.get([...RUTAS_SONDEO], aparte(l.sondeo));
  app.get([...RUTAS_IMAGENES], aparte(l.imagenes));
  app.get(RUTA_RESUMEN, aparte(l.resumen));
  app.use(l.general);
  app.post([...RUTAS_GASTO], l.gasto);
}

module.exports = {
  resolveRateLimitConfig,
  describeRateLimitConfig,
  crearLimites,
  limites,
  registrarLimites,
  claveCorreoOIp,
  DEMASIADOS_BODY,
  LIMITES,
  RUTAS_SONDEO,
  RUTAS_IMAGENES,
  RUTA_RESUMEN,
  RUTAS_GASTO,
};
