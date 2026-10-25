// ==========================================================================
// analysisJob.js — El análisis de publicación de Instagram, en el servidor.
// --------------------------------------------------------------------------
// POST /api/analyze no espera el resultado: start() abre la fila de
// `analisis` en "en curso", devuelve el id y el trabajo sigue en este mismo
// proceso, fuera del pedido. Cerrar la pestaña no pierde nada ni vuelve a
// gastar: el resultado queda en la fila (src/db.js) y en "Recientes".
//
// El trabajo:
//   1) Trae la publicación (el actor oficial) y la guarda. Con el número de
//      comentarios que informa Instagram decide (fase G): 0, "sin
//      comentarios" sin pedir nada más; hasta ANALISIS_CONFIRMAR_DESDE
//      (1.000) o sin el número, sigue; con más, espera la confirmación
//      (POST /api/analyze/:id/confirmar: todo —hasta COMMENTS_LIMIT—, una
//      parte o cancelar), con el costo estimado de cada opción
//      (src/analysisCost.js). La espera vence a los 30 minutos. Después trae
//      los comentarios con sus respuestas (apify/instagram-comment-scraper):
//      la publicación nunca se pide dos veces.
//   2) Guarda, sin esperar, la foto: la del
//      Monitoreo si ya la tiene, o una copia nueva del link que trajo la
//      corrida (src/postImages.js, mismo archivo; ningún pedido nuevo a
//      Apify).
//   3) Clasifica en tandas, cruza los verificados con las figuras públicas,
//      guarda los reclamos y arma la síntesis (src/analyzeComments.js).
//   4) "Cuándo comentaron" (src/commentTimeline.js), los comentarios con su
//      clasificación (v2: tono, postura, tema, sobre el posteo, pedido), lo
//      que dijo el modelo, los temas, el informe de 8 puntos, las columnas de
//      la galería y el gasto, todo en la fila. Las métricas se cuentan al
//      leer (src/analysisMetrics.js); las columnas salen de la misma cuenta.
// Cada paso queda en src/analysisProgress.js. Todo corre con el contexto
// { phase: 'analisis', analisisId } (src/usageContext.js): cada llamada a
// Apify queda en apify_calls con su analisis_id.
//
// El mismo link (normalizado a /p/<code>/) con un análisis en curso
// devuelve ese mismo id, sin arrancar otro. Los "en curso" que deja un
// reinicio los cierra server.js al arrancar (db.markInterruptedAnalisis).
//
// apify, analyzeComments, postImages y geoWorker se llaman por el objeto
// del módulo para que los tests los puedan reemplazar.
// ==========================================================================

const db = require('./db');
const apify = require('./apify');
const analyzer = require('./analyzeComments');
const postImages = require('./postImages');
const geoWorker = require('./geoWorker');
const progress = require('./analysisProgress');
const apifyCost = require('./apifyCost');
const { opcionesDeConfirmacion, confirmarDesde } = require('./analysisCost');
const { resolveMaxCommentsLimit } = require('./commentSample');
const { buildCommentTimeline } = require('./commentTimeline');
const { buildAnalysisView, columnasDeVista } = require('./analysisMetrics');
const { buildInforme } = require('./reportBuilder');
const { computePerformanceLevel } = require('./sentimentAggregate');
const { runWithContext } = require('./usageContext');

const PLATAFORMA = 'instagram';
const INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const USD = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MENSAJE_SIN_COMENTARIOS = 'La publicación no tiene comentarios visibles o no se pudieron extraer. Probá con otra publicación.';
const MENSAJE_ERROR = 'Ocurrió un error al procesar la publicación. Intentá de nuevo en unos minutos.';
const MENSAJE_CANCELADO = 'Se canceló antes de traer los comentarios: solo se gastó la publicación.';
const MENSAJE_VENCIDO = 'Nadie confirmó en 30 minutos: no se trajeron los comentarios.';
// La espera de la confirmación (ANALISIS_CONFIRMAR_MS, solo para los tests).
const CONFIRMAR_MS_DEFAULT = 30 * 60 * 1000;

// link normalizado → id, id → la promesa del trabajo (para los tests),
// id → quién lo arrancó (para que cada persona siga solo los suyos) e id →
// la confirmación que espera (con más de 1.000 comentarios).
const enCurso = new Map();
const corridas = new Map();
const duenos = new Map();
const esperas = new Map();

function log(id, texto, detalle) {
  const extra = detalle && Object.keys(detalle).length ? ` ${JSON.stringify(detalle)}` : '';
  console.log(`[analisis] #${id} ${texto}${extra}`);
}

// El código sale del path, con el mismo criterio que checkAnalyzeUrl
// (src/platforms/urlPlatform.js): /p/, /reel/, /reels/ o /tv/, con o sin el
// usuario adelante (share/, stories/… no son usuarios), y nunca
// /reels/audio/.
const ANALYSIS_PATH = /^\/(?:(?!(?:share|stories|explore|accounts|direct|about|legal|web|developer)\/)[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/(?!audio(?:\/|$))([A-Za-z0-9_-]{1,64})(?:\/|$)/;

/**
 * El link de una publicación de Instagram como se guarda y se compara:
 * https://www.instagram.com/p/<code>/ (también para reels). null si no
 * tiene código.
 */
function normalizeAnalysisUrl(url) {
  let pathname;
  try {
    pathname = new URL(String(url || '').trim()).pathname;
  } catch {
    return null;
  }
  const match = ANALYSIS_PATH.exec(pathname);
  if (!match) return null;
  const code = match[1];
  return { url: `https://www.instagram.com/p/${code}/`, code };
}

/** El id del análisis en curso de ese link (ya normalizado), o null. */
function enCursoDe(url) {
  return enCurso.has(url) ? enCurso.get(url) : null;
}

/** Los análisis en curso, con quién los arrancó (las rutas no lo mandan al navegador). */
function listEnCurso() {
  return [...enCurso.entries()].map(([url, id]) => ({ id, url, analizadoPor: duenos.has(id) ? duenos.get(id) : null }));
}

/**
 * Arranca un análisis (o devuelve el que ya está en curso con ese link).
 * @param {{ url: string, analizadoPor?: string|null }} params url ya validada (checkAnalyzeUrl)
 * @returns {{ id: number, yaEnCurso: boolean } | null} null si el link no tiene código de publicación
 */
function start({ url, analizadoPor = null }) {
  const norm = normalizeAnalysisUrl(url);
  if (!norm) return null;
  const existente = enCursoDe(norm.url);
  if (existente !== null) return { id: existente, yaEnCurso: true };

  const id = db.startAnalisis({ plataforma: PLATAFORMA, url: norm.url, postCode: norm.code, analizadoPor });
  progress.create(id, { plataforma: PLATAFORMA });
  enCurso.set(norm.url, id);
  duenos.set(id, analizadoPor || null);
  log(id, 'inicio', { url: norm.url });
  const corrida = runWithContext({ phase: 'analisis', analisisId: id }, () => run(id, norm.url))
    .catch((err) => console.error(`[analisis] #${id} error inesperado:`, err))
    .finally(() => {
      enCurso.delete(norm.url);
      corridas.delete(id);
      duenos.delete(id);
    });
  corridas.set(id, corrida);
  return { id, yaEnCurso: false };
}

/** Espera a que termine el trabajo de un análisis (solo para los tests). */
function waitFor(id) {
  return corridas.get(Number(id)) || Promise.resolve();
}

function confirmarMs() {
  const n = Number(process.env.ANALISIS_CONFIRMAR_MS);
  return Number.isFinite(n) && n > 0 ? n : CONFIRMAR_MS_DEFAULT;
}

/**
 * Espera a que alguien elija (confirmar(), abajo): resuelve con el alcance
 * ('todo' | 'parcial' | 'cancelar') o 'vencido'. Mientras tanto, el progreso
 * muestra el paso "Confirmar el costo" con las opciones.
 */
function esperarConfirmacion(id, { comentarios, opciones }, pasos) {
  const ms = confirmarMs();
  pasos.start('confirmar', `${INT.format(comentarios)} comentarios · elegí cuántos analizar`);
  progress.setConfirmacion(id, { comentarios, opciones, venceAt: new Date(Date.now() + ms).toISOString() });
  log(id, 'esperando confirmación', { comentarios, opciones: opciones.map((o) => `${o.alcance}:${o.items}:${o.total.toFixed(2)}`) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      esperas.delete(id);
      resolve('vencido');
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    esperas.set(id, {
      opciones,
      elegir(alcance) {
        clearTimeout(timer);
        esperas.delete(id);
        resolve(alcance);
      },
    });
  }).finally(() => progress.setConfirmacion(id, null));
}

/** ¿Esa persona (su correo) puede confirmar el gasto? Quien lo arrancó; sin login, cualquiera. */
function puedeConfirmar(id, quien) {
  const dueno = duenos.get(Number(id)) || null;
  return !dueno || quien === dueno;
}

/**
 * La elección de la persona (POST /api/analyze/:id/confirmar).
 * @param {number} id
 * @param {'todo'|'parcial'|'cancelar'} alcance
 * @param {{ quien?: string|null }} [opts] quien: el correo de la sesión
 * @returns {'ok'|'no-espera'|'ajeno'|'sin-opcion'} 'ajeno': lo arrancó otra
 *   persona (solo ella confirma un gasto); 'sin-opcion': ese alcance no
 *   estaba entre las opciones.
 */
function confirmar(id, alcance, { quien = null } = {}) {
  const espera = esperas.get(Number(id));
  if (!espera) return 'no-espera';
  if (!puedeConfirmar(id, quien)) return 'ajeno';
  if (alcance !== 'cancelar' && !espera.opciones.some((o) => o.alcance === alcance)) return 'sin-opcion';
  espera.elegir(alcance);
  return 'ok';
}

/**
 * Los avisos de una corrida de Apify para el progreso: "Esperar turno" solo
 * si alguna tuvo que esperar cupo; el paso de la corrida arranca cuando
 * consigue el suyo.
 */
function turnoTracker(pasos) {
  let esperando = 0;
  let desde = null;
  return (paso, detalle = null) => {
    let encolada = false;
    // apify.js llama a los avisos sueltos (sin this): todo va por `hooks`.
    const hooks = {
      desde: null,
      onQueued() {
        encolada = true;
        esperando += 1;
        if (desde === null) desde = Date.now();
        pasos.start('turno', esperando === 1 ? '1 corrida esperando cupo' : `${esperando} corridas esperando cupo`);
      },
      onAcquired() {
        if (encolada) {
          encolada = false;
          esperando -= 1;
          if (esperando === 0) pasos.done('turno', `${Math.round((Date.now() - desde) / 1000)} s de espera`);
          else pasos.update('turno', esperando === 1 ? '1 corrida esperando cupo' : `${esperando} corridas esperando cupo`);
        }
        hooks.desde = Date.now();
        pasos.start(paso, detalle);
      },
    };
    return hooks;
  };
}

function segundosDesde(ms) {
  return ms ? Math.round((Date.now() - ms) / 1000) : 0;
}

/** La foto: la del Monitoreo si ya está guardada; si no, una copia nueva. Nunca tira. */
async function guardarFoto(id, post) {
  try {
    if (!post.id) return;
    const delMonitoreo = db.getPostImage(post.id, PLATAFORMA);
    if (delMonitoreo && delMonitoreo.savedAt && postImages.hasLocalCopy(PLATAFORMA, post.id)) {
      db.markAnalisisImage(id, PLATAFORMA, {
        sourceUrl: delMonitoreo.sourceUrl,
        status: 'ok',
        savedAt: delMonitoreo.savedAt,
        width: delMonitoreo.width,
        height: delMonitoreo.height,
      });
      return;
    }
    if (!post.imageUrl) return;
    const result = await postImages.savePostImage({ plataforma: PLATAFORMA, id: post.id, url: post.imageUrl });
    if (result.skipped) return;
    if (result.ok) {
      const datos = { sourceUrl: result.sourceUrl, width: result.width, height: result.height, savedAt: result.savedAt };
      db.markAnalisisImage(id, PLATAFORMA, { ...datos, status: 'ok' });
      // Mismo archivo que el Monitoreo: si la publicación está guardada ahí,
      // se entera de que ya tiene foto.
      if (delMonitoreo) db.markPostImageSaved(post.id, PLATAFORMA, datos);
      return;
    }
    db.markAnalisisImage(id, PLATAFORMA, { sourceUrl: result.sourceUrl, status: result.status });
  } catch (err) {
    console.warn(`[analisis] #${id} no se pudo anotar la foto: ${err && err.message}`);
  }
}

async function run(id, url) {
  const pasos = progress.pasosDe(id);
  const hooks = turnoTracker(pasos);
  let traidos = null;
  let gastoModeloListo = null; // lo del modelo, si algo tira después de que terminó
  try {
    // ---- 1) la publicación: con su número de comentarios se decide cuántos
    // traer y si hay que confirmar antes de gastar
    const hPost = hooks('publicacion');
    let postItems;
    try {
      const items = await apify.fetchAnalysisPost(url, hPost);
      postItems = (Array.isArray(items) ? items : []).filter((item) => item && !item.error);
    } catch (err) {
      pasos.fail('publicacion');
      throw err;
    }
    const post = apify.normalizePost(postItems, null, url);
    if (postItems.length === 0) {
      pasos.done('publicacion', 'Instagram no la devolvió · sin datos de la publicación');
    } else {
      const likes = post.likesCount === null ? 'likes ocultos' : `${INT.format(post.likesCount)} likes`;
      pasos.done('publicacion', `@${post.ownerUsername} · ${likes} · ${segundosDesde(hPost.desde)} s`);
    }
    db.saveAnalisisPost(id, PLATAFORMA, post);
    const enInstagram = post.commentsCount;

    const cerrarSinComentarios = () => {
      db.failAnalisis(id, PLATAFORMA, { estado: 'sin comentarios', error: MENSAJE_SIN_COMENTARIOS, traidos: 0, usdApify: db.sumApifyUsdForAnalisis(id).usd });
      progress.finish(id, { estado: 'sin comentarios', error: MENSAJE_SIN_COMENTARIOS });
      log(id, 'sin comentarios');
    };
    // Instagram dice 0: no se pide la corrida de los comentarios.
    if (enInstagram === 0) {
      pasos.skip('comentarios', 'Instagram informa 0 comentarios');
      cerrarSinComentarios();
      return;
    }

    // ---- la confirmación, con más de ANALISIS_CONFIRMAR_DESDE (1.000)
    let items = apify.resolveCommentsLimit();
    let maxComentarios = resolveMaxCommentsLimit();
    if (Number.isFinite(enInstagram) && enInstagram > confirmarDesde()) {
      const opciones = opcionesDeConfirmacion(enInstagram, { tope: items, topeAnalisis: maxComentarios, usdPorItemApify: apifyCost.usdForItems(1) });
      const alcance = await esperarConfirmacion(id, { comentarios: enInstagram, opciones }, pasos);
      if (alcance === 'cancelar' || alcance === 'vencido') {
        const mensaje = alcance === 'cancelar' ? MENSAJE_CANCELADO : MENSAJE_VENCIDO;
        pasos.skip('confirmar', alcance === 'cancelar' ? 'cancelado' : 'venció la espera');
        db.failAnalisis(id, PLATAFORMA, { estado: 'cancelado', error: mensaje, traidos: 0, usdApify: db.sumApifyUsdForAnalisis(id).usd });
        progress.finish(id, { estado: 'cancelado', error: mensaje });
        log(id, alcance === 'cancelar' ? 'cancelado' : 'venció la confirmación');
        return;
      }
      const elegida = opciones.find((o) => o.alcance === alcance);
      items = elegida.items;
      maxComentarios = Math.min(maxComentarios, elegida.items);
      pasos.done('confirmar', `${elegida.completo ? 'todos' : `${INT.format(elegida.items)} de ${INT.format(enInstagram)}`} · ~US$ ${USD.format(elegida.total)} estimado`);
      log(id, 'confirmado', { alcance, items });
    }

    // ---- los comentarios con sus respuestas
    const resultsLimit = apify.commentsResultsLimit(enInstagram, items);
    const hComentarios = hooks('comentarios', `pidiendo ${INT.format(resultsLimit)} comentarios con sus respuestas`);
    let comRes;
    try {
      comRes = await apify.fetchAnalysisComments(url, hComentarios, { resultsLimit });
    } catch (err) {
      pasos.fail('comentarios');
      throw err;
    }
    const { comments, scrapeMeta } = apify.buildAnalysisData(postItems, comRes.items, url, comRes.limit);
    const respuestas = comments.filter((c) => c.esRespuesta).length;
    pasos.done(
      'comentarios',
      `${INT.format(comments.length - respuestas)} ${comments.length - respuestas === 1 ? 'comentario' : 'comentarios'} y ${INT.format(respuestas)} ${respuestas === 1 ? 'respuesta' : 'respuestas'} · ${segundosDesde(hComentarios.desde)} s`
    );
    traidos = comments.length;
    log(id, 'datos traídos', { cuenta: post.ownerUsername, comentarios: traidos, respuestas, enPost: scrapeMeta.commentsOnPost, pedidos: resultsLimit });

    if (comments.length === 0) {
      cerrarSinComentarios();
      return;
    }

    // ---- 2) la foto, sin esperar
    const foto = guardarFoto(id, post);

    // ---- 3) el modelo
    const desdeModelo = Date.now();
    const result = await analyzer.analyzeComments({ url, post, comments, pasos, maxComentarios });
    gastoModeloListo = result.tokenUsage || null;
    log(id, 'modelo listo', { ms: Date.now() - desdeModelo, ...result.numeros, tokens: result.tokenUsage ? result.tokenUsage.totalTokens : null });

    // ---- 4) la fila (el paso "informe" lo arrancó la síntesis)
    const cuando = buildCommentTimeline({ postedAt: post.postedAt, comments });
    await foto;
    const s = result.sintesis;
    // lecturaEstrategica: la que lee la solapa de la fase E hasta la F2.
    // respuestas: los comentarios se pidieron con sus respuestas (fase G);
    // sin la marca, la pantalla dice "No disponible en análisis anteriores".
    const resultado = {
      version: 2,
      respuestas: true,
      lectura: s.lectura,
      lecturaEstrategica: s.lectura,
      hecho: s.hecho,
      pedidos: s.pedidos,
      queMirar: s.queMirar,
      figurasSugeridas: s.figurasSugeridas,
    };
    const finishedAt = new Date().toISOString();
    const usdApify = db.sumApifyUsdForAnalisis(id).usd;
    const usdModelo = result.tokenUsage ? result.tokenUsage.costUsd ?? null : null;
    // La misma cuenta que la pantalla: las columnas y el informe salen de la vista.
    const vista = buildAnalysisView(
      {
        id,
        url,
        cuenta: post.ownerUsername && post.ownerUsername !== 'N/D' ? post.ownerUsername : null,
        postType: post.postType,
        caption: post.caption,
        postedAt: post.postedAt,
        finishedAt,
        likes: post.likesCount,
        comentariosTotal: post.commentsCount,
        traidos: result.numeros.traidos,
        analizados: result.numeros.analizados,
        resultado,
        temas: result.temas,
        comentarios: result.comentarios,
        cuando,
        usdApify,
        usdModelo,
      },
      { figuras: db.getFigurasPorUsernames(result.comentarios.map((c) => c.usuario)) }
    );
    const informe = buildInforme(vista);
    db.finishAnalisis(id, PLATAFORMA, {
      ...result.numeros,
      finishedAt,
      tonos: result.tonos,
      positivoPct: null,
      negativoPct: null,
      nivel: computePerformanceLevel(post),
      resultado,
      temas: result.temas,
      comentarios: result.comentarios,
      cuando,
      reporteAntes: informe,
      reporteDespues: '',
      csv: result.reclamosCsv,
      reclamos: result.reclamos,
      usdApify,
      usdModelo,
      tokens: result.tokenUsage ? result.tokenUsage.totalTokens ?? null : null,
      ...columnasDeVista(vista),
    });
    pasos.done('informe', `listo · ${INT.format(informe.length)} caracteres`);
    progress.finish(id, { estado: 'ok' });
    log(id, 'listo', { reclamos: result.reclamos });

    // Los reclamos ya quedaron en 'pendiente'; geocodificarlos pega a USIG
    // por red: después, sin esperar.
    if (result.reclamos > 0) geoWorker.processPendingReclamosInBackground();
  } catch (err) {
    const mensaje = (err && err.userMessage) || MENSAJE_ERROR;
    console.error(`[analisis] #${id} error:`, err && err.message);
    try {
      const gastoModelo = (err && err.tokenUsage) || gastoModeloListo;
      db.failAnalisis(id, PLATAFORMA, {
        estado: 'error',
        error: mensaje,
        traidos,
        usdApify: db.sumApifyUsdForAnalisis(id).usd,
        usdModelo: gastoModelo ? gastoModelo.costUsd ?? null : null,
        tokens: gastoModelo ? gastoModelo.totalTokens ?? null : null,
      });
    } catch (dbErr) {
      console.error(`[analisis] #${id} no se pudo cerrar la fila:`, dbErr && dbErr.message);
    }
    progress.finish(id, { estado: 'error', error: mensaje });
  }
}

module.exports = { start, waitFor, confirmar, puedeConfirmar, normalizeAnalysisUrl, enCursoDe, listEnCurso, MENSAJE_SIN_COMENTARIOS, MENSAJE_CANCELADO, MENSAJE_VENCIDO };
