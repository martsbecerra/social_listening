// ==========================================================================
// server.js
// --------------------------------------------------------------------------
// Punto de entrada de la aplicación. Levanta un servidor web con Express que:
//   1) Sirve la página web (public/index.html).
//   2) Expone /api/analyze (Instagram + Apify) y /api/x/analyze (X + Grok).
// ==========================================================================

// dotenv carga las variables del archivo .env a process.env (APIFY_API_TOKEN, etc.)
require('dotenv').config();

const express = require('express');
const path = require('path');

const { scrapeInstagram } = require('./src/apify');
const { analyzeComments } = require('./src/analyzeComments');
const { resolveMaxCommentsLimit } = require('./src/commentSample');
const { isValidXPostUrl } = require('./src/x/url');
const { fetchXThread, getModel: getXaiModel, getFetchBackend } = require('./src/x/grokFetch');
const { analyzeXThread } = require('./src/x/analyze');
const { seedXInfluencersIfEmpty } = require('./src/x/influencers');
const {
  getLlmProvider,
  requiredLlmEnvKeys,
  getProviderLabel,
  getAnalysisModel,
  getClassifierModel,
} = require('./src/llm/providerConfig');
const db = require('./src/db');
const monitor = require('./src/monitor');
const { startScheduler, runCycle, getCronExpression, getLastRunAt, estimateRunsPerDay, getNextRunAt } = require('./src/scheduler');
const { processPendingReclamosInBackground } = require('./src/geoWorker');
const accountStats = require('./src/accountStats');
const { CATEGORIAS_RECLAMO, ESTADOS_RECLAMO, isValidEstado } = require('./src/categoriaReclamo');
const { subcategoriasDe } = require('./src/categoriasConfig');
const { normalizeEmail, isEmailAllowed } = require('./src/auth/allowlist');
const { issueMagicLink, redeemMagicLink } = require('./src/auth/magicLink');
const { sendMagicLinkEmail } = require('./src/mailer');
const {
  setSessionCookie,
  clearSessionCookie,
  isAuthConfigured,
} = require('./src/auth/session');
const { isMagicLinkRateLimited } = require('./src/auth/rateLimit');
const { createAuthGate } = require('./src/auth/gate');

const app = express();

const MAGIC_LINK_GENERIC = {
  ok: true,
  message: 'Si el email está autorizado, te mandamos un link. Revisá tu casilla.',
};

/** Log de alto nivel por tarea del pipeline (no por comentario). */
function logTask(phase, detail = {}) {
  const payload = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[analyze] ${phase}${payload}`);
}

function logAuth(phase, detail = {}) {
  const payload = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[auth] ${phase}${payload}`);
}

if (
  process.env.TRUST_PROXY === '1' ||
  process.env.TRUST_PROXY === 'true' ||
  (process.env.APP_BASE_URL || '').startsWith('https://')
) {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// El gate va ANTES de los estáticos: si no, dashboard.html se sirve sin cookie.
app.use(createAuthGate());
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Chequeo inicial. Antes era un console.warn y el server levantaba igual: la
// falta de una clave se descubría a mitad de un análisis, o peor, como un
// monitoreo que corría y no encontraba nada. Ahora aborta el arranque: si no
// están las credenciales, la app no puede hacer su trabajo y conviene saberlo
// en el segundo 0.
// --------------------------------------------------------------------------
function checkEnv() {
  let claimsLlm;
  try {
    claimsLlm = requiredLlmEnvKeys();
  } catch (err) {
    // LLM_PROVIDER con un valor que no entendemos (ver providerConfig.js).
    abortarArranque([err.message]);
    return;
  }

  const faltantes = [];
  if (!process.env.APIFY_API_TOKEN) faltantes.push('APIFY_API_TOKEN');
  for (const key of claimsLlm) {
    if (!process.env[key]) faltantes.push(key);
  }
  if (!process.env.SESSION_SECRET) faltantes.push('SESSION_SECRET');
  if (!process.env.APP_BASE_URL) faltantes.push('APP_BASE_URL');
  if (!process.env.SMTP_HOST) faltantes.push('SMTP_HOST');
  if (!process.env.SMTP_USER) faltantes.push('SMTP_USER');
  if (!process.env.SMTP_PASS) faltantes.push('SMTP_PASS');

  if (faltantes.length > 0) {
    const provider = getLlmProvider();
    abortarArranque([
      `Faltan estas variables en el archivo .env: ${faltantes.join(', ')}`,
      `LLM_PROVIDER está en "${provider}", que necesita: ${claimsLlm.join(', ')}.`,
      'Copiá ".env.example" como ".env" y completá tus claves.',
    ]);
  }
}

function abortarArranque(lineas) {
  console.error(`\n❌ No se puede arrancar:\n${lineas.map((l) => `    ${l}`).join('\n')}\n`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Valida que el link sea de una publicación de Instagram (post, reel o tv).
// --------------------------------------------------------------------------
function isValidInstagramPostUrl(url) {
  try {
    const u = new URL(url);
    const esInstagram = /(^|\.)instagram\.com$/.test(u.hostname);
    const esPublicacion = /^\/(p|reel|reels|tv)\/[\w-]+/.test(u.pathname);
    return esInstagram && esPublicacion;
  } catch {
    // Si new URL() falla, el texto no es una URL válida.
    return false;
  }
}

// --------------------------------------------------------------------------
// Auth: allowlist + magic link + sesión.
// --------------------------------------------------------------------------
app.post('/api/auth/magic-link', async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  logAuth('pedido de magic link', { email: email || null });

  if (isMagicLinkRateLimited({ ip, email })) {
    logAuth('rate limit', { email: email || null });
    return res.status(429).json({ error: 'Demasiados intentos. Probá en unos minutos.' });
  }

  if (!isAuthConfigured()) {
    logAuth('config incompleta', { falta: 'SESSION_SECRET o APP_BASE_URL' });
    return res.status(503).json({
      error: 'El login no está configurado. Revisá SESSION_SECRET y APP_BASE_URL.',
    });
  }

  if (!email || !isEmailAllowed(email)) {
    logAuth('email no autorizado o vacío', { email: email || null });
    return res.json(MAGIC_LINK_GENERIC);
  }

  try {
    const { rawToken } = issueMagicLink(email);
    logAuth('enviando mail', { email, smtp: process.env.SMTP_HOST || null });
    await sendMagicLinkEmail({ email, rawToken });
    logAuth('mail enviado', { email });
  } catch (err) {
    logAuth('error enviando mail', { email, message: err.message });
    console.error('[auth] Error enviando magic link:', err.message);
  }

  return res.json(MAGIC_LINK_GENERIC);
});

app.post('/api/auth/verify', (req, res) => {
  const token = (req.body && req.body.token) || '';
  const result = redeemMagicLink(token);
  if (!result.ok) {
    logAuth('verify fallido', { motivo: 'token inválido, usado o expirado' });
    return res
      .status(400)
      .type('html')
      .send(
        '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Link inválido</title></head><body>' +
        '<p>El link expiró o ya fue usado. <a href="/">Pedí uno nuevo</a>.</p></body></html>'
      );
  }
  setSessionCookie(res, result.email);
  logAuth('sesión iniciada', { email: result.email });
  return res.redirect(302, '/dashboard.html');
});

app.get('/api/auth/me', (req, res) => {
  if (!req.auth) {
    return res.status(401).json({ error: 'Tenés que iniciar sesión.' });
  }
  return res.json({ email: req.auth.email });
});

app.post('/api/auth/logout', (req, res) => {
  logAuth('logout', { email: req.auth ? req.auth.email : null });
  clearSessionCookie(res);
  return res.status(204).end();
});

// --------------------------------------------------------------------------
// Endpoint principal: recibe el link y devuelve el reporte.
// --------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body || {};
  const startedAt = Date.now();

  // 1) Validación del link.
  if (!isValidInstagramPostUrl(url)) {
    logTask('validación fallida', { url: url || null });
    return res.status(400).json({
      error: 'Ingresá un link válido de una publicación de Instagram (por ejemplo: https://www.instagram.com/p/XXXXXXXX/).',
    });
  }

  logTask('inicio', { url });

  try {
    // 2) Extraemos datos con Apify (comentarios + datos del posteo).
    logTask('extracción Apify iniciada');
    const scrapeStartedAt = Date.now();
    const { post, comments, scrapeMeta } = await scrapeInstagram(url);
    logTask('extracción Apify completada', {
      ms: Date.now() - scrapeStartedAt,
      comentariosExtraidos: comments?.length ?? 0,
      commentsLimit: scrapeMeta?.commentsLimitRequested ?? null,
      apifyItemsCrudos: scrapeMeta?.rawCommentItems ?? null,
      comentariosEnPost: scrapeMeta?.commentsOnPost ?? null,
      cuenta: post?.ownerUsername ?? null,
    });

    // 3) Si no hay comentarios, no hay nada que analizar.
    if (!comments || comments.length === 0) {
      logTask('sin comentarios', { url, msTotal: Date.now() - startedAt });
      return res.status(422).json({
        error: 'La publicación no tiene comentarios visibles o no se pudieron extraer. Probá con otra publicación.',
      });
    }

    // 4) Analizamos con el LLM configurado (devuelve reporte + CSV de reclamos).
    logTask('análisis LLM iniciado', {
      proveedor: getLlmProvider(),
      comentariosExtraidos: comments.length,
    });
    const analysisStartedAt = Date.now();
    const { report, csv, meta: analysisMeta } = await analyzeComments({ url, post, comments });
    logTask('análisis LLM completado', {
      ms: Date.now() - analysisStartedAt,
      comentariosAnalizados: analysisMeta?.sampleSize ?? comments.length,
      muestraParcial: Boolean(
        analysisMeta?.sampleSize != null &&
        analysisMeta?.totalComments != null &&
        analysisMeta.sampleSize < analysisMeta.totalComments
      ),
      tokens: analysisMeta?.tokenUsage ?? null,
      costUsd: analysisMeta?.tokenUsage?.costUsd ?? null,
      costSource: analysisMeta?.tokenUsage?.costSource ?? null,
      llmIntentos: analysisMeta?.llmAttempts ?? null,
    });

    logTask('respuesta OK', { msTotal: Date.now() - startedAt });

    // 5) Devolvemos el reporte y el CSV al navegador.
    res.json({
      report,
      csv,
      meta: {
        // Extraídos por Apify vs enviados a Claude (muestra estable en commentSample.js).
        comentariosExtraidos: comments.length,
        comentariosAnalizados: analysisMeta?.sampleSize ?? comments.length,
        comentariosUnicos: analysisMeta?.totalComments ?? comments.length,
        muestraParcial: Boolean(analysisMeta?.sampleSize < analysisMeta?.totalComments),
        tokenUsage: analysisMeta?.tokenUsage ?? null,
        llmAttempts: analysisMeta?.llmAttempts ?? null,
      },
    });

    // Los reclamos con ubicación ya quedaron guardados en 'pendiente'
    // (analyzeComments.js); geocodificarlos pega a USIG por red, así que se
    // dispara después de responder y sin esperar, para no demorar el endpoint.
    processPendingReclamosInBackground();
    return;
  } catch (err) {
    logTask('error', {
      msTotal: Date.now() - startedAt,
      message: err.message,
      fase: err.userMessage ? 'servicio externo' : 'interno',
    });
    console.error('Error en /api/analyze:', err);
    // Si alguno de nuestros servicios agregó un "userMessage" amigable, lo usamos.
    return res.status(502).json({
      error: err.userMessage || 'Ocurrió un error al procesar la publicación. Intentá de nuevo en unos minutos.',
    });
  }
});

function logXTask(phase, detail = {}) {
  const payload = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  console.log(`[analyze-x] ${phase}${payload}`);
}

app.post('/api/x/analyze', async (req, res) => {
  const { url } = req.body || {};
  const startedAt = Date.now();

  if (!isValidXPostUrl(url)) {
    logXTask('validación fallida', { url: url || null });
    return res.status(400).json({
      error: 'Ingresá un link válido de una publicación de X (por ejemplo: https://x.com/usuario/status/1234567890).',
    });
  }

  logXTask('inicio', { url });

  try {
    logXTask('extracción Grok iniciada');
    const fetchStartedAt = Date.now();
    const { post, items, usage: grokUsage, threadComplete } = await fetchXThread(url);
    logXTask('extracción Grok completada', {
      ms: Date.now() - fetchStartedAt,
      items: items?.length ?? 0,
      cuenta: post?.authorHandle ?? post?.username ?? null,
      threadComplete: threadComplete !== false,
      grokTokens: grokUsage ?? null,
    });

    const influencerMap = db.getXInfluencerMap();
    logXTask('análisis Grok iniciado', {
      modelo: getXaiModel(),
      items: items.length,
      padron: influencerMap.size,
    });
    const analysisStartedAt = Date.now();
    const { report, csv, meta: analysisMeta } = await analyzeXThread({
      url,
      post,
      items,
      influencerMap,
    });
    logXTask('análisis Grok completado', {
      ms: Date.now() - analysisStartedAt,
      itemsAnalizados: analysisMeta?.sampleSize ?? items.length,
      itemsHilo: analysisMeta?.totalComments ?? 1 + items.length,
      muestraParcial: Boolean(
        analysisMeta?.sampleSize != null &&
        analysisMeta?.totalComments != null &&
        analysisMeta.sampleSize < analysisMeta.totalComments
      ) || threadComplete === false,
      tokens: analysisMeta?.tokenUsage ?? null,
      costUsd: analysisMeta?.tokenUsage?.costUsd ?? null,
      costSource: analysisMeta?.tokenUsage?.costSource ?? null,
      llmIntentos: analysisMeta?.llmAttempts ?? null,
    });

    logXTask('respuesta OK', { msTotal: Date.now() - startedAt });

    res.json({
      report,
      csv,
      meta: {
        comentariosExtraidos: 1 + items.length,
        comentariosAnalizados: analysisMeta?.sampleSize ?? 1 + items.length,
        comentariosUnicos: analysisMeta?.totalComments ?? 1 + items.length,
        muestraParcial: Boolean(
          analysisMeta?.sampleSize != null &&
          analysisMeta?.totalComments != null &&
          analysisMeta.sampleSize < analysisMeta.totalComments
        ) || threadComplete === false,
      },
    });

    processPendingReclamosInBackground();
    return;
  } catch (err) {
    logXTask('error', {
      msTotal: Date.now() - startedAt,
      message: err.message,
      fase: err.userMessage ? 'servicio externo' : 'interno',
    });
    console.error('Error en /api/x/analyze:', err);
    const status = err.statusCode === 422 ? 422 : 502;
    return res.status(status).json({
      error: err.userMessage || 'Ocurrió un error al procesar la publicación. Intentá de nuevo en unos minutos.',
    });
  }
});

// --------------------------------------------------------------------------
// Monitoreo automático: config, tabla de posteos detectados, disparo manual.
// --------------------------------------------------------------------------
app.get('/api/monitoring/posts', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  // El límite subió de 100 a 5000: la tabla ahora pagina/filtra/ordena del
  // lado del cliente (Tabulator), así que el frontend pide todo de una vez.
  const pageSize = Math.min(5000, Math.max(1, Number(req.query.pageSize) || 20));
  const { posts, total } = db.listDetectedPosts({ page, pageSize });

  // Benchmark (mediana propia de la cuenta) para el panel desplegable de
  // cada fila. Un solo listAllAccountStats() para todo el request, no una
  // query por posteo.
  const statsMap = accountStats.buildAccountStatsMap();
  const postsWithBenchmark = posts.map((post) => ({
    ...post,
    benchmark: accountStats.classifyPostAgainstBenchmark({
      account: post.account,
      postType: post.post_type,
      likes: post.likes,
      comments: post.comments,
      statsMap,
    }),
  }));

  res.json({ posts: postsWithBenchmark, total, page, pageSize });
});

app.get('/api/monitoring/config', (req, res) => {
  res.json(monitor.loadConfig());
});

// Para la barra de acción de "Monitoreo en vivo" ("Escuchando · próxima
// corrida HH:MM") — la hora sale de la expresión cron real, no está fija.
app.get('/api/monitoring/status', (req, res) => {
  res.json({ nextRunAt: getNextRunAt(getCronExpression()).toISOString() });
});

// Menciones detectadas en los últimos 7 días, para el resumen del dashboard.
// Solo Instagram tiene scraping implementado hoy; el resto de las claves
// simplemente no viene en la respuesta.
app.get('/api/monitoring/counts', (req, res) => {
  res.json({ instagram: db.countRecentPosts(7) });
});

// Datos reales para el pie de página (footer.js en las 3 páginas): nada
// hardcodeado en el HTML/JS del cliente.
const PLATAFORMAS_SOPORTADAS = ['instagram', 'x', 'facebook', 'tiktok']; // mismas 4 tarjetas de dashboard.html
app.get('/api/footer-stats', (req, res) => {
  res.json({
    plataformaCount: PLATAFORMAS_SOPORTADAS.length,
    corridasPorDia: estimateRunsPerDay(getCronExpression()),
    categoriaCount: CATEGORIAS_RECLAMO.length,
    lastRunAt: getLastRunAt(),
  });
});

// Ignora un registro puntual de la tabla (cruz de la fila). La fila queda
// en SQLite con ignored=1 para no re-detectarlo; deja de listarse.
app.post('/api/monitoring/posts/:id/ignore', (req, res) => {
  db.ignorePost(req.params.id);
  res.json({ ok: true });
});

// Ediciones manuales de un registro de la tabla de monitoreo: el sentimiento
// (por si Haiku se equivocó) o la marca "Notificado" (un campo manual para
// llevar registro de qué ya se comunicó; el envío automático se eliminó).
// Acepta uno u otro campo por request — la UI manda de a uno.
const VALID_SENTIMENTS = ['positivo', 'neutral', 'negativo'];
app.patch('/api/monitoring/posts/:id', (req, res) => {
  const { sentiment, notified } = req.body || {};

  if (sentiment !== undefined) {
    if (!VALID_SENTIMENTS.includes(sentiment)) {
      return res.status(400).json({ error: 'Sentimiento inválido.' });
    }
    db.updateSentiment(req.params.id, sentiment);
    return res.json({ ok: true });
  }

  if (notified !== undefined) {
    if (typeof notified !== 'boolean') {
      return res.status(400).json({ error: 'notified debe ser true o false.' });
    }
    db.setNotified(req.params.id, notified);
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Nada para actualizar: mandá sentiment o notified.' });
});

app.post('/api/monitoring/accounts', async (req, res) => {
  try {
    res.json(await monitor.addAccount(req.body && req.body.account));
  } catch (err) {
    res.status(400).json({ error: err.userMessage || err.message });
  }
});

app.delete('/api/monitoring/accounts/:account', (req, res) => {
  res.json(monitor.removeAccount(req.params.account));
});

app.post('/api/monitoring/keywords', async (req, res) => {
  try {
    res.json(await monitor.addKeyword(req.body && req.body.keyword));
  } catch (err) {
    res.status(400).json({ error: err.userMessage || err.message });
  }
});

app.delete('/api/monitoring/keywords/:keyword', (req, res) => {
  res.json(monitor.removeKeyword(req.params.keyword));
});

// Dispara un ciclo de monitoreo a mano, sin esperar los 4hs del cron
// (útil para probar o para una demo).
app.post('/api/monitoring/run-now', async (req, res) => {
  try {
    const result = await runCycle();
    res.json(result);
  } catch (err) {
    if (err.code === 'CYCLE_IN_PROGRESS') {
      return res.status(409).json({ error: err.userMessage });
    }
    console.error('Error en /api/monitoring/run-now:', err);
    res.status(502).json({ error: err.userMessage || 'Falló el ciclo de monitoreo. Revisá la consola del servidor.' });
  }
});

// Genera título + sentimiento para posteos guardados que todavía no lo
// tienen (posteos de antes de esta funcionalidad, o que fallaron al clasificar).
app.post('/api/monitoring/backfill-classification', async (req, res) => {
  try {
    const result = await monitor.backfillClassification();
    res.json(result);
  } catch (err) {
    console.error('Error en /api/monitoring/backfill-classification:', err);
    res.status(502).json({ error: err.userMessage || 'Falló la clasificación. Revisá la consola del servidor.' });
  }
});

// --------------------------------------------------------------------------
// Mapa de reclamos: filtros combinables + edición de estado + export CSV.
// --------------------------------------------------------------------------

/** Query params compartidos por el GET y el export CSV. */
function parseReclamosFilters(query) {
  const toList = (v) => {
    if (v == null || v === '') return undefined;
    return Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
  };
  return {
    categoria: toList(query.categoria),
    subcategoria: toList(query.subcategoria),
    estado: toList(query.estado),
    barrio: query.barrio || undefined,
    comuna: query.comuna || undefined,
    desde: query.desde || undefined,
    hasta: query.hasta || undefined,
    q: query.q || undefined,
  };
}

app.get('/api/reclamos', (req, res) => {
  const reclamos = db.listReclamosFiltered(parseReclamosFilters(req.query));
  res.json({
    categorias: CATEGORIAS_RECLAMO,
    estados: ESTADOS_RECLAMO,
    // Árbol categoría -> subcategorías, para poblar el filtro dependiente.
    subcategoriasPorCategoria: Object.fromEntries(
      CATEGORIAS_RECLAMO.map((c) => [c, subcategoriasDe(c)])
    ),
    // Conteo por categoría sobre TODA la base, no sobre lo filtrado: el mapa
    // asigna sus 12 colores a las categorías más frecuentes, y ese ranking no
    // puede cambiar cada vez que el usuario toca un filtro — los pines
    // cambiarían de color solos.
    conteoPorCategoria: db.contarReclamosPorCategoria(),
    reclamos,
  });
});

// Edita solo el estado del reclamo (Pendiente | En tratamiento | Resuelto | Desestimado).
app.patch('/api/reclamos/:id', (req, res) => {
  const { estado } = req.body || {};
  if (!isValidEstado(estado)) {
    return res.status(400).json({ error: 'Estado inválido.' });
  }
  db.updateEstado(req.params.id, estado);
  res.json({ ok: true });
});

function escapeCsvField(value) {
  const s = value == null ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

const RECLAMOS_CSV_HEADER = [
  'id', 'plataforma', 'categoria', 'estado', 'direccion_normalizada', 'calle',
  'altura', 'cruce', 'barrio', 'comuna', 'autor', 'fecha', 'texto_original', 'post_url',
];

// Exporta TODOS los reclamos que pasan los filtros activos (no solo lo
// visible en el mapa): mismos query params que GET /api/reclamos.
app.get('/api/reclamos/export.csv', (req, res) => {
  const reclamos = db.listReclamosFiltered(parseReclamosFilters(req.query));
  const rows = [RECLAMOS_CSV_HEADER.map(escapeCsvField).join(';')];
  for (const r of reclamos) {
    rows.push(
      [
        r.id, r.plataforma, r.categoria, r.estado, r.direccionNormalizada, r.calle,
        r.altura, r.cruce, r.barrio, r.comuna, r.autor, r.fecha, r.textoOriginal, r.postUrl,
      ]
        .map(escapeCsvField)
        .join(';')
    );
  }
  // BOM UTF-8 explícito: el CSV tiene tildes y emojis, y sin BOM Excel en
  // Windows lo abre mal interpretado como ANSI.
  const csv = '﻿' + rows.join('\n') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reclamos.csv"');
  res.send(csv);
});

// --------------------------------------------------------------------------
// Arrancamos el servidor.
// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
checkEnv();
try {
  const seed = seedXInfluencersIfEmpty();
  if (seed.seeded) {
    console.log(`[x] padrón ANTIK-PRO cargado: ${seed.total} handles`);
  }
} catch (err) {
  console.warn('[x] no se pudo cargar el padrón ANTIK-PRO:', err.message);
}
startScheduler();
const server = app.listen(PORT, () => {
  const provider = getLlmProvider();
  console.log(`\n✅ Servidor listo en http://localhost:${PORT}`);
  console.log(`   Proveedor LLM: ${getProviderLabel(provider)} (${provider})`);
  console.log(`   Modelo análisis: ${getAnalysisModel(provider)}`);
  console.log(`   Modelo clasificador: ${getClassifierModel(provider)}`);
  const grokBackend = getFetchBackend();
  const grokHint =
    grokBackend === 'openrouter'
      ? 'OpenRouter'
      : grokBackend === 'xai'
        ? 'xAI directo'
        : 'sin clave (OPENROUTER_API_KEY o XAI_API_KEY)';
  console.log(`   Modelo Grok (X): ${getXaiModel()} · ${grokHint}`);
  console.log(
    `   Límites: COMMENTS_LIMIT (Apify)=${process.env.COMMENTS_LIMIT || 100}, COMMENTS_ANALYSIS_LIMIT (LLM)=${resolveMaxCommentsLimit()}`
  );
  console.log(
    `   Login: APP_BASE_URL=${process.env.APP_BASE_URL || '(falta)'} | SMTP=${process.env.SMTP_HOST || '(falta SMTP_HOST)'}\n`
  );
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n❌ El puerto ${PORT} ya está en uso.` +
      `\n   Liberálo con: npm run stop\n`
    );
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n${signal} recibido. Cerrando servidor...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
