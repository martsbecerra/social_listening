// ==========================================================================
// reclamosRoutes.js
// --------------------------------------------------------------------------
// Las rutas del Mapa de reclamos (Instagram y X; plataforma obligatoria,
// cada solapa ve solo la suya):
//
//   GET  /api/reclamos?plataforma=&categoria=&subcategoria=&precision=&…
//        los reclamos (también los de fuera de la Ciudad, para "Sin
//        ubicar": nunca tienen pin) con la precisión, el tipo de ubicación,
//        el lugar y el motivo (fase H, openspec/changes/geo-pro)
//   POST /api/reclamos/:id/corregir  { texto }   el equipo escribe la
//        dirección o el lugar; se vuelve a resolver con el mismo resolver
//   POST /api/reclamos/:id/descartar { motivo }  no es un reclamo ubicable
//   GET  /api/geo/comunas                        los polígonos de las comunas
//
// El correo de quien corrigió o descartó queda en la tabla y no sale de
// acá: la ruta dice solo si se corrigió. Todo va detrás del gate de login.
// ==========================================================================

const db = require('./db');
const territorios = require('./territorios');
const resolver = require('./geo/resolver');
const { CATEGORIAS_RECLAMO, ESTADOS_RECLAMO } = require('./categoriaReclamo');
const { subcategoriasDe } = require('./categoriasConfig');
const { parseReclamosFilters, isValidReclamosPlataforma } = require('./reclamosQuery');
const ETIQUETA = require('./geo/etiquetas');

const MAX_TEXTO = 200;

/** Un reclamo como va al navegador: sin el correo ni la respuesta cruda del modelo. */
function paraNavegador(r) {
  const { corregidaPor, ubicacion, ...resto } = r;
  return { ...resto, corregida: Boolean(corregidaPor) && r.motivoSinUbicar !== 'descartado' };
}

const textoDe = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

function register(app) {
  app.get('/api/reclamos', (req, res) => {
    const filters = parseReclamosFilters(req.query);
    if (!isValidReclamosPlataforma(filters.plataforma)) {
      return res.status(400).json({ error: 'Indicá plataforma=instagram o plataforma=x.' });
    }
    const reclamos = db.listReclamosFiltered(filters, { incluirFueraDeCaba: true }).map(paraNavegador);
    res.json({
      categorias: CATEGORIAS_RECLAMO,
      estados: ESTADOS_RECLAMO,
      // Árbol categoría -> subcategorías, para poblar el filtro dependiente.
      subcategoriasPorCategoria: Object.fromEntries(CATEGORIAS_RECLAMO.map((c) => [c, subcategoriasDe(c)])),
      // Conteo por categoría sobre ESA plataforma, no sobre lo filtrado: el mapa
      // asigna sus 12 colores a las categorías más frecuentes, y ese ranking no
      // puede cambiar cada vez que el usuario toca un filtro — los pines
      // cambiarían de color solos.
      conteoPorCategoria: db.contarReclamosPorCategoria(filters.plataforma),
      // Cómo se dicen la precisión, el tipo y el motivo (los mismos textos que el CSV).
      etiquetas: ETIQUETA,
      reclamos,
    });
  });

  app.post('/api/reclamos/:id/corregir', async (req, res) => {
    const reclamo = db.getReclamo(req.params.id);
    if (!reclamo) return res.status(404).json({ error: 'Ese reclamo no existe.' });
    const texto = textoDe(req.body && req.body.texto);
    if (!texto) return res.status(400).json({ error: 'Escribí la dirección, el cruce o el lugar.' });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `Hasta ${MAX_TEXTO} caracteres.` });
    let r;
    try {
      r = await resolver.resolver(resolver.desdeTextoLibre(texto), { texto });
    } catch (err) {
      if (err.transient) return res.status(503).json({ error: 'USIG no responde en este momento. Probá de nuevo en un rato.' });
      console.error('[reclamos] corregir:', err);
      return res.status(500).json({ error: 'No se pudo resolver esa dirección.' });
    }
    // Lo que no se ubica no pisa nada: el reclamo queda como estaba.
    if (r.geoStatus !== 'ok' && r.ubicacionTipo !== 'barrio') {
      const motivo = ETIQUETA.MOTIVO[r.motivoSinUbicar] || 'no se encontró';
      return res.status(422).json({ error: `No se pudo ubicar «${texto}»: ${motivo.charAt(0).toLowerCase()}${motivo.slice(1)}.`, motivo: r.motivoSinUbicar });
    }
    db.updateReclamoGeo(reclamo.id, r);
    db.marcarReclamoCorregido(reclamo.id, { corregidaPor: req.auth ? req.auth.email : null, texto });
    return res.json({ reclamo: paraNavegador(db.getReclamo(reclamo.id)) });
  });

  app.post('/api/reclamos/:id/descartar', (req, res) => {
    const reclamo = db.getReclamo(req.params.id);
    if (!reclamo) return res.status(404).json({ error: 'Ese reclamo no existe.' });
    const motivo = textoDe(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ error: 'Contá por qué no es un reclamo ubicable.' });
    if (motivo.length > MAX_TEXTO) return res.status(400).json({ error: `Hasta ${MAX_TEXTO} caracteres.` });
    db.descartarReclamo(reclamo.id, { motivo, corregidaPor: req.auth ? req.auth.email : null });
    return res.json({ reclamo: paraNavegador(db.getReclamo(reclamo.id)) });
  });

  app.get('/api/geo/comunas', async (req, res) => {
    try {
      res.set('Cache-Control', 'private, max-age=86400');
      return res.json(await territorios.comunasGeojson());
    } catch (err) {
      console.error('[reclamos] comunas:', err.message);
      return res.status(503).json({ error: 'No se pudieron cargar las comunas.' });
    }
  });
}

module.exports = { register, paraNavegador };
