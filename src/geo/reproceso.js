// ==========================================================================
// geo/reproceso.js
// --------------------------------------------------------------------------
// El reproceso de los reclamos que quedaron sin punto (fase H, decisión del
// dueño): el modelo extrae su ubicación estructurada UNA vez, sobre una
// copia de la base (scripts/geo-reprocesar.js), y lo extraído queda en
// data/geo/reproceso-ubicaciones.json; el piloto lo aplica una sola vez al
// arrancar (server.js → aplicarSiHay, marca en refresh_state): guarda la
// ubicación de cada uno, los deja pendientes y los pasa por el resolver.
// Los que ya tienen punto lo conservan; los corregidos o descartados a
// mano, y los que cambiaron de texto desde la extracción, no se tocan.
// ==========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { geoDir } = require('./config');

const MARCA = 'geo_reproceso_aplicado';
const VERSION = 1;

const archivoPorDefecto = () => path.join(geoDir(), 'reproceso-ubicaciones.json');
const hashDe = (texto) => crypto.createHash('sha1').update(String(texto || '')).digest('hex').slice(0, 16);

const tienePunto = (r) => r.x != null && r.y != null && !(r.x === 0 && r.y === 0) && r.geoStatus !== 'fuera_caba' && r.motivoSinUbicar !== 'descartado';

/**
 * Los reclamos que entran al reproceso: sin un punto válido, ni corregidos
 * ni descartados a mano, con texto. Para cada uno, lo que va al modelo: el
 * texto, la pista (lo que había detectado el análisis; nunca la del Excel
 * importado, que el modelo ya había rechazado) y, si se conoce, el texto y
 * el lugar de su publicación.
 */
function candidatos() {
  const captions = new Map();
  const todos = [];
  for (const plataforma of ['instagram', 'x']) {
    for (const r of db.listReclamosFiltered({ plataforma }, { incluirFueraDeCaba: true })) {
      if (tienePunto(r) || r.corregidaPor || r.motivoSinUbicar === 'descartado' || !String(r.textoOriginal || '').trim()) continue;
      if (r.postUrl && !captions.has(r.postUrl)) {
        // El último análisis terminado de esa publicación (el lugar de la
        // publicación no se guarda en la fila: va solo el texto).
        const a = db.findAnalisisByUrl({ plataforma, url: r.postUrl });
        captions.set(r.postUrl, a ? { caption: a.caption || null, lugar: null } : null);
      }
      const post = r.postUrl ? captions.get(r.postUrl) : null;
      todos.push({
        id: r.id,
        plataforma,
        texto: r.textoOriginal,
        pista: r.importOrigen ? null : r.direccionDetectada || null,
        caption: post ? post.caption : null,
        lugarPublicacion: post ? post.lugar : null,
      });
    }
  }
  return todos;
}

/** El JSON de lo extraído (lo escribe el script con --si). */
function escribirArchivo(archivo, { items, extraccion, modelo = null, ahora = new Date().toISOString() }) {
  const ubicaciones = {};
  for (const it of items) {
    const u = extraccion.ubicaciones.get(it.id);
    if (u) ubicaciones[it.id] = { ubicacion: u, textoHash: hashDe(it.texto) };
  }
  const datos = { version: VERSION, creadoEn: ahora, modelo, usd: extraccion.usd, tokens: extraccion.tokens, llamadas: extraccion.llamadas, fallidas: extraccion.fallidas, ubicaciones };
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 1));
  fs.renameSync(tmp, archivo);
  return datos;
}

/**
 * Lo que hay hoy, para el informe: por plataforma, cuántos tienen punto de
 * cuántos; por precisión; cuántos son una mención de solo un barrio; los
 * sin ubicar por motivo (sin los descartados).
 */
function resumen(ids = null) {
  const filtro = ids ? new Set(ids) : null;
  const salida = {};
  for (const plataforma of ['instagram', 'x']) {
    const lista = db.listReclamosFiltered({ plataforma }, { incluirFueraDeCaba: true }).filter((r) => !filtro || filtro.has(r.id));
    const vigentes = lista.filter((r) => r.motivoSinUbicar !== 'descartado');
    const conPunto = vigentes.filter(tienePunto);
    const porPrecision = {};
    for (const r of conPunto) porPrecision[r.precision] = (porPrecision[r.precision] || 0) + 1;
    const menciones = vigentes.filter((r) => !tienePunto(r) && r.ubicacionTipo === 'barrio' && !r.motivoSinUbicar).length;
    const sinUbicar = {};
    for (const r of vigentes) {
      if (tienePunto(r) || (r.ubicacionTipo === 'barrio' && !r.motivoSinUbicar)) continue;
      const m = r.geoStatus === 'pendiente' ? 'pendiente' : r.motivoSinUbicar || 'no_encontrada';
      sinUbicar[m] = (sinUbicar[m] || 0) + 1;
    }
    salida[plataforma] = { total: vigentes.length, conPunto: conPunto.length, porPrecision, menciones, sinUbicar, descartados: lista.length - vigentes.length };
  }
  return salida;
}

/**
 * Al arrancar: si hay archivo y no se aplicó, guarda cada ubicación y pasa
 * esos reclamos por el resolver (worker de siempre, de a uno). Deja la marca
 * antes de empezar: si el proceso se corta, los que quedaron pendientes los
 * termina el worker del ciclo.
 * @param {{ archivo?: string, procesar: () => Promise<object>, ahora?: string }} opts
 *   procesar: geoWorker.processPendingReclamos (se inyecta: geoWorker usa el resolver).
 * @returns {Promise<{ aplicados: number, salteados: number, resumen: object } | null>} null si no había nada que hacer.
 */
async function aplicarSiHay({ archivo = archivoPorDefecto(), procesar, ahora = new Date().toISOString() }) {
  if (db.getRefreshState(MARCA) || !fs.existsSync(archivo)) return null;
  let datos;
  try {
    datos = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (err) {
    console.warn(`[geo] reproceso: ${archivo} no se pudo leer (${err.message}); no se aplica`);
    return null;
  }
  if (!datos || datos.version !== VERSION || !datos.ubicaciones) {
    console.warn('[geo] reproceso: el archivo no tiene el formato esperado; no se aplica');
    return null;
  }
  db.setRefreshState(MARCA, ahora);
  const ids = [];
  let salteados = 0;
  for (const [id, { ubicacion, textoHash }] of Object.entries(datos.ubicaciones)) {
    const r = db.getReclamo(id);
    if (!r || tienePunto(r) || r.corregidaPor || r.motivoSinUbicar === 'descartado' || hashDe(r.textoOriginal) !== textoHash) {
      salteados += 1;
      continue;
    }
    db.setReclamoUbicacion(id, { ubicacionTipo: ubicacion.tipo, ubicacion });
    db.updateReclamoGeo(id, { geoStatus: 'pendiente', precision: null });
    ids.push(id);
  }
  console.log(`[geo] reproceso: ${ids.length} reclamos con su ubicación del modelo vuelven al resolver (${salteados} salteados)`);
  await procesar();
  const r = resumen(ids);
  for (const [plataforma, s] of Object.entries(r)) {
    if (!s.total) continue;
    console.log(`[geo] reproceso (${plataforma}): ${s.conPunto} de ${s.total} ubicados · por precisión ${JSON.stringify(s.porPrecision)} · ${s.menciones} solo el barrio · sin ubicar ${JSON.stringify(s.sinUbicar)}`);
  }
  return { aplicados: ids.length, salteados, resumen: r };
}

module.exports = { candidatos, escribirArchivo, resumen, aplicarSiHay, archivoPorDefecto, hashDe, MARCA };
