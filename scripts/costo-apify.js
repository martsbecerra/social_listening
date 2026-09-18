// ==========================================================================
// costo-apify.js
// --------------------------------------------------------------------------
// Cuánto gastó la app en Apify: hoy, últimos 7 días y últimos N días (30
// por defecto), con llamadas, resultados y el usd en las tres tarifas
// (free, starter, scale), el desglose por fase y una proyección mensual
// (promedio diario de los últimos 7 días × 30). Lee apify_calls en
// data/monitoring.db (src/apifyCost.js); NO llama a Apify.
//
//   npm run costo
//   node scripts/costo-apify.js --dias 90
// ==========================================================================

require('dotenv').config();

const { summarizeCosts } = require('../src/apifyCost');

function parseArgs(argv) {
  const i = argv.indexOf('--dias');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return { dias: Number.isFinite(n) && n > 0 ? Math.floor(n) : 30 };
}

const money = (value) => `US$ ${Number(value || 0).toFixed(2)}`;
const usdColumns = (usd) => `free ${money(usd.free)} · starter ${money(usd.starter)} · scale ${money(usd.scale)}`;

function printWindow(window) {
  const since = window.since ? ` (desde ${window.since.slice(0, 16).replace('T', ' ')} UTC)` : '';
  console.log(`\n== ${window.label}${since}`);
  console.log(
    `  Total: ${window.calls} llamadas (${window.failed} fallidas), ${window.results} resultados → ${usdColumns(window.usd)}`
  );
  const phases = Object.keys(window.porFase).sort();
  if (phases.length === 0) {
    console.log('  (sin llamadas en esta ventana)');
    return;
  }
  for (const phase of phases) {
    const f = window.porFase[phase];
    console.log(
      `    ${phase.padEnd(14)} ${String(f.calls).padStart(5)} llamadas ${String(f.results).padStart(7)} resultados → ${usdColumns(f.usd)}`
    );
  }
}

const { dias } = parseArgs(process.argv);
const report = summarizeCosts({ days: dias });

console.log(
  `Gasto en Apify — tarifas por 1000 resultados: free ${report.rates.free}, starter ${report.rates.starter}, ` +
    `scale ${report.rates.scale}. Plan activo: ${report.plan}.`
);
printWindow(report.hoy);
printWindow(report.ultimos7);
printWindow(report.ventana);

const p = report.proyeccionMensual;
console.log(`\n== Proyección mensual (${p.base})`);
console.log(`  ${p.calls} llamadas, ${p.results} resultados → ${usdColumns(p.usd)}`);
