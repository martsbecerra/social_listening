// ==========================================================================
// analysisProgress.js — El progreso de cada análisis de publicación, en
// memoria (GET /api/analyze/progress?id=).
// --------------------------------------------------------------------------
// Un estado por id de análisis con sus pasos, en orden fijo. Cada paso
// tiene estado ('pendiente' | 'en curso' | 'ok' | 'omitido' | 'error') y un
// detalle que escribe el trabajo real (src/analysisJob.js,
// src/analyzeComments.js): "100 de 287", "@cuenta · 1.234 likes". Nada acá
// inventa un número ni una frase.
//
// "Esperar turno en Apify" solo aparece si alguna corrida tuvo que esperar
// cupo (el limitador lo avisa al encolar). Terminado, el estado queda
// MINUTOS_TERMINADO (10) minutos y después se borra: la ruta de progreso
// cae a la fila de la base (src/analysisRoutes.js).
// ==========================================================================

const PASOS = [
  { key: 'turno', label: 'Esperar turno en Apify', oculto: true },
  { key: 'publicacion', label: 'Traer la publicación' },
  { key: 'comentarios', label: 'Traer los comentarios' },
  { key: 'tono', label: 'Clasificar el tono de cada comentario' },
  { key: 'temas', label: 'Detectar los temas y armar la lectura' },
  { key: 'reclamos', label: 'Ubicar los reclamos' },
  { key: 'informe', label: 'Armar el informe' },
];
const KEYS = new Set(PASOS.map((p) => p.key));
const MINUTOS_TERMINADO = 10;

const estados = new Map();

function create(id, { plataforma }) {
  if (!plataforma) throw new Error('analysisProgress.create: falta plataforma');
  const estado = {
    id: Number(id),
    plataforma,
    estado: 'en curso',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pasos: PASOS.map((p) => ({ key: p.key, label: p.label, estado: 'pendiente', detalle: null, oculto: Boolean(p.oculto) })),
  };
  estados.set(Number(id), estado);
  return estado;
}

function setPaso(id, key, estado, detalle) {
  const actual = estados.get(Number(id));
  if (!actual || !KEYS.has(key)) return;
  const paso = actual.pasos.find((p) => p.key === key);
  paso.estado = estado;
  paso.oculto = false;
  if (detalle !== undefined) paso.detalle = detalle === null ? null : String(detalle);
}

/** Los avisos de un análisis, con la forma que esperan analyzeComments y el trabajo. */
function pasosDe(id) {
  return {
    start: (key, detalle = null) => setPaso(id, key, 'en curso', detalle),
    update: (key, detalle) => setPaso(id, key, 'en curso', detalle),
    done: (key, detalle = null) => setPaso(id, key, 'ok', detalle),
    skip: (key, detalle = null) => setPaso(id, key, 'omitido', detalle),
    fail: (key, detalle = null) => setPaso(id, key, 'error', detalle),
  };
}

/**
 * Cierra el análisis: los pasos que seguían en curso quedan en error (si
 * terminó mal) y los pendientes, como estaban.
 */
function finish(id, { estado, error = null } = {}) {
  const actual = estados.get(Number(id));
  if (!actual) return;
  actual.estado = estado;
  actual.error = error;
  actual.finishedAt = new Date().toISOString();
  if (estado !== 'ok') {
    for (const paso of actual.pasos) if (paso.estado === 'en curso') paso.estado = 'error';
  }
  const timer = setTimeout(() => {
    if (estados.get(Number(id)) === actual) estados.delete(Number(id));
  }, MINUTOS_TERMINADO * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Lo que va al navegador, o null si ese id no está en memoria o es de otra plataforma. */
function getView(id, plataforma) {
  const actual = estados.get(Number(id));
  if (!actual || actual.plataforma !== plataforma) return null;
  return {
    id: actual.id,
    estado: actual.estado,
    error: actual.error,
    startedAt: actual.startedAt,
    finishedAt: actual.finishedAt,
    pasos: actual.pasos.filter((p) => !p.oculto).map(({ key, label, estado, detalle }) => ({ key, label, estado, detalle })),
  };
}

/** Solo para los tests. */
function _reset() {
  estados.clear();
}

module.exports = { create, pasosDe, finish, getView, PASOS, MINUTOS_TERMINADO, _reset };
