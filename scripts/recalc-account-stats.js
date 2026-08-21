// ==========================================================================
// recalc-account-stats.js
// --------------------------------------------------------------------------
// Fuerza el recálculo del benchmark de una cuenta puntual o de todas las
// cuentas trackeadas, sin importar cuán reciente sea su computed_at (la
// cadencia normal es mensual — ver src/accountStats.js).
//   node scripts/recalc-account-stats.js               # todas las cuentas trackeadas
//   node scripts/recalc-account-stats.js jorgemacri     # una cuenta puntual
// ==========================================================================

require('dotenv').config();

const { computeAccountStats } = require('../src/accountStats');
const { loadConfig } = require('../src/monitor');

async function recalcOne(account) {
  const result = await computeAccountStats(account);
  console.log(
    `@${account}: ${result.fetched} posteos traídos, ${result.recent} de los últimos 3 meses, ` +
      `${result.groupsSaved} grupo(s) con referencia guardada.`
  );
  return result;
}

async function main() {
  const account = process.argv[2];

  if (account) {
    await recalcOne(account.replace(/^@/, ''));
    return;
  }

  const { accounts } = loadConfig();
  if (accounts.length === 0) {
    console.log('No hay cuentas trackeadas en config/monitoring.json.');
    return;
  }

  let totalFetched = 0;
  for (const acc of accounts) {
    try {
      const result = await recalcOne(acc);
      totalFetched += result.fetched;
    } catch (err) {
      console.error(`@${acc}: falló — ${err.message}`);
    }
  }
  console.log(`\nListo: ${accounts.length} cuentas procesadas, ${totalFetched} resultados de Apify consumidos.`);
}

main().catch((err) => {
  console.error(err.userMessage || err.message);
  process.exit(1);
});
