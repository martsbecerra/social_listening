// ==========================================================================
// analyzeComments.js
// --------------------------------------------------------------------------
// El análisis de publicación de Instagram con el modelo (Anthropic u
// OpenRouter). Desde la fase F (openspec/changes/analisis-pro):
//   1) Muestra estable (commentSample.js): sin repetidos, en orden fijo,
//      hasta COMMENTS_ANALYSIS_LIMIT (300 por defecto).
//   2) Clasificación en TANDAS de BATCH_SIZE (50) comentarios por llamada:
//      por comentario tono, postura hacia la gestión, tema, si habla del
//      posteo, si pide algo y reclamos con ubicación (TANDA_JSON_SCHEMA). La
//      primera tanda va SOLA y define los temas de la publicación; las demás
//      (hasta BATCH_CONCURRENCY a la vez) reciben esa lista y pueden sumar
//      temas nuevos, que se unen por nombre. Una tanda cuya respuesta se
//      corta por el tope de salida (SALIDA_CORTADA) se parte en dos mitades,
//      una después de la otra; una que falla deja sus comentarios sin
//      clasificar (null) y el análisis sigue; si fallan todas, tira con el
//      mensaje del proveedor. Lo gastado en una llamada fallida también se
//      suma (err.tokenUsage).
//   3) Verificados y figuras públicas: todos los que comentaron se cruzan
//      con la tabla figuras_publicas.
//   4) Reclamos (subcategoría y guardado, conservando la gestión de los que
//      ya existían).
//   5) Síntesis: con los números ya contados (analysisMetrics.js), la
//      lectura, el hecho dominante, los pedidos agrupados, qué mirar y
//      sugerencias de rol para verificados sin ficha, que quedan en la tabla
//      como "sugerida" (nunca pisan una fila del equipo).
// Sin tipo de cuenta ni registro de cuentas: la postura lo reemplaza.
// "Analizados" son los clasificados de verdad. Si algo tira después de
// alguna llamada, el error lleva lo ya gastado en el modelo (err.tokenUsage):
// la fila del análisis lo guarda igual.
//
// El LLM y la subcategoría se llaman por el objeto del módulo (llm.,
// clasificarReclamo.) para que los tests los puedan reemplazar.
// ==========================================================================

const { TANDA_SYSTEM_PROMPT, SINTESIS_SYSTEM_PROMPT } = require('./prompt');
const { TANDA_JSON_SCHEMA, SINTESIS_JSON_SCHEMA } = require('./analysisSchema');
const { prepareCommentSample, dedupeComments, ordenarConRespuestas } = require('./commentSample');
const { normalizeBatchClassifications, normalizeTemasDeTanda, applyHeuristicsToClassified, normalizeSynthesis } = require('./validateAnalysis');
const { buildReclamosCsv } = require('./reportBuilder');
const { countTones } = require('./sentimentAggregate');
const { buildBatchPrompt, buildSynthesisPrompt } = require('./userPrompt');
const { buildAnalysisView, claveTema } = require('./analysisMetrics');
const llm = require('./llm');
const { getLlmProvider, getProviderLabel } = require('./llm/providerConfig');
const { buildReclamosFromAnalysis } = require('./reclamosFromAnalysis');
const clasificarReclamo = require('./clasificarReclamo');
const { addTokenUsage } = require('./llm/usage');
const { SALIDA_CORTADA } = require('./llm/errors');
const db = require('./db');

// Corrida real del 24/10/2026: con un modelo que razona, 50 comentarios
// gastaron 10.653 tokens de salida (el JSON, unos 2.000; el resto, el
// razonamiento) y una tanda de 100 se cortó en el tope de 12.000. Tandas de
// 50 con 16.000 de tope; la que igual se corta se parte en dos (correrTanda).
// Cinco a la vez: los mismos ~250 comentarios en vuelo que antes con 3 × 100.
const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 5;
const BATCH_MAX_TOKENS = 16000;
// Cuántas tandas pueden ir solas, una tras otra, buscando la que defina los
// temas (la primera y, si cae, la siguiente): más alargaría mucho un
// análisis con el proveedor caído.
const MAX_TANDAS_SOLAS = 2;
const SYNTHESIS_MAX_TOKENS = 6000;
// Tope de temas de una publicación: los que lleguen después quedan sin tema.
const MAX_TEMAS_ANALISIS = 15;
// La muestra de la síntesis: lo que más pesa, sin mandar los 300 de nuevo.
const MUESTRA_TOP = 40;
const MUESTRA_PEDIDOS = 80;
const MUESTRA_HECHO = 25;
const MUESTRA_MAX = 160;
const INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

const NO_PASOS = { start() {}, update() {}, done() {}, skip() {}, fail() {} };

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Corre las tareas de a `limit` a la vez, en orden de lista. */
async function runPool(tasks, limit) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function llmError(err, provider) {
  if (err && err.userMessage) return err;
  const label = getProviderLabel(provider);
  const e = new Error(`${label} falló: ${err && err.message}`);
  e.userMessage = `El servicio de análisis (${label}) falló. Intentá de nuevo en unos minutos.`;
  return e;
}

/** La lista de temas del análisis: ids desde 1, unidos por nombre. */
function crearTemas() {
  const lista = [];
  const porClave = new Map();
  return {
    lista,
    /** @returns {number|null} el id (el existente si el nombre ya está); null pasado el tope. */
    agregar(nombre) {
      const clave = claveTema(nombre);
      if (!clave) return null;
      if (porClave.has(clave)) return porClave.get(clave);
      if (lista.length >= MAX_TEMAS_ANALISIS) return null;
      const id = lista.length + 1;
      lista.push({ id, nombre: String(nombre).replace(/\s+/g, ' ').trim() });
      porClave.set(clave, id);
      return id;
    },
    paraPrompt() {
      return lista.map((t) => ({ numero: t.id, nombre: t.nombre }));
    },
  };
}

/**
 * Los comentarios como los guarda la fila (v2), numerados desde 1 en la
 * muestra. Desde la fase G cada uno dice si es una respuesta (y a qué número
 * de la muestra responde, o null si ese no entró, y a qué @usuario), si es
 * de la propia cuenta (sin clasificar: no va al modelo) y, el de primer
 * nivel, cuántas respuestas declara Instagram.
 */
function comentariosParaGuardar(sample, classifications) {
  const numeroDe = new Map();
  sample.forEach((c, i) => {
    if (!c.esRespuesta && c.apifyId != null) numeroDe.set(String(c.apifyId), i + 1);
  });
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
      postura: row ? row.postura : null,
      tema: row ? row.temaId : null,
      sobrePosteo: row ? row.sobrePosteo : null,
      pedido: row ? row.pedido : null,
      esRespuesta: Boolean(c.esRespuesta),
      respondeA: c.esRespuesta && c.parentApifyId != null ? numeroDe.get(String(c.parentApifyId)) ?? null : null,
      respondeAUsuario: c.padre ? c.padre.usuario : null,
      deLaCuenta: Boolean(c.deLaCuenta),
      respuestasDeclaradas: c.respuestasDeclaradas ?? null,
    };
  });
}

/** El usuario dueño de la publicación, en minúsculas; null si no se sabe. */
function duenoDe(post) {
  const u = String((post && post.ownerUsername) || '').trim().toLowerCase();
  return u && u !== 'n/d' ? u : null;
}

/**
 * La muestra del análisis: los comentarios del público, con su tope
 * (prepareCommentSample), y aparte, sin tope, los de la propia cuenta, que
 * no van al modelo (solo "¿La cuenta respondió?"). Cada respuesta lleva el
 * @usuario y el texto del comentario al que responde (`padre`), aunque ese
 * no haya entrado en la muestra; cada una va detrás de su comentario.
 * @returns {{ sample: Array, paraModelo: Array, unicos: number, propios: number }}
 */
function armarMuestra(comments, post) {
  const dueno = duenoDe(post);
  const esDeLaCuenta = (c) => dueno !== null && String(c.username || '').toLowerCase() === dueno;
  const { sample: publico, total: unicos } = prepareCommentSample(comments.filter((c) => !esDeLaCuenta(c)));
  const propios = dedupeComments(comments.filter(esDeLaCuenta)).map((c) => ({ ...c, deLaCuenta: true }));
  const porId = new Map(comments.filter((c) => !c.esRespuesta && c.apifyId != null).map((c) => [String(c.apifyId), c]));
  const conPadre = (c) => {
    const p = c.esRespuesta && c.parentApifyId != null ? porId.get(String(c.parentApifyId)) : null;
    return p ? { ...c, padre: { usuario: p.username, texto: p.text } } : c;
  };
  const sample = ordenarConRespuestas([...publico, ...propios].map(conPadre));
  return { sample, paraModelo: sample.filter((c) => !c.deLaCuenta), unicos, propios: propios.length };
}

/** La muestra que lee la síntesis: los pedidos, los de más likes, los del tema principal fuera del posteo y los verificados. */
function muestraParaSintesis(vista) {
  const porLikes = (a, b) => (b.likes || 0) - (a.likes || 0) || a.n - b.n;
  const clasificados = vista.comentarios.filter((c) => c.tono !== null);
  const principal = vista.sobrePosteo && vista.sobrePosteo.desvios.length ? vista.sobrePosteo.desvios[0].temaId : null;
  const elegidos = new Map();
  const sumar = (lista) => lista.forEach((c) => elegidos.size < MUESTRA_MAX && elegidos.set(c.n, c));
  sumar(clasificados.filter((c) => c.pedido).sort(porLikes).slice(0, MUESTRA_PEDIDOS));
  sumar([...clasificados].sort(porLikes).slice(0, MUESTRA_TOP));
  if (principal !== null) sumar(clasificados.filter((c) => c.temaId === principal && c.sobrePosteo === false).sort(porLikes).slice(0, MUESTRA_HECHO));
  sumar(clasificados.filter((c) => c.verificada));
  return [...elegidos.values()].sort((a, b) => a.n - b.n);
}

/**
 * @param {{ url: string, post: object, comments: Array, pasos?: { start: Function, update: Function, done: Function, skip: Function, fail: Function } }} params
 *   pasos: los avisos del progreso (src/analysisProgress.js) para los pasos
 *   'clasificar', 'verificados', 'reclamos' e 'informe' (este lo arranca acá
 *   la síntesis y lo cierra el trabajo al guardar).
 * @returns {Promise<object>} sample, classifications (con temaId), temas,
 *   comentarios (como los guarda la fila), sintesis, tonos, numeros,
 *   reclamos, reclamosCsv y tokenUsage. Si tira, el error lleva
 *   err.tokenUsage con lo ya gastado.
 */
async function analyzeComments(params) {
  const gasto = { tokenUsage: null };
  try {
    return await analizar(params, gasto);
  } catch (err) {
    if (err && typeof err === 'object' && gasto.tokenUsage) err.tokenUsage = gasto.tokenUsage;
    throw err;
  }
}

/** El análisis en sí; `gasto.tokenUsage` va sumando cada llamada al modelo. */
async function analizar({ url, post, comments, pasos = NO_PASOS }, gasto) {
  const provider = getLlmProvider();
  const { sample, paraModelo, unicos, propios } = armarMuestra(comments, post);
  const sumUsage = (usage) => {
    if (usage) gasto.tokenUsage = gasto.tokenUsage ? addTokenUsage(gasto.tokenUsage, usage) : usage;
  };

  // ---- 1) clasificar: la primera tanda sola define los temas; las demás los reusan
  const tandas = chunk(paraModelo, BATCH_SIZE);
  const porTanda = new Array(tandas.length);
  const temas = crearTemas();
  let hechos = 0;
  let fallidas = 0;
  let ultimoError = null;
  const desde = Date.now();
  const total = paraModelo.length;
  pasos.start('clasificar', `0 de ${INT.format(total)}`);
  pasos.update('clasificar', `0 de ${INT.format(total)}`, { avance: 0 });
  // Una llamada para un lote: sus filas (con temaId), o tira con lo gastado.
  const clasificarLote = async (lote, numero) => {
    const lista = temas.paraPrompt();
    const result = await llm.requestStructuredAnalysis({
      system: TANDA_SYSTEM_PROMPT,
      userPrompt: buildBatchPrompt({ url, post, batch: lote, numero, tandas: tandas.length, temas: lista }),
      schema: TANDA_JSON_SCHEMA,
      schemaName: 'tanda_instagram',
      maxTokens: BATCH_MAX_TOKENS,
    });
    sumUsage(result.usage);
    const parsed = result.parsed || {};
    // Los números de la tanda → los ids del análisis: los de la lista que
    // recibió quedan; los nuevos se unen por nombre.
    const deLaLista = new Set(lista.map((x) => x.numero));
    const nuevos = new Map();
    for (const x of normalizeTemasDeTanda(parsed.temas)) {
      if (!deLaLista.has(x.numero)) nuevos.set(x.numero, temas.agregar(x.nombre));
    }
    const idDe = (n) => (deLaLista.has(n) ? n : nuevos.has(n) ? nuevos.get(n) : null);
    return normalizeBatchClassifications(parsed.classifications, lote.length).map((row) => (row ? { ...row, temaId: row.tema ? idDe(row.tema) : null } : null));
  };
  // Un lote que no se pudo clasificar: sus comentarios quedan en null.
  const sinClasificar = (lote, numero, err) => {
    sumUsage(err && err.tokenUsage);
    ultimoError = err;
    console.warn(`[analisis] la tanda ${numero} de ${tandas.length} falló (${lote.length} comentarios sin clasificar): ${err && err.message}`);
    return new Array(lote.length).fill(null);
  };
  const correrTanda = async (t) => {
    const tanda = tandas[t];
    let fallo = false; // de esta tanda: una partida con alguna mitad caída cuenta una vez
    try {
      porTanda[t] = await clasificarLote(tanda, t + 1);
    } catch (err) {
      if (err && err.code === SALIDA_CORTADA && tanda.length > 1) {
        // Se cortó por larga: va en dos mitades, una después de la otra (la
        // segunda recibe los temas que haya sumado la primera). Una vez.
        sumUsage(err.tokenUsage);
        const mitad = Math.ceil(tanda.length / 2);
        console.warn(`[analisis] la tanda ${t + 1} de ${tandas.length} se cortó por larga: va en dos partes de ${mitad} y ${tanda.length - mitad}`);
        const partes = [];
        for (const [k, parte] of [tanda.slice(0, mitad), tanda.slice(mitad)].entries()) {
          const numero = `${t + 1}.${k + 1}`;
          try {
            partes.push(await clasificarLote(parte, numero));
          } catch (errParte) {
            fallo = true;
            partes.push(sinClasificar(parte, numero, errParte));
          }
        }
        porTanda[t] = partes.flat();
      } else {
        fallo = true;
        porTanda[t] = sinClasificar(tanda, t + 1, err);
      }
    }
    if (fallo) fallidas += 1;
    // Solo lo clasificado: una tanda caída no avanza el contador.
    hechos += porTanda[t].filter(Boolean).length;
    pasos.update('clasificar', `${INT.format(hechos)} de ${INT.format(total)}`, { avance: total ? hechos / total : 1 });
  };
  // La primera va sola y define los temas. Si cae o no devuelve ninguno, la
  // que sigue también va sola (hasta MAX_TANDAS_SOLAS en total): si no, las
  // que corren en paralelo armaban cada una su propia lista.
  let solas = 0;
  while (solas < tandas.length && (solas === 0 || (temas.lista.length === 0 && solas < MAX_TANDAS_SOLAS))) {
    await correrTanda(solas);
    solas += 1;
  }
  await runPool(
    tandas.slice(solas).map((_, k) => () => correrTanda(solas + k)),
    BATCH_CONCURRENCY
  );
  const clasificados = applyHeuristicsToClassified(paraModelo, porTanda.flat())
    // El ruido no tiene tema (las heurísticas lo dejan en 0).
    .map((row) => (row && !row.tema ? { ...row, temaId: null } : row));
  // De vuelta al orden de la muestra: los de la cuenta quedan sin clasificar.
  const deCada = new Map(paraModelo.map((c, i) => [c, clasificados[i]]));
  const classifications = sample.map((c) => deCada.get(c) ?? null);
  const analizados = classifications.filter(Boolean).length;
  if (analizados === 0) {
    pasos.fail('clasificar', 'no se pudo clasificar');
    // El error del proveedor trae el mensaje que sirve (sin crédito, clave
    // inválida, modelo sin schema): reintentar no lo arregla.
    throw llmError(ultimoError || new Error('ninguna tanda devolvió clasificaciones'), provider);
  }
  const segundos = Math.round((Date.now() - desde) / 1000);
  const tandasTexto = `${tandas.length} ${tandas.length === 1 ? 'tanda' : 'tandas'}`;
  pasos.done(
    'clasificar',
    `${INT.format(analizados)} de ${INT.format(total)} · ${tandasTexto} · ${segundos} s${fallidas ? ` · ${fallidas === 1 ? 'una tanda falló' : `${fallidas} tandas fallaron`}` : ''}`
  );
  const comentarios = comentariosParaGuardar(sample, classifications);
  const temasV2 = { version: 2, lista: temas.lista.map((t) => ({ id: t.id, nombre: t.nombre })) };

  // ---- 2) verificados y figuras públicas: todos los que comentaron (no la
  // propia cuenta), contra la tabla
  pasos.start('verificados');
  const figuras = db.getFigurasPorUsernames(paraModelo.map((c) => c.username));
  const verificados = new Set(paraModelo.filter((c) => c.isVerified).map((c) => String(c.username || '').toLowerCase()));
  // Con ficha = confirmada por el equipo; una sugerida el modelo la puede
  // volver a sugerir (se actualiza) y en pantalla va como "sugerido".
  const conFicha = new Set([...figuras.entries()].filter(([, x]) => x.origen === 'equipo').map(([u]) => u));
  // Una que el equipo descartó no vuelve a la síntesis como verificado sin ficha.
  const descartadas = new Set([...figuras.entries()].filter(([, x]) => x.origen === 'descartada').map(([u]) => u));
  pasos.done(
    'verificados',
    `${verificados.size === 1 ? '1 verificado' : `${INT.format(verificados.size)} verificados`} · ${conFicha.size === 1 ? '1 figura pública' : `${conFicha.size} figuras públicas`}`
  );

  // ---- 3) reclamos: la categoría ya vino en la tanda; la subcategoría es
  // una llamada aparte para todos (clasificarReclamo.js), que nunca tira.
  const reclamos = buildReclamosFromAnalysis({ url, sample, classifications });
  if (reclamos.length > 0) {
    pasos.start('reclamos', `${reclamos.length} con ubicación`);
    const { subcategorias, usage: subUsage, llamadas } = await clasificarReclamo.asignarSubcategorias(
      reclamos.map((r) => ({
        categoria: r.categoria,
        texto: r.textoOriginal,
        direccionDetectada: r.direccionDetectada,
      }))
    );
    reclamos.forEach((r, i) => {
      r.subcategoria = subcategorias[i] || '';
    });
    sumUsage(subUsage);
    if (llamadas > 0) {
      const conSub = subcategorias.filter(Boolean).length;
      console.log(`[reclamos] ${reclamos.length} reclamo(s), ${conSub} con subcategoría asignada (${llamadas} llamada/s al LLM).`);
    }
    // Re-analizar la misma publicación no le borra la gestión a sus
    // reclamos (estado, geocodificado): ver db.upsertReclamo.
    for (const reclamo of reclamos) db.upsertReclamo(reclamo, { conservarGestion: true });
    pasos.done('reclamos', reclamos.length === 1 ? '1 reclamo' : `${reclamos.length} reclamos`);
  } else {
    pasos.skip('reclamos', 'sin reclamos con ubicación');
  }

  // ---- 4) síntesis, con los números del servidor
  pasos.start('informe', 'lectura, hecho dominante y pedidos');
  // respuestas: los comentarios llegan con sus respuestas (fase G); la
  // síntesis recibe cuántas hubo y a cuántos contestó la cuenta.
  const vista = buildAnalysisView(
    { resultado: { version: 2, respuestas: true }, temas: temasV2, comentarios, analizados, postedAt: post.postedAt, comentariosTotal: post.commentsCount },
    { figuras }
  );
  const verificadosSinFicha = [...verificados].filter((u) => !conFicha.has(u) && !descartadas.has(u)).sort();
  let sintesis;
  try {
    const result = await llm.requestStructuredAnalysis({
      system: SINTESIS_SYSTEM_PROMPT,
      userPrompt: buildSynthesisPrompt({ url, post, vista, muestra: muestraParaSintesis(vista), verificadosSinFicha }),
      schema: SINTESIS_JSON_SCHEMA,
      schemaName: 'sintesis_instagram',
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    sumUsage(result.usage);
    sintesis = normalizeSynthesis(result.parsed, {
      temasValidos: new Set(temasV2.lista.map((t) => t.id)),
      // Un pedido agrupa solo comentarios que la tanda marcó PEDIDO (no un elogio de la muestra por likes).
      comentariosValidos: new Set(comentarios.filter((c) => c.tono !== null && c.tono !== 'ruido' && c.pedido === true).map((c) => c.n)),
      verificadosSinFicha: new Set(verificadosSinFicha),
    });
  } catch (err) {
    sumUsage(err && err.tokenUsage); // una síntesis fallida también se cobra
    pasos.fail('informe', 'falló la lectura');
    throw llmError(err, provider);
  }
  // Las sugerencias quedan en la tabla como "sugerida" (nunca pisan al equipo).
  for (const s of sintesis.figurasSugeridas) {
    try {
      db.upsertFiguraSugerida(s);
    } catch (err) {
      console.warn(`[analisis] no se pudo guardar la sugerencia de @${s.username}: ${err && err.message}`);
    }
  }

  return {
    sample,
    classifications,
    temas: temasV2,
    comentarios,
    sintesis,
    tonos: countTones(classifications),
    numeros: { traidos: comments.length, unicos, enviados: paraModelo.length, analizados, tandas: tandas.length, fallidas, deLaCuenta: propios },
    reclamos: reclamos.length,
    reclamosCsv: buildReclamosCsv(sample, classifications),
    tokenUsage: gasto.tokenUsage,
  };
}

module.exports = { analyzeComments, comentariosParaGuardar, claveTema, BATCH_SIZE, BATCH_CONCURRENCY, BATCH_MAX_TOKENS, MAX_TEMAS_ANALISIS };
