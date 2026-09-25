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
// (lecturas gratis, no son runs) el costo real de las llamadas pendientes.
//
//   npm run costo
//   node scripts/costo-apify.js --dias 90
//   node scripts/costo-apify.js --conciliar
// ==========================================================================

require('dotenv').config();

const { summarizeCosts, reconcileRealCosts } = require('../src/apifyCost');

function parseArgs(argv) {
  const i = argv.indexOf('--dias');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return { dias: Number.isFinite(n) && n > 0 ? Math.floor(n) : 30, conciliar: argv.includes('--conciliar') };
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
const { dias, conciliar } = parseArgs(process.argv);
if (conciliar) {
  const r = await reconcileRealCosts({ limit: 500 });
  console.log(
    `Conciliación del costo real: ${r.checked} llamadas revisadas, ${r.updated} actualizadas ` +
      `(US$ ${r.usdReal.toFixed(4)} real vs US$ ${r.usdEstimado.toFixed(4)} estimado), ${r.pending} todavía sin asentar, ${r.failed} fallidas.\n`
  );
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
