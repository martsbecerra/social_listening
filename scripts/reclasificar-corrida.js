// ==========================================================================
// reclasificar-corrida.js — Clasifica de nuevo lo que una corrida guardó sin
// clasificar.
// --------------------------------------------------------------------------
// El 25/11/2026 la clave de OpenRouter venció y la corrida #61 guardó sus
// 1.183 publicaciones nuevas "sin clasificar" (la regla de nunca descartar en
// silencio). El backfill de siempre las completaría, pero no saca las que el
// modelo dice que no son relevantes: quedarían a la vista. Este script hace
// con cada una lo que habría hecho el ciclo:
//
//   - relevante: título, tono, tema y motivo, como los deja el ciclo (el
//     mismo camino: monitor.evaluateRelevance, con su término de búsqueda, la
//     línea AUTOR, la foto de respaldo y el tope de 2000);
//   - no relevante: sale de detected_posts (y sus fotos, si nadie más las
//     usa) y queda en search_seen como `descartado`, con el motivo y el
//     costo: no vuelve como nueva y Estadísticas la sigue contando;
//   - de una cuenta excluida: sale como `excluido`, sin pasar por el modelo;
//   - con el tono puesto a mano (una persona lo eligió en el selector: estas
//     filas se guardaron sin tono): no se borra aunque el modelo diga que no
//     es relevante, queda como está y se informa; si es relevante, se
//     completa sin tocar ese tono;
//   - si el modelo falla, queda como estaba (y con 3 fallas seguidas, frena).
//
//   node scripts/reclasificar-corrida.js --corrida 61          SOLO INFORMA
//   node scripts/reclasificar-corrida.js --corrida 61 --si     clasifica (GASTA en el modelo)
//
// Sin --si no llama al modelo ni escribe nada: abre la base en solo lectura y
// no carga src/db.js. Con --si, antes de escribir: la app tiene que estar
// apagada (mira /health en [::1] y 127.0.0.1, por la forma de la respuesta:
// otra app en el 127.0.0.1:3000 no cuenta), la clave del modelo tiene que
// andar (una lectura gratis) y hace un backup nuevo y verificado de la base.
// Se puede cortar y volver a correr: solo toma lo que sigue sin clasificar.
// ==========================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Puro: el corte de texto corto de la foto de respaldo (no abre la base).
const { textoCorto, MAX_POR_CICLO_DEFAULT } = require('../src/clasificadorFoto');

const PLATAFORMA = 'instagram';
const TOPE_DEFAULT_USD = 16;
const CONCURRENCIA_DEFAULT = 4;
const MAX_CONCURRENCIA = 8;
const FALLAS_SEGUIDAS_MAX = 3;
// Lo medido (noviembre 2026): una clasificación ≈ US$ 0,012; la portada suma
// unos 800 tokens (≈ 0,0024); una segunda llamada con foto, ≈ 0,0145. Para el
// informe y para no lanzar una llamada que pase el tope.
const USD_POR_CLASIFICACION = 0.012;
const USD_FOTO_EXTRA = 0.0024;
const USD_SEGUNDA_LLAMADA = 0.0145;
const PROPORCION_SEGUNDAS = 0.03;
const RESERVA_POR_LLAMADA = 0.03;

const USO = `Uso:
  node scripts/reclasificar-corrida.js --corrida N            solo informa (no gasta ni escribe)
  node scripts/reclasificar-corrida.js --corrida N --si       clasifica y guarda (gasta en el modelo)

Opciones:
  --corrida N        la corrida (monitoring_runs.id) cuyas sin clasificar se reclasifican
  --si               ejecuta: llama al modelo y escribe en la base (hace un backup antes)
  --tope USD         frena antes de pasar este gasto del modelo (${TOPE_DEFAULT_USD})
  --concurrencia N   clasificaciones a la vez (${CONCURRENCIA_DEFAULT}; máximo ${MAX_CONCURRENCIA})
  --fotos N          tope de clasificaciones con foto (por defecto, CLASIFICADOR_FOTO_MAX por cada 200)
  --ayuda            muestra esto`;

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const out = { si: false, help: false, corrida: null, tope: TOPE_DEFAULT_USD, concurrencia: CONCURRENCIA_DEFAULT, fotos: null, error: null };
  const numero = (flag, valor, { entero = true, min = 1 } = {}) => {
    const n = Number(valor);
    if (valor === undefined || !Number.isFinite(n) || n < min || (entero && !Number.isInteger(n))) {
      out.error = `${flag} necesita un número${entero ? ' entero' : ''} mayor o igual que ${min}.`;
      return null;
    }
    return n;
  };
  for (let i = 0; i < args.length && !out.error; i += 1) {
    const a = args[i];
    if (a === '--si') out.si = true;
    else if (a === '--ayuda' || a === '-h' || a === '--help') out.help = true;
    else if (a === '--corrida') out.corrida = numero(a, args[++i]);
    else if (a === '--tope') out.tope = numero(a, args[++i], { entero: false, min: 0.01 });
    else if (a === '--concurrencia') out.concurrencia = Math.min(MAX_CONCURRENCIA, numero(a, args[++i]) || CONCURRENCIA_DEFAULT);
    else if (a === '--fotos') out.fotos = numero(a, args[++i], { min: 0 });
    else out.error = `Opción desconocida: ${a}`;
  }
  if (!out.error && !out.help && out.corrida == null) out.error = 'Falta --corrida N.';
  return out;
}

/** El término de búsqueda del motivo ("Búsqueda: <término> (…)" o "… — sin clasificar"). */
function terminoDe(matchedReason) {
  const m = /^Búsqueda: (.+?)(?: \(| —|$)/.exec(String(matchedReason || ''));
  return m ? m[1] : null;
}

/** Lo que va a pasar, de la base en solo lectura (no carga src/db.js). */
function planear({ dbPath, corrida, fotos }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const run = db.prepare('SELECT id, started_at, finished_at FROM monitoring_runs WHERE id = ?').get(corrida);
    if (!run) throw new Error(`No existe la corrida #${corrida}.`);
    if (!run.finished_at) throw new Error(`La corrida #${corrida} no terminó: no hay ventana que reclasificar.`);
    const filas = db
      .prepare(`
        SELECT id, account, caption, sentiment, matched_reason AS matchedReason FROM detected_posts
        WHERE plataforma = ? AND ignored = 0 AND title IS NULL AND detected_at >= ? AND detected_at <= ?
          AND matched_reason LIKE '% — sin clasificar%'`)
      .all(PLATAFORMA, run.started_at, run.finished_at);
    let excluidas = new Set();
    try {
      excluidas = new Set(db.prepare('SELECT cuenta FROM cuentas_excluidas WHERE plataforma = ?').all(PLATAFORMA).map((r) => r.cuenta));
    } catch {
      excluidas = new Set(); // base anterior a la tabla
    }
    const porTermino = {};
    let cortas = 0;
    let tonoAMano = 0;
    let deExcluidas = 0;
    for (const f of filas) {
      const t = terminoDe(f.matchedReason) || '(sin término)';
      porTermino[t] = (porTermino[t] || 0) + 1;
      if (f.sentiment) tonoAMano += 1;
      if (excluidas.has(String(f.account || '').trim().replace(/^@+/, '').toLowerCase())) deExcluidas += 1;
      else if (textoCorto(f.caption)) cortas += 1;
    }
    const aClasificar = filas.length - deExcluidas;
    const topeFotos = fotos != null ? fotos : MAX_POR_CICLO_DEFAULT * Math.max(1, Math.ceil(aClasificar / 200));
    const conFoto = Math.min(cortas, topeFotos);
    const estimado =
      aClasificar * USD_POR_CLASIFICACION + conFoto * USD_FOTO_EXTRA + Math.round(aClasificar * PROPORCION_SEGUNDAS) * USD_SEGUNDA_LLAMADA;
    return { run, total: filas.length, aClasificar, deExcluidas, tonoAMano, cortas, conFoto, topeFotos, porTermino, estimado };
  } finally {
    db.close();
  }
}

const usd = (n) => `US$ ${Number(n).toFixed(2).replace('.', ',')}`;

function formatPlan(plan, { si, tope }) {
  const lineas = [
    `Corrida #${plan.run.id} (${plan.run.started_at} → ${plan.run.finished_at}): ${plan.total} publicación/es sin clasificar.`,
    ...Object.entries(plan.porTermino)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `  ${t}: ${n}`),
    `De cuentas excluidas (salen sin pasar por el modelo): ${plan.deExcluidas}`,
    `Con el tono puesto a mano (no se borran): ${plan.tonoAMano}`,
    `Con texto corto (van con la foto, hasta ${plan.topeFotos}): ${plan.cortas}`,
    `Al modelo: ${plan.aClasificar} · costo estimado ${usd(plan.estimado)} (tope ${usd(tope)})`,
  ];
  if (!si && plan.total > 0) lineas.push('', `Para hacerlo: node scripts/reclasificar-corrida.js --corrida ${plan.run.id} --si`);
  return lineas.join('\n');
}

/** ¿Está corriendo la app? /health de ESTA app (forma { status, db, uptime }) en [::1] o en 127.0.0.1. */
async function appCorriendo(port = process.env.PORT || 3000) {
  for (const host of ['[::1]', '127.0.0.1']) {
    try {
      const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2000) });
      const body = await r.json().catch(() => null);
      if (body && typeof body === 'object' && 'status' in body && 'db' in body && 'uptime' in body) return true;
    } catch {
      /* nada en ese host */
    }
  }
  return false;
}

/** ¿Anda la clave del modelo? Con OpenRouter, GET /key (gratis). Con otro proveedor, no se mira. */
async function claveAnda() {
  if (String(process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase() !== 'openrouter') return { ok: true, motivo: 'no es OpenRouter: no se mira' };
  const clave = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!clave) return { ok: false, motivo: 'falta la clave de OpenRouter' };
  const base = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/key`, { headers: { Authorization: `Bearer ${clave}` }, signal: AbortSignal.timeout(15000) });
    return r.ok ? { ok: true } : { ok: false, motivo: `OpenRouter respondió ${r.status}` };
  } catch (err) {
    return { ok: false, motivo: 'no se pudo consultar OpenRouter' };
  }
}

/** Backup nuevo de la base con verificación (integridad y mismas filas). Tira si algo no cierra. */
async function backupVerificado(dbPath, { corrida, backupDir = path.join(path.dirname(dbPath), 'backups'), ahora = new Date() } = {}) {
  const { backup } = require('node:sqlite');
  fs.mkdirSync(backupDir, { recursive: true });
  const sello = new Date(ahora).toISOString().replace(/[:.]/g, '-');
  // Nunca se pisa uno anterior: con el mismo sello, un sufijo.
  let destino = path.join(backupDir, `monitoring-${sello}-antes-de-reclasificar-${corrida}.db`);
  for (let i = 2; fs.existsSync(destino); i += 1) destino = path.join(backupDir, `monitoring-${sello}-${i}-antes-de-reclasificar-${corrida}.db`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(src, destino);
    const copia = new DatabaseSync(destino, { readOnly: true });
    try {
      const integridad = Object.values(copia.prepare('PRAGMA integrity_check').get())[0];
      if (integridad !== 'ok') throw new Error(`El backup no pasó integrity_check (${integridad}).`);
      for (const t of ['detected_posts', 'search_seen', 'monitoring_runs']) {
        const a = src.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
        const b = copia.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
        if (a !== b) throw new Error(`El backup no tiene las mismas filas en ${t} (${a} contra ${b}).`);
      }
    } finally {
      copia.close();
    }
  } finally {
    src.close();
  }
  return destino;
}

/**
 * La reclasificación. GASTA EN EL MODELO. Carga src/ (abre la base en
 * escritura): MONITORING_DB_PATH ya tiene que apuntar a la base.
 * @returns {Promise<object>} el resumen.
 */
async function reclasificar({ corrida, tope, concurrencia, fotos, out = console.log }) {
  const db = require('../src/db');
  const monitor = require('../src/monitor');
  const postImages = require('../src/postImages');
  const clasificadorFoto = require('../src/clasificadorFoto');
  const { getPlatform } = require('../src/platforms');
  const platform = getPlatform(PLATAFORMA);

  // La ventana de la corrida, de monitoring_runs.
  const raw = new DatabaseSync(process.env.MONITORING_DB_PATH, { readOnly: true });
  const ventana = raw.prepare('SELECT started_at, finished_at FROM monitoring_runs WHERE id = ?').get(corrida);
  raw.close();
  const filas = db.listSinClasificarDeCorrida({ plataforma: PLATAFORMA, desdeIso: ventana.started_at, hastaIso: ventana.finished_at });
  const excluidas = db.mapCuentasExcluidas(PLATAFORMA);
  const keywords = (monitor.loadConfig(PLATAFORMA).keywords || []).map((k) => (k.startsWith('#') ? k.slice(1) : k));
  const presupuestoFoto = clasificadorFoto.crearPresupuestoFoto(
    fotos != null ? fotos : clasificadorFoto.resolveFotoConfig().maxPorCiclo * Math.max(1, Math.ceil(filas.length / 200))
  );

  const r = { total: filas.length, relevantes: 0, descartadas: 0, excluidas: 0, tonoAManoConservadas: [], fallidas: 0, sinProcesar: 0, usd: 0, conFoto: 0, frenado: null };
  let enVuelo = 0;
  let fallasSeguidas = 0;
  let siguiente = 0;
  let hechas = 0;

  const borrarFotos = (id) => {
    const paths = postImages.imagePaths(PLATAFORMA, String(id));
    if (!paths) return;
    for (const f of [paths.thumb, paths.full]) fs.rmSync(f, { force: true });
  };

  const procesar = async (f) => {
    const cuenta = String(f.account || '').trim().replace(/^@+/, '').toLowerCase();
    const termino = terminoDe(f.matchedReason);
    const tonoAMano = Boolean(f.sentiment);
    const motivoExcluida = excluidas.get(cuenta);
    if (motivoExcluida) {
      if (tonoAMano) {
        r.tonoAManoConservadas.push({ id: f.id, cuenta: f.account, motivo: `cuenta excluida: ${motivoExcluida}` });
        return;
      }
      const { fotoLibre } = db.descartarPosteoGuardado({ id: f.id, plataforma: PLATAFORMA, url: f.url, term: termino, outcome: 'excluido', motivo: `Cuenta excluida: ${motivoExcluida}`, runId: corrida, postedAt: f.postedAt });
      if (fotoLibre) borrarFotos(fotoLibre);
      r.excluidas += 1;
      return;
    }
    let gasto = 0;
    const ev = await monitor.evaluateRelevance(
      { id: f.id, account: f.account, url: f.url, caption: f.caption || '', hashtagsText: '', sourceType: 'search', sourceQuery: termino, imageUrl: f.imageSourceUrl || null },
      keywords,
      { platform, presupuestoFoto, onUsage: (u) => (gasto += Number(u && u.costUsd) || 0) }
    );
    r.usd += gasto;
    if (ev.unclassified) {
      r.fallidas += 1;
      fallasSeguidas += 1;
      if (fallasSeguidas >= FALLAS_SEGUIDAS_MAX && !r.frenado) r.frenado = `${FALLAS_SEGUIDAS_MAX} fallas seguidas del modelo`;
      return;
    }
    fallasSeguidas = 0;
    if (ev.conFoto) r.conFoto += 1;
    const motivoSeen = ev.conFoto ? `${ev.motivo || 'sin motivo'} · con foto` : ev.motivo || null;
    if (ev.relevant) {
      db.updateClassification(f.id, { title: ev.title, sentiment: tonoAMano ? f.sentiment : ev.sentiment, tema: ev.tema, matchedReason: ev.matchedReason });
      db.markSearchSeen({ postId: f.id, plataforma: PLATAFORMA, url: f.url, term: termino, outcome: 'guardado', postedAt: f.postedAt, motivo: motivoSeen, llmUsd: gasto, runId: corrida });
      r.relevantes += 1;
      return;
    }
    if (tonoAMano) {
      r.tonoAManoConservadas.push({ id: f.id, cuenta: f.account, motivo: `el modelo dice que no es relevante: ${ev.motivo || 'sin motivo'}` });
      return;
    }
    const { fotoLibre } = db.descartarPosteoGuardado({ id: f.id, plataforma: PLATAFORMA, url: f.url, term: termino, outcome: 'descartado', motivo: motivoSeen, llmUsd: gasto, runId: corrida, postedAt: f.postedAt });
    if (fotoLibre) borrarFotos(fotoLibre);
    r.descartadas += 1;
  };

  // Un pool de `concurrencia`: no se lanza una más si el gasto más lo
  // reservado para las que están en vuelo pasaría el tope, ni después de
  // frenar.
  await new Promise((resolve) => {
    const lanzar = () => {
      while (enVuelo < concurrencia && siguiente < filas.length && !r.frenado) {
        if (r.usd + (enVuelo + 1) * RESERVA_POR_LLAMADA > tope) {
          r.frenado = r.frenado || `tope de ${usd(tope)}`;
          break;
        }
        const f = filas[siguiente++];
        enVuelo += 1;
        procesar(f)
          .catch((err) => {
            r.fallidas += 1;
            console.error(`[reclasificar] ${f.id}: ${err.message}`);
          })
          .finally(() => {
            enVuelo -= 1;
            hechas += 1;
            if (hechas % 50 === 0) out(`[reclasificar] ${hechas} de ${filas.length} · ${usd(r.usd)}`);
            lanzar();
          });
      }
      if (enVuelo === 0 && (siguiente >= filas.length || r.frenado)) resolve();
    };
    lanzar();
  });
  r.sinProcesar = filas.length - siguiente;
  return r;
}

function formatResumen(r) {
  const lineas = [
    '',
    `Listo: ${r.total} publicación/es.`,
    `  relevantes (clasificadas): ${r.relevantes}`,
    `  no relevantes (salieron, descartadas en search_seen): ${r.descartadas}`,
    `  de cuentas excluidas (salieron sin modelo): ${r.excluidas}`,
    `  con el tono a mano (quedaron como estaban): ${r.tonoAManoConservadas.length}`,
    `  fallidas (quedaron sin clasificar): ${r.fallidas}`,
    `  sin procesar: ${r.sinProcesar}`,
    `  con la foto de respaldo: ${r.conFoto}`,
    `  costo del modelo: ${usd(r.usd)}`,
  ];
  if (r.frenado) lineas.push(`Frenó: ${r.frenado}. Lo que quedó se puede retomar corriéndolo de nuevo.`);
  for (const c of r.tonoAManoConservadas) lineas.push(`  · tono a mano, no se borró: ${c.id} @${c.cuenta} (${c.motivo})`);
  return lineas.join('\n');
}

/**
 * @param {object} [deps] para los tests: out, appCorriendo, claveAnda,
 *   backup (backupVerificado), loadEnv.
 * @returns {Promise<number>} código de salida.
 */
async function main(
  argv = process.argv,
  { out = console.log, appCorriendo: estaCorriendo = appCorriendo, claveAnda: probarClave = claveAnda, backup = backupVerificado, loadEnv = () => require('dotenv').config() } = {}
) {
  const args = parseArgs(argv);
  if (args.help) {
    out(USO);
    return 0;
  }
  if (args.error) {
    out(`${args.error}\n\n${USO}`);
    return 1;
  }
  loadEnv();
  const dbPath = process.env.MONITORING_DB_PATH || path.join(__dirname, '..', 'data', 'monitoring.db');
  process.env.MONITORING_DB_PATH = dbPath;

  let plan;
  try {
    plan = planear({ dbPath, corrida: args.corrida, fotos: args.fotos });
  } catch (err) {
    out(err.message);
    return 1;
  }
  out(formatPlan(plan, { si: args.si, tope: args.tope }));
  if (!args.si || plan.total === 0) return 0;

  if (await estaCorriendo()) {
    out('\nLa app está corriendo (su /health responde). Apagala antes de reclasificar: no se hizo nada.');
    return 1;
  }
  const clave = await probarClave();
  if (!clave.ok) {
    out(`\nLa clave del modelo no anda (${clave.motivo}): no se hizo nada.`);
    return 1;
  }
  let destino;
  try {
    destino = await backup(dbPath, { corrida: args.corrida });
  } catch (err) {
    out(`\nNo se pudo hacer el backup (${err.message}): no se hizo nada.`);
    return 1;
  }
  out(`\nBackup verificado: ${destino}\n`);
  const r = await reclasificar({ corrida: args.corrida, tope: args.tope, concurrencia: args.concurrencia, fotos: args.fotos, out });
  out(formatResumen(r));
  return r.frenado && r.frenado.includes('fallas') ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('Error inesperado en la reclasificación:', err);
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, terminoDe, planear, formatPlan, appCorriendo, claveAnda, backupVerificado, reclasificar, formatResumen, main, TOPE_DEFAULT_USD, FALLAS_SEGUIDAS_MAX };
