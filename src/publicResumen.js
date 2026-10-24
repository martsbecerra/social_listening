'use strict';

// ==========================================================================
// publicResumen.js — GET /api/public/resumen, los números del login.
// --------------------------------------------------------------------------
// Es la ÚNICA ruta de datos que se ve sin sesión (src/auth/gate.js la deja
// pasar escrita exacta): la parte visual del login (public/js/loginScene.js)
// muestra solo temas y cantidades. Por eso:
//   - arma la respuesta campo por campo, con lecturas propias de db.js que
//     solo cuentan (countPostedSinceAllPlatforms, countTemasSinceAllPlatforms,
//     getFirstDetectedAtAny, countReclamosEnMapa): nunca un título, un
//     texto, una cuenta, una URL, un término de búsqueda ni un correo. No
//     reusa armarEstadisticas, contarTemas ni buildLastRun, que traen alguno
//     de esos datos;
//   - los temas son los nombres de config/categorias-reclamos.json: un tema
//     guardado que no esté en la lista cuenta como "Coyuntura / Otros";
//   - no lee nada del pedido (query, cuerpo, sesión) ni pone cookies;
//   - guarda la respuesta 60 s en memoria (un solo proceso): venga lo que
//     venga de afuera, la base trabaja a lo sumo una vez por minuto, también
//     cuando falla (el fallo se guarda igual);
//   - si algo falla y hay una respuesta anterior, sirve esa (generadoEn dice
//     de cuándo es); si no hay ninguna, 503 con un mensaje genérico, sin
//     detalles.
// "Reclamos en el mapa" son los que tienen pin (la regla del mapa) y "días
// escuchando" se cuentan desde la primera detección, con los dos extremos.
// Todas las redes juntas: el login no es de ninguna.
// ==========================================================================

const db = require('./db');
const stats = require('./stats');
const { CATEGORIAS, CATEGORIA_FALLBACK } = require('./categoriasConfig');

const RESUMEN_ROUTE = '/api/public/resumen';
const CACHE_MS = 60 * 1000;
const TEMAS_DIAS = 7;
const TEMAS_MAX = 8;
const PUBLICACIONES_DIAS = 30;

/**
 * Los temas de la semana: los 8 con más publicaciones, con su lugar en la
 * lista de la config (`orden`, para el mismo color --cat-N que en la app).
 * @param {{tema: string|null, n: number}[]} filas
 * @returns {{tema: string, n: number, orden: number}[]}
 */
function temasDeLaSemana(filas) {
  const porTema = new Map();
  for (const { tema, n } of filas) {
    const nombre = CATEGORIAS.includes(tema) ? tema : CATEGORIA_FALLBACK;
    porTema.set(nombre, (porTema.get(nombre) || 0) + n);
  }
  return [...porTema]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || CATEGORIAS.indexOf(a[0]) - CATEGORIAS.indexOf(b[0]))
    .slice(0, TEMAS_MAX)
    .map(([tema, n]) => ({ tema, n, orden: CATEGORIAS.indexOf(tema) }));
}

/**
 * El resumen, desde la base. `runHours` y `corridasPorDia` llegan de quien
 * monta la ruta (el scheduler), para el "4 veces por día" del subtítulo.
 * @param {{ ahora?: number, runHours?: number[], corridasPorDia?: number|null }} [opts]
 */
function armarResumen({ ahora = Date.now(), runHours = [], corridasPorDia = null } = {}) {
  const hoy = stats.fechaArgentina(ahora);
  const desde = (dias) => new Date(stats.inicioDelDia(stats.sumarDias(hoy, -(dias - 1)))).toISOString();
  const primero = db.getFirstDetectedAtAny();
  const primerDia = primero ? stats.fechaArgentina(Date.parse(primero)) : null;
  return {
    generadoEn: new Date(ahora).toISOString(),
    publicacionesHoy: db.countPostedSinceAllPlatforms(desde(1)),
    publicaciones30Dias: db.countPostedSinceAllPlatforms(desde(PUBLICACIONES_DIAS)),
    reclamosEnMapa: db.countReclamosEnMapa(),
    primerDia,
    diasEscuchando: primerDia ? Math.max(0, stats.diasEntre(primerDia, hoy)) : 0,
    corridasPorDia: Number.isFinite(corridasPorDia) ? corridasPorDia : null,
    runHours: Array.isArray(runHours) ? runHours.filter((h) => Number.isInteger(h)) : [],
    temas: temasDeLaSemana(db.countTemasSinceAllPlatforms(desde(TEMAS_DIAS))),
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ runInfo?: () => { runHours: number[], corridasPorDia: number|null }, now?: () => number }} [deps]
 */
function register(app, { runInfo = () => ({ runHours: [], corridasPorDia: null }), now = () => Date.now() } = {}) {
  // { at, body }: body es la última respuesta buena (null si todavía no
  // hubo ninguna); at, la última vez que se armó, haya salido bien o mal.
  let cache = null;
  app.get(RESUMEN_ROUTE, (req, res) => {
    const ahora = now();
    if (!cache || ahora - cache.at >= CACHE_MS) {
      try {
        const { runHours, corridasPorDia } = runInfo();
        cache = { at: ahora, body: armarResumen({ ahora, runHours, corridasPorDia }) };
      } catch (err) {
        console.error(`Error en ${RESUMEN_ROUTE}:`, err.message);
        cache = { at: ahora, body: cache ? cache.body : null };
      }
    }
    if (!cache.body) {
      res.status(503).json({ error: 'No se pudo armar el resumen.' });
      return;
    }
    res.set('Cache-Control', `public, max-age=${CACHE_MS / 1000}`);
    res.json(cache.body);
  });
}

module.exports = { register, armarResumen, temasDeLaSemana, RESUMEN_ROUTE, CACHE_MS };
