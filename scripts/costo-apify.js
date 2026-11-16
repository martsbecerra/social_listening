// ==========================================================================
// costo-apify.js
// --------------------------------------------------------------------------
// Cuánto gastó la app en Apify: hoy, últimos 7 días y últimos N días (30
// por defecto), con llamadas, resultados y usd, desglosado por actor y por
// fase, más una proyección mensual (promedio diario de los últimos 7 días ×
// 30). Las tres columnas por plan (free, starter, scale) valen solo para el
// actor oficial apify/instagram-scraper, que cobra por resultado; el actor
// apidojo/instagram-scraper-api cobra por consulta y muestra el estimado y
// lo que Apify cobró de verdad (usd_real) donde ya se concilió. Lee
// apify_calls en data/monitoring.db (src/apifyCost.js); NO llama a Apify,
// salvo con --conciliar, que antes de informar relee en la API de Apify
// (lecturas gratis, no son runs) el costo real de las llamadas pendientes,
// y lista lo que quedó sin cerrar: las búsquedas que siguen esperando en
// Apify (se levantan solas en la próxima corrida) y las corridas del actor
// que están en Apify y la app no registró.
//
// --asentar <archivo.json> anota el run y el costo real de corridas que la
// app cortó sin registrar (antes de noviembre 2026 un corte por tiempo
// dejaba la fila fallida, con usd 0 y sin run, aunque la corrida terminara
// y se cobrara). El archivo es una lista de { ciclo, objetivo, apifyRunId,
// usd }: el ciclo de monitoring_runs, el término de la búsqueda (o el
// usuario del perfil), el id del run en Apify y lo que cobró. No importa
// publicaciones ni crea filas. Sin --si solo informa lo que haría.
//
//   npm run costo
//   node scripts/costo-apify.js --dias 90
//   node scripts/costo-apify.js --conciliar
//   node scripts/costo-apify.js --asentar <archivo.json>          (informa)
//   node scripts/costo-apify.js --asentar <archivo.json> --si     (escribe)
// ==========================================================================

require('dotenv').config();

const fs = require('fs');
const { summarizeCosts, reconcileRealCosts, settleCutRuns, listOrphanRuns } = require('../src/apifyCost');

function parseArgs(argv) {
  const i = argv.indexOf('--dias');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  const j = argv.indexOf('--asentar');
  return {
    dias: Number.isFinite(n) && n > 0 ? Math.floor(n) : 30,
    conciliar: argv.includes('--conciliar'),
    asentar: j >= 0 ? argv[j + 1] || '' : null,
    si: argv.includes('--si'),
  };
}

/** Hora de Argentina (UTC-3 fija), "16/11 12:00". */
function horaArgentina(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '-';
  const t = new Date(ms - 3 * 60 * 60 * 1000).toISOString();
  return `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 16)}`;
}

/** --asentar: lee el archivo, asienta (o informa) y lo cuenta. */
function asentar(archivo, aplicar) {
  if (!archivo || archivo.startsWith('--')) throw new Error('--asentar necesita la ruta de un archivo .json');
  let entradas;
  try {
    entradas = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch (err) {
    throw new Error(`No se pudo leer ${archivo}: ${err.message}`);
  }
  if (entradas && !Array.isArray(entradas) && Array.isArray(entradas.runs)) entradas = entradas.runs;
  if (!Array.isArray(entradas)) throw new Error('El archivo tiene que ser una lista de { ciclo, objetivo, apifyRunId, usd }.');
  const r = settleCutRuns(entradas, { aplicar });
  console.log(`${aplicar ? 'Asentadas' : 'Se asentarían'}: ${r.asentadas.length} de ${entradas.length} corridas, US$ ${r.usd.toFixed(4)}.`);
  for (const a of r.asentadas) console.log(`  ciclo #${a.ciclo} · ${a.objetivo} · run ${a.apifyRunId} · US$ ${Number(a.usd).toFixed(4)}`);
  if (r.yaAsentadas.length > 0) console.log(`Ya estaban registradas (no se tocan): ${r.yaAsentadas.length}.`);
  for (const a of r.sinFila) console.log(`  SIN FILA: en el ciclo #${a.ciclo} no hay una llamada fallida y sin run de «${a.objetivo}» (run ${a.apifyRunId}).`);
  if (r.invalidas.length > 0) console.log(`Entradas mal formadas (se saltean): ${r.invalidas.length}.`);
  if (!aplicar && r.asentadas.length > 0) console.log('No se escribió nada. Para asentarlas, el mismo comando con --si.');
}

/** --conciliar: lo que quedó sin cerrar (solo lee). */
async function listarPendientes() {
  const db = require('../src/db');
  const { listPlatformIds } = require('../src/platforms');
  const esperando = listPlatformIds().flatMap((plataforma) => db.listPendingRunSources(plataforma));
  if (esperando.length === 0) console.log('Búsquedas esperando en Apify: ninguna.');
  else {
    console.log(`Búsquedas esperando en Apify (se levantan solas al empezar la próxima corrida): ${esperando.length}`);
    for (const f of esperando) console.log(`  ${f.plataforma} · «${f.fuente}» · run ${f.apifyRunId || '(sin run)'} · lanzada ${horaArgentina(f.startedAt)} (ciclo #${f.runId ?? '?'})`);
  }
  try {
    const huerfanas = await listOrphanRuns();
    if (huerfanas.length === 0) console.log('Corridas en Apify que la app no registró (últimos 7 días): ninguna.');
    else {
      console.log(`Corridas en Apify que la app no registró (últimos 7 días): ${huerfanas.length}`);
      for (const h of huerfanas) console.log(`  run ${h.id} · ${horaArgentina(h.startedAt)} · ${h.status || '?'}${h.usdReal != null ? ` · US$ ${h.usdReal.toFixed(4)}` : ''}`);
      console.log('  (con --asentar se puede anotar su costo en la llamada que quedó fallida)');
    }
  } catch (err) {
    console.log(`No se pudieron listar las corridas del actor en Apify: ${err.message}`);
  }
  console.log('');
}

const money = (value) => `US$ ${Number(value || 0).toFixed(3)}`;
const usdColumns = (usd) => `free ${money(usd.free)} · starter ${money(usd.starter)} · scale ${money(usd.scale)}`;
const apidojoColumns = (a) =>
  `estimado ${money(a.usdEstimado)}` +
  (a.usdReal != null ? ` · real ${money(a.usdReal)} (${a.callsConReal} de ${a.calls} llamadas con costo real)` : ' · sin costo real registrado');

function printBucket(indent, bucket, actores) {
  const pad = ' '.repeat(indent);
  if (bucket.oficial.calls > 0) {
    console.log(
      `${pad}${actores.oficial.padEnd(30)} ${String(bucket.oficial.calls).padStart(5)} llamadas ${String(bucket.oficial.results).padStart(7)} resultados → ${usdColumns(bucket.oficial.usd)}`
    );
  }
  if (bucket.apidojo.calls > 0) {
    console.log(
      `${pad}${actores.apidojo.padEnd(30)} ${String(bucket.apidojo.calls).padStart(5)} llamadas ${String(bucket.apidojo.results).padStart(7)} resultados → ${apidojoColumns(bucket.apidojo)}`
    );
  }
}

function printWindow(window, report) {
  const since = window.since ? ` (desde ${window.since.slice(0, 16).replace('T', ' ')} UTC)` : '';
  console.log(`\n== ${window.label}${since}`);
  console.log(`  Total: ${window.calls} llamadas (${window.failed} fallidas), ${window.results} resultados`);
  if (window.calls === 0) {
    console.log('  (sin llamadas en esta ventana)');
    return;
  }
  printBucket(4, window, report.actores);
  console.log(`    Total por plan (oficial por plan + apidojo real o estimado): ${usdColumns(window.usd)}`);
  console.log('  Por fase:');
  for (const phase of Object.keys(window.porFase).sort()) {
    const f = window.porFase[phase];
    console.log(
      `    ${phase.padEnd(14)} ${String(f.calls).padStart(5)} llamadas ${String(f.results).padStart(7)} resultados → ${money(f.usd[report.plan])} (${report.plan})`
    );
    printBucket(8, f, report.actores);
  }
}

async function main() {
const { dias, conciliar, asentar: archivo, si } = parseArgs(process.argv);
if (archivo !== null) {
  asentar(archivo, si);
  return;
}
if (conciliar) {
  const r = await reconcileRealCosts({ limit: 500 });
  console.log(
    `Conciliación del costo real: ${r.checked} llamadas revisadas, ${r.updated} actualizadas ` +
      `(US$ ${r.usdReal.toFixed(4)} real vs US$ ${r.usdEstimado.toFixed(4)} estimado), ${r.pending} todavía sin asentar, ${r.failed} fallidas.\n`
  );
  await listarPendientes();
}
const report = summarizeCosts({ days: dias });

console.log(
  `Gasto en Apify — ${report.actores.oficial}: por 1000 resultados free ${report.rates.free}, starter ${report.rates.starter}, ` +
    `scale ${report.rates.scale} (plan activo: ${report.plan}).`
);
const a = report.apidojoRates;
console.log(
  `${report.actores.apidojo}: por consulta perfil ${a.user} (${a.included.user} incl.), hashtag ${a.hashtag} (${a.included.hashtag} incl.), ` +
    `búsqueda ${a.search} (${a.included.search} incl.), posteo ${a.post}; posteo extra ${a.item}.`
);
printWindow(report.hoy, report);
printWindow(report.ultimos7, report);
printWindow(report.ventana, report);

const p = report.proyeccionMensual;
console.log(`\n== Proyección mensual (${p.base})`);
console.log(`  ${p.calls} llamadas, ${p.results} resultados → ${usdColumns(p.usd)}`);
console.log(`  de eso, ${report.actores.apidojo}: ${p.apidojo.calls} llamadas ≈ ${money(p.apidojo.usd)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
