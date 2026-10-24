// ==========================================================================
// analysisJob.js — El análisis de publicación de Instagram, en el servidor.
// --------------------------------------------------------------------------
// POST /api/analyze no espera el resultado: start() abre la fila de
// `analisis` en "en curso", devuelve el id y el trabajo sigue en este mismo
// proceso, fuera del pedido. Cerrar la pestaña no pierde nada ni vuelve a
// gastar: el resultado queda en la fila (src/db.js) y en "Recientes".
//
// El trabajo:
//   1) Trae la publicación y los comentarios: dos corridas del actor
//      oficial en paralelo (src/apify.js), cada una avisa al terminar.
//   2) Guarda los datos de la publicación y, sin esperar, su foto: la del
//      Monitoreo si ya la tiene, o una copia nueva del link que trajo la
//      corrida (src/postImages.js, mismo archivo; ningún pedido nuevo a
//      Apify).
//   3) Clasifica en tandas y arma la síntesis (src/analyzeComments.js).
//   4) "Cuándo comentaron" (src/commentTimeline.js), los comentarios con su
//      tono, el informe y el gasto, todo en la fila.
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
const { buildCommentTimeline } = require('./commentTimeline');
const { runWithContext } = require('./usageContext');

const PLATAFORMA = 'instagram';
const INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const MENSAJE_SIN_COMENTARIOS = 'La publicación no tiene comentarios visibles o no se pudieron extraer. Probá con otra publicación.';
const MENSAJE_ERROR = 'Ocurrió un error al procesar la publicación. Intentá de nuevo en unos minutos.';

// link normalizado → id, y id → la promesa del trabajo (para los tests).
const enCurso = new Map();
const corridas = new Map();

function log(id, texto, detalle) {
  const extra = detalle && Object.keys(detalle).length ? ` ${JSON.stringify(detalle)}` : '';
  console.log(`[analisis] #${id} ${texto}${extra}`);
}

// El código sale del path, con el mismo criterio que checkAnalyzeUrl
// (src/platforms/urlPlatform.js): /p/, /reel/, /reels/ o /tv/, con o sin el
// usuario adelante, y nunca /reels/audio/.
const ANALYSIS_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/(?!audio(?:\/|$))([A-Za-z0-9_-]{1,64})(?:\/|$)/;

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

/** Los análisis en curso, para la tira de recientes. */
function listEnCurso() {
  return [...enCurso.entries()].map(([url, id]) => ({ id, url }));
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
  log(id, 'inicio', { url: norm.url });
  const corrida = runWithContext({ phase: 'analisis', analisisId: id }, () => run(id, norm.url))
    .catch((err) => console.error(`[analisis] #${id} error inesperado:`, err))
    .finally(() => {
      enCurso.delete(norm.url);
      corridas.delete(id);
    });
  corridas.set(id, corrida);
  return { id, yaEnCurso: false };
}

/** Espera a que termine el trabajo de un análisis (solo para los tests). */
function waitFor(id) {
  return corridas.get(Number(id)) || Promise.resolve();
}

/**
 * Los avisos de una corrida de Apify para el progreso: "Esperar turno" solo
 * si alguna tuvo que esperar cupo; el paso de la corrida arranca cuando
 * consigue el suyo.
 */
function turnoTracker(pasos) {
  let esperando = 0;
  let desde = null;
  return (paso) => {
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
        pasos.start(paso);
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

/** Los comentarios de la muestra como los guarda la fila: numerados desde 1 (los temas los nombran así). */
function comentariosParaGuardar(sample, classifications) {
  return sample.map((c, i) => {
    const row = classifications[i];
    return {
      n: i + 1,
      usuario: c.username,
      verificada: Boolean(c.isVerified),
      likes: c.likesCount ?? null,
      fecha: c.timestamp || null,
      texto: c.text,
      tono: row ? row.sentiment : null,
      tipo: row ? row.accountType : null,
    };
  });
}

async function run(id, url) {
  const pasos = progress.pasosDe(id);
  const hooks = turnoTracker(pasos);
  let traidos = null;
  try {
    // ---- 1) publicación y comentarios, en paralelo
    const hPost = hooks('publicacion');
    const hComentarios = hooks('comentarios');
    const [postRes, comRes] = await Promise.allSettled([
      apify.fetchAnalysisPost(url, hPost).then((items) => {
        const conDatos = (Array.isArray(items) ? items : []).filter((item) => item && !item.error);
        if (conDatos.length === 0) {
          pasos.done('publicacion', 'Instagram no la devolvió · se usan los datos de los comentarios');
        } else {
          const post = apify.normalizePost(conDatos, null, url);
          const likes = post.likesCount === null ? 'likes ocultos' : `${INT.format(post.likesCount)} likes`;
          pasos.done('publicacion', `@${post.ownerUsername} · ${likes} · ${segundosDesde(hPost.desde)} s`);
        }
        return conDatos;
      }),
      apify.fetchAnalysisComments(url, hComentarios).then((res) => {
        const n = apify.normalizeComments(res.items).length;
        pasos.done('comentarios', `${INT.format(n)} ${n === 1 ? 'comentario' : 'comentarios'} · ${segundosDesde(hComentarios.desde)} s`);
        return res;
      }),
    ]);
    if (postRes.status === 'rejected') {
      pasos.fail('publicacion');
      if (comRes.status === 'rejected') pasos.fail('comentarios');
      throw postRes.reason;
    }
    if (comRes.status === 'rejected') {
      pasos.fail('comentarios');
      throw comRes.reason;
    }
    const { post, comments, scrapeMeta } = apify.buildAnalysisData(postRes.value, comRes.value.items, url, comRes.value.limit);
    traidos = comments.length;
    db.saveAnalisisPost(id, PLATAFORMA, post);
    log(id, 'datos traídos', { cuenta: post.ownerUsername, comentarios: traidos, enPost: scrapeMeta.commentsOnPost, tope: scrapeMeta.commentsLimitRequested });

    if (comments.length === 0) {
      db.failAnalisis(id, PLATAFORMA, { estado: 'sin comentarios', error: MENSAJE_SIN_COMENTARIOS, traidos: 0, usdApify: db.sumApifyUsdForAnalisis(id).usd });
      progress.finish(id, { estado: 'sin comentarios', error: MENSAJE_SIN_COMENTARIOS });
      log(id, 'sin comentarios');
      return;
    }

    // ---- 2) la foto, sin esperar
    const foto = guardarFoto(id, post);

    // ---- 3) el modelo
    const desdeModelo = Date.now();
    const result = await analyzer.analyzeComments({ url, post, comments, pasos });
    log(id, 'modelo listo', { ms: Date.now() - desdeModelo, ...result.numeros, tokens: result.tokenUsage ? result.tokenUsage.totalTokens : null });

    // ---- 4) la fila
    pasos.start('informe');
    const cuando = buildCommentTimeline({ postedAt: post.postedAt, comments });
    await foto;
    const { temasConversacion, ...resultado } = result.qualitative;
    db.finishAnalisis(id, PLATAFORMA, {
      ...result.numeros,
      tonos: result.tonos,
      positivoPct: result.metricas.positivoPct,
      negativoPct: result.metricas.negativoPct,
      nivel: result.metricas.nivel,
      resultado,
      temas: temasConversacion,
      comentarios: comentariosParaGuardar(result.sample, result.classifications),
      cuando,
      reporteAntes: result.reportParts ? result.reportParts.beforeTemas : result.report,
      reporteDespues: result.reportParts ? result.reportParts.afterTemas : '',
      csv: result.csv,
      reclamos: result.reclamos,
      usdApify: db.sumApifyUsdForAnalisis(id).usd,
      usdModelo: result.tokenUsage ? result.tokenUsage.costUsd ?? null : null,
      tokens: result.tokenUsage ? result.tokenUsage.totalTokens ?? null : null,
    });
    pasos.done('informe', `listo · ${INT.format(result.report.length)} caracteres`);
    progress.finish(id, { estado: 'ok' });
    log(id, 'listo', { reclamos: result.reclamos });

    // Los reclamos ya quedaron en 'pendiente'; geocodificarlos pega a USIG
    // por red: después, sin esperar.
    if (result.reclamos > 0) geoWorker.processPendingReclamosInBackground();
  } catch (err) {
    const mensaje = (err && err.userMessage) || MENSAJE_ERROR;
    console.error(`[analisis] #${id} error:`, err && err.message);
    try {
      const gastoModelo = (err && err.tokenUsage) || null;
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

module.exports = { start, waitFor, normalizeAnalysisUrl, enCursoDe, listEnCurso, MENSAJE_SIN_COMENTARIOS };
