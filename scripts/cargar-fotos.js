// ==========================================================================
// cargar-fotos.js — Carga única de las fotos de los posteos ya guardados.
// --------------------------------------------------------------------------
// La app baja la foto de un posteo cuando lo detecta y cuando le toca el
// refresco de métricas (ver "Fotos de los posteos" en el README): los posteos
// que ya estaban en la base se van completando de a 150 por ciclo, y los de
// más de 60 días no la reciben nunca. Este script las trae todas de una vez.
//
//   node scripts/cargar-fotos.js                 # SOLO INFORMA: cuántos posteos, lotes y costo
//   node scripts/cargar-fotos.js --si --max 5    # prueba con 5 posteos
//   node scripts/cargar-fotos.js --si            # carga completa
//
//   --max N     a lo sumo N posteos (los más recientes primero)
//   --lote N    URLs por pedido a Apify (50; máximo 100)
//
// Sin --si no llama a Apify, no baja nada y no escribe nada: abre la base en
// solo lectura (ni siquiera corre la migración de las columnas de fotos).
//
// Con --si GASTA EN APIFY: pide cada posteo sin foto por su URL al actor
// oficial (apify/instagram-scraper, el mismo camino del refresco por URL:
// instagram.fetchPostDetails), en lotes y de a uno, y con cada respuesta baja
// las fotos con el código de la app (src/postImageSync.js: mismas reglas de
// descarga, mismos estados). Se cobra por resultado devuelto (0,0023 usd por
// posteo en el plan Starter). Cada llamada queda en apify_calls con la fase
// 'fotos' (npm run gastos la muestra entre las "otras").
//
// Qué NO toca: likes, comentarios, cadencias ni marcas del refresco. Solo las
// columnas image_* y la carpeta data/media. El refresco de siempre va a
// volver a pedir esos posteos por sus métricas cuando les toque.
//
// Resguardos:
//   - la app tiene que estar apagada (dos procesos bajando las mismas fotos
//     se pisan); si algo responde en su puerto, no arranca;
//   - frena en el primer lote que falle, si se agota la cuota, si el actor
//     no devuelve ninguno de los posteos pedidos o si no se pudo guardar
//     ninguna foto del lote: no sigue gastando si algo anda mal;
//   - se puede cortar y volver a correr: saltea los posteos que ya tienen
//     sus copias;
//   - lo que quede "pendiente" (fallo pasajero) lo reintenta la app sola al
//     empezar su próximo ciclo, con el link ya guardado.
//
// Con --si se carga src/db.js: abre la base en escritura y, si todavía no
// las tiene, agrega las columnas de fotos (la misma migración que corre al
// arrancar la app). Hacer el backup antes.
// ==========================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// No abre la base: descarga, copias y dónde van los archivos.
const postImages = require('../src/postImages');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'monitoring.db');
const DEFAULT_PLATFORM = 'instagram';
const DEFAULT_LOT = 50;
// El endpoint sincrónico de Apify corta a los 300 s: mismo techo que el
// refresco por URL (REFRESH_URLS_PER_RUN).
const MAX_LOT = 100;
const PHASE = 'fotos';
// Tarifas del actor oficial, usd por 1000 resultados: las mismas de
// src/apifyCost.js (que no se puede cargar acá sin abrir la base). El test
// comprueba que coincidan.
const OFFICIAL_RATES = { free: 2.7, starter: 2.3, scale: 1.9 };

const USAGE = `Uso:
  node scripts/cargar-fotos.js                 solo informa (no gasta ni escribe nada)
  node scripts/cargar-fotos.js --si --max 5    prueba con 5 posteos
  node scripts/cargar-fotos.js --si            carga completa

Opciones:
  --si          ejecuta: llama a Apify y baja las fotos
  --max N       a lo sumo N posteos (los más recientes primero)
  --lote N      URLs por pedido a Apify (${DEFAULT_LOT}; máximo ${MAX_LOT})
  --ayuda       muestra esto`;

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const out = { si: false, max: null, lot: DEFAULT_LOT, help: false, error: null };
  const numberOf = (name, raw) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      out.error = `${name} necesita un número entero mayor que cero.`;
      return null;
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const [name, inline] = String(args[i]).split('=');
    const value = () => (inline !== undefined ? inline : args[(i += 1)]);
    if (name === '--si') out.si = true;
    else if (name === '--ayuda' || name === '--help' || name === '-h') out.help = true;
    else if (name === '--max') out.max = numberOf('--max', value());
    else if (name === '--lote') {
      const lot = numberOf('--lote', value());
      if (lot !== null) {
        if (lot > MAX_LOT) out.error = `--lote no puede pasar de ${MAX_LOT}.`;
        else out.lot = lot;
      }
    } else out.error = `Opción desconocida: ${args[i]}`;
    if (out.error) break;
  }
  return out;
}

/** Código del posteo en su URL (/p/{code}/, /reel/{code}/): lo mismo que monitor.postCodeOf. */
function postCode(url) {
  const match = /\/(?:p|reel|reels|tv)\/([^/?#]+)/.exec(String(url || ''));
  return match ? match[1] : null;
}

/** Tarifa del actor oficial por posteo, con el plan y las tarifas del .env. */
function officialRate(env = process.env) {
  const raw = String(env.APIFY_PLAN || 'starter').trim().toLowerCase();
  const plan = Object.prototype.hasOwnProperty.call(OFFICIAL_RATES, raw) ? raw : 'starter';
  const override = env[`APIFY_RATE_${plan.toUpperCase()}`];
  const value = override === undefined || override === '' ? NaN : Number(override);
  const per1000 = Number.isFinite(value) && value >= 0 ? value : OFFICIAL_RATES[plan];
  return { plan, perPost: per1000 / 1000 };
}

// Montos chicos (la prueba de 5 posteos) con cuatro decimales: con dos, 0,0115 se leería 0,01.
const usd = (value) => `US$ ${(value < 0.1 ? value.toFixed(4) : value.toFixed(2)).replace('.', ',')}`;
const dateOnly = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : 's/f');

/**
 * Qué posteos hay que pedir. Función pura sobre las filas de detected_posts
 * (visibles, de una plataforma): la usan el informe y la carga.
 * @param {object[]} rows filas con id, url, posted_at, detected_at e image_saved_at (si la columna existe)
 * @returns {{ total: number, withPhoto: number, withoutCode: number, toRequest: {id: string, url: string, postedAt: string|null}[] }}
 */
function classifyPosts(rows, { plataforma, mediaDir } = {}) {
  const sorted = [...rows].sort((a, b) => String(b.posted_at || b.detected_at || '').localeCompare(String(a.posted_at || a.detected_at || '')));
  let withPhoto = 0;
  let withoutCode = 0;
  const toRequest = [];
  for (const row of sorted) {
    const id = String(row.id);
    // "Tiene foto": la marca de la base Y los dos archivos en disco.
    if (row.image_saved_at && postImages.hasLocalCopy(plataforma, id, mediaDir)) {
      withPhoto += 1;
      continue;
    }
    // El actor no acepta una URL armada con el id numérico: solo las que
    // traen el código del posteo.
    if (!postCode(row.url)) {
      withoutCode += 1;
      continue;
    }
    toRequest.push({ id, url: row.url, postedAt: row.posted_at || null });
  }
  return { total: rows.length, withPhoto, withoutCode, toRequest };
}

function splitInLots(list, size) {
  const lots = [];
  for (let i = 0; i < list.length; i += size) lots.push(list.slice(i, i + size));
  return lots;
}

/**
 * El plan de la carga, leyendo la base en SOLO LECTURA (no carga src/db.js:
 * no migra ni escribe nada).
 */
function planLoad({ dbPath = process.env.MONITORING_DB_PATH || DEFAULT_DB_PATH, plataforma = DEFAULT_PLATFORM, max = null, lot = DEFAULT_LOT, mediaDir, env = process.env } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`No existe la base: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  let rows;
  let migrated;
  try {
    const columns = db.prepare('PRAGMA table_info(detected_posts)').all().map((c) => c.name);
    if (columns.length === 0) throw new Error(`La base no tiene la tabla detected_posts: ${dbPath}`);
    migrated = columns.includes('image_saved_at');
    rows = db
      .prepare(`SELECT id, url, posted_at, detected_at${migrated ? ', image_saved_at' : ''} FROM detected_posts WHERE plataforma = ? AND ignored = 0`)
      .all(plataforma);
  } finally {
    db.close();
  }
  const classified = classifyPosts(rows, { plataforma, mediaDir });
  const selected = max ? classified.toRequest.slice(0, max) : classified.toRequest;
  const rate = officialRate(env);
  const lots = splitInLots(selected, lot);
  return {
    dbPath,
    plataforma,
    migrated,
    total: classified.total,
    withPhoto: classified.withPhoto,
    withoutCode: classified.withoutCode,
    pending: classified.toRequest.length,
    selected: selected.length,
    lots: lots.length,
    lotSize: lot,
    plan: rate.plan,
    perPost: rate.perPost,
    maxUsd: selected.length * rate.perPost,
    // Medido en el detalle de búsquedas: unos 5 s fijos por pedido y medio
    // segundo por URL; más la descarga de cada foto.
    estimatedSeconds: Math.round(lots.length * 8 + selected.length * 0.9),
    newest: selected.length ? selected[0].postedAt : null,
    oldest: selected.length ? selected[selected.length - 1].postedAt : null,
    enabled: postImages.isEnabled(),
  };
}

function formatPlan(plan, { si = false } = {}) {
  const row = (label, value) => `  ${`${label} `.padEnd(30, '.')} ${String(value).padStart(5)}`;
  const minutes = Math.max(1, Math.round(plan.estimatedSeconds / 60));
  const lines = [
    `Carga única de fotos · ${plan.plataforma} · ${si ? 'EJECUCIÓN' : 'SOLO INFORMA (no llama a Apify, no baja nada, no escribe nada)'}`,
    '',
    `Base: ${plan.dbPath}${si ? '' : ' (abierta en solo lectura)'}`,
  ];
  if (!plan.migrated) lines.push('  Todavía no tiene las columnas de fotos: se agregan solas al correr con --si o al arrancar la app.');
  lines.push(
    '',
    row('Posteos visibles', plan.total),
    row('  ya tienen foto', plan.withPhoto),
    row('  sin dirección utilizable', plan.withoutCode),
    row('  sin foto, para pedir', plan.pending)
  );
  if (plan.selected !== plan.pending) lines.push(row('  en esta corrida (--max)', plan.selected));
  lines.push('');
  if (plan.selected === 0) {
    lines.push('No hay nada para pedir.');
    return lines.join('\n');
  }
  lines.push(
    `Posteos a pedir: ${plan.selected}, publicados entre el ${dateOnly(plan.oldest)} y el ${dateOnly(plan.newest)}.`,
    'Actor: apify/instagram-scraper, detalle por URL (el mismo camino del refresco de métricas).',
    `Pedidos a Apify: ${plan.lots} lote(s) de hasta ${plan.lotSize} URLs, de a uno.`,
    `Costo: hasta ${usd(plan.maxUsd)} (${plan.selected} × ${String(plan.perPost).replace('.', ',')} usd, plan ${plan.plan}; se cobra por resultado devuelto).`,
    `Tiempo: unos ${minutes} minuto(s).`,
    'No toca likes, comentarios ni las cadencias del refresco: solo las fotos.'
  );
  if (!plan.enabled) lines.push('', 'OJO: las fotos están apagadas (POST_IMAGES=0, o falta sharp). Así no se puede cargar nada.');
  if (!si) {
    lines.push(
      '',
      'Para ejecutar (GASTA EN APIFY; con la app apagada):',
      `  node scripts/cargar-fotos.js --si --max 5     prueba con 5 posteos (hasta ${usd(Math.min(5, plan.pending) * plan.perPost)})`,
      `  node scripts/cargar-fotos.js --si             carga completa (hasta ${usd(plan.pending * plan.perPost)})`
    );
  }
  return lines.join('\n');
}

/** ¿Responde algo en el puerto de la app? */
async function isAppRunning(port = process.env.PORT || 3000) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/auth/me`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * La carga. GASTA EN APIFY. Nunca tira: devuelve cómo salió.
 *
 * @param {{ plataforma?: string, max?: number|null, lot?: number, out?: (line: string) => void }} [options]
 * @returns {Promise<{ ok: boolean, stopped: string|null, lots: object[], totals: object }>} ok:
 *   se pidieron todos los lotes. stopped: por qué se frenó, o null.
 */
async function runLoad({ plataforma = DEFAULT_PLATFORM, max = null, lot = DEFAULT_LOT, out = console.log } = {}) {
  const totals = { requested: 0, answered: 0, missing: 0, withoutLink: 0, saved: 0, alreadySaved: 0, expired: 0, failed: 0, pending: 0, lots: 0 };
  const lotsDone = [];
  const stop = (reason) => ({ ok: false, stopped: reason, lots: lotsDone, totals });

  if (!Object.prototype.hasOwnProperty.call(postImages.IMAGE_HOSTS, plataforma)) return stop(`La plataforma "${plataforma}" no tiene fotos.`);
  if (!postImages.isEnabled()) return stop('Las fotos están apagadas (POST_IMAGES=0, o falta sharp): no se carga nada.');

  // Recién acá se abre la base en escritura (y corre la migración de las
  // columnas de fotos si hace falta).
  const db = require('../src/db');
  const { getPlatform } = require('../src/platforms');
  const { isQuotaExceeded } = require('../src/platforms/errors');
  const { runWithContext } = require('../src/usageContext');
  const postImageSync = require('../src/postImageSync');

  const platform = getPlatform(plataforma);
  if (!platform || typeof platform.fetchPostDetails !== 'function') return stop(`La plataforma "${plataforma}" no tiene detalle por URL.`);
  if (typeof platform.isConfigured === 'function' && !platform.isConfigured()) return stop('Falta la credencial de Apify (APIFY_API_TOKEN en .env).');

  const { posts } = db.listDetectedPosts({ page: 1, pageSize: 1000000, plataforma });
  const classified = classifyPosts(posts, { plataforma });
  const selected = max ? classified.toRequest.slice(0, max) : classified.toRequest;
  const lots = splitInLots(selected, Math.min(Math.max(1, lot), MAX_LOT));
  if (selected.length === 0) {
    out('No hay posteos sin foto para pedir.');
    return { ok: true, stopped: null, lots: lotsDone, totals };
  }

  for (let index = 0; index < lots.length; index += 1) {
    const batch = lots[index];
    const name = `lote ${index + 1}/${lots.length}`;
    let details;
    try {
      // Con su fase, para que la llamada quede identificada en apify_calls.
      details = await runWithContext({ runId: null, phase: PHASE }, () => platform.fetchPostDetails(batch.map((post) => post.url)));
    } catch (err) {
      const reason = isQuotaExceeded(err) ? 'se agotó la cuota de Apify' : `falló el pedido a Apify (${err && err.message})`;
      out(`${name}: ${reason}. No se pidió nada más.`);
      return stop(`${name}: ${reason}`);
    }
    totals.lots += 1;
    totals.requested += batch.length;

    // Cruce por id y, de respaldo, por el código de la URL (igual que el
    // refresco por URL: los items vuelven en cualquier orden).
    const byId = new Map();
    const byCode = new Map();
    for (const detail of Array.isArray(details) ? details : []) {
      if (!detail) continue;
      if (detail.id) byId.set(String(detail.id), detail);
      const code = postCode(detail.url);
      if (code) byCode.set(code, detail);
    }
    const items = [];
    let answered = 0;
    let withoutLink = 0;
    for (const post of batch) {
      const detail = byId.get(post.id) || byCode.get(postCode(post.url));
      if (!detail) continue;
      answered += 1;
      if (typeof detail.imageUrl === 'string' && detail.imageUrl.trim()) items.push({ id: post.id, url: detail.imageUrl });
      else withoutLink += 1;
    }
    const missing = batch.length - answered;

    // La descarga y la anotación, con el código de la app. Nunca tira.
    const stats = await postImageSync.syncPostImages(plataforma, items);

    totals.answered += answered;
    totals.missing += missing;
    totals.withoutLink += withoutLink;
    for (const key of ['saved', 'alreadySaved', 'expired', 'failed', 'pending']) totals[key] += stats[key];
    lotsDone.push({ requested: batch.length, answered, missing, withoutLink, ...stats });

    const extras = [];
    if (missing > 0) extras.push(`${missing} sin respuesta`);
    if (withoutLink > 0) extras.push(`${withoutLink} sin link de imagen`);
    if (stats.alreadySaved > 0) extras.push(`${stats.alreadySaved} ya estaban`);
    if (stats.expired > 0) extras.push(`${stats.expired} con el link vencido`);
    if (stats.failed > 0) extras.push(`${stats.failed} con error`);
    if (stats.pending > 0) extras.push(`${stats.pending} pendientes`);
    out(`${name}: ${batch.length} pedidos, ${answered} respondieron → ${stats.saved} fotos guardadas${extras.length ? ` (${extras.join(', ')})` : ''}.`);

    // No seguir gastando si algo anda mal.
    if (answered === 0) return stop(`${name}: el actor no devolvió ninguno de los posteos pedidos`);
    if (items.length > 0 && stats.saved + stats.alreadySaved === 0) return stop(`${name}: no se pudo guardar ninguna foto del lote (mirá los renglones [imagenes] de arriba)`);
  }
  return { ok: true, stopped: null, lots: lotsDone, totals };
}

function formatSummary(result, { perPost }) {
  const t = result.totals;
  const lines = [
    '',
    result.ok ? 'Carga terminada.' : `Carga FRENADA: ${result.stopped}.`,
    `  Pedidos a Apify: ${t.lots} lote(s), ${t.requested} posteos. Respondieron ${t.answered}; sin respuesta ${t.missing}; sin link de imagen ${t.withoutLink}.`,
    `  Fotos: ${t.saved} guardadas, ${t.alreadySaved} ya estaban, ${t.expired} con el link vencido, ${t.failed} con error, ${t.pending} pendientes.`,
    `  Gasto estimado: hasta ${usd(t.requested * perPost)} (${t.requested} × ${String(perPost).replace('.', ',')} usd). El registro exacto: npm run gastos.`,
  ];
  if (t.pending > 0) lines.push('  Las pendientes las reintenta la app sola al empezar su próximo ciclo, con el link ya guardado.');
  if (!result.ok) lines.push('  Se puede volver a correr: saltea los posteos que ya tienen su foto.');
  return lines.join('\n');
}

/**
 * @param {string[]} [argv]
 * @param {object} [deps] para los tests: out (dónde escribe), appRunning
 *   (¿está la app prendida?) y loadEnv (carga del .env).
 * @returns {Promise<number>} código de salida.
 */
async function main(argv = process.argv, { out = console.log, appRunning = isAppRunning, loadEnv = () => require('dotenv').config() } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return 0;
  }
  if (args.error) {
    out(`${args.error}\n\n${USAGE}`);
    return 1;
  }
  loadEnv(); // plan de Apify, tarifas y, para la carga, el token

  let plan;
  try {
    plan = planLoad({ max: args.max, lot: args.lot });
  } catch (err) {
    out(err.message);
    return 1;
  }
  out(formatPlan(plan, { si: args.si }));
  if (!args.si) return 0;
  if (plan.selected === 0) return 0;

  if (await appRunning()) {
    out('\nLa app está corriendo (algo responde en su puerto). Apagala antes de cargar las fotos: no se pidió nada.');
    return 1;
  }
  out('');
  const result = await runLoad({ max: args.max, lot: args.lot, out });
  out(formatSummary(result, { perPost: plan.perPost }));
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('Error inesperado en la carga de fotos:', err);
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, postCode, officialRate, classifyPosts, planLoad, formatPlan, runLoad, formatSummary, main, isAppRunning, DEFAULT_LOT, MAX_LOT, PHASE, OFFICIAL_RATES };
