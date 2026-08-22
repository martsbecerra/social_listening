// ==========================================================================
// recalc-account-stats.js
// --------------------------------------------------------------------------
// Fuerza el recálculo del benchmark de una cuenta puntual, de TODO el
// universo de cuentas (trackeadas + las que aparecen en detected_posts por
// hashtag), o de las que quedaron pendientes de una corrida anterior que se
// cortó por cuota de Apify — sin importar cuán reciente sea su computed_at
// (la cadencia automática es mensual y además escalonada — ver
// src/accountStats.js).
//
// Cada cuenta hace UNA sola pasada de Apify que sirve para tres cosas a la
// vez: benchmark (medianas, con fallback a mediana global si falta el tipo),
// seguidores, y actualizar likes/comments/post_type de los posteos ya
// guardados que volvieron a aparecer en el scraping.
//
//   node scripts/recalc-account-stats.js <cuenta>        # una cuenta puntual
//   node scripts/recalc-account-stats.js --todas          # todo el universo, pide confirmación
//   node scripts/recalc-account-stats.js --todas --si     # sin pedir confirmación
//   node scripts/recalc-account-stats.js --pendientes     # solo las de scripts/pendientes-benchmark.txt
//   node scripts/recalc-account-stats.js --pendientes --si
//
// Si Apify devuelve "Monthly usage hard limit exceeded" (cuota mensual
// agotada), la corrida corta ahí mismo — seguir intentando con el resto solo
// generaría el mismo 403 uno por uno — y reescribe
// scripts/pendientes-benchmark.txt con las cuentas que quedaron sin
// procesar, para que el próximo intento arranque justo ahí.
// ==========================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const accountStats = require('../src/accountStats');
const db = require('../src/db');

const PENDIENTES_PATH = path.join(__dirname, 'pendientes-benchmark.txt');

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    todas: args.includes('--todas'),
    pendientes: args.includes('--pendientes'),
    si: args.includes('--si'),
    account: args.find((a) => !a.startsWith('--')) || null,
  };
}

async function confirm(promptText) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${promptText} `);
    return /^s(i|í)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function readPendientesFile() {
  if (!fs.existsSync(PENDIENTES_PATH)) return [];
  return fs
    .readFileSync(PENDIENTES_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function writePendientesFile(accounts) {
  fs.writeFileSync(PENDIENTES_PATH, accounts.map((a) => `${a}\n`).join(''), 'utf8');
}

// El texto exacto que devuelve Apify para el límite mensual duro del plan
// (visto en vivo: 403 {"error":{"type":"actor-disabled","message":"Monthly
// usage hard limit exceeded..."}}) — src/apify.js lo deja adentro de
// err.message tal cual, así que un includes alcanza sin parsear JSON.
function isQuotaExceededError(err) {
  return String((err && err.message) || '').includes('Monthly usage hard limit exceeded');
}

async function recalcOne(account, { index, total } = {}) {
  const prefix = index && total ? `[${index}/${total}] ` : '';
  console.log(`${prefix}@${account}...`);

  const result = await accountStats.computeAccountStats(account);
  const refLine =
    result.groupsSaved > 0
      ? `${result.groupsSaved} grupo(s) con referencia guardada`
      : 'sin datos suficientes (menos de 5 posteos recientes)';

  console.log(
    `  ${result.fetched} posteos traídos, ${result.recent} de los últimos 3 meses, ${refLine}, ` +
      `seguidores: ${result.followersFound ? 'sí' : 'no'}, ${result.postsUpdated} posteo(s) con métricas actualizadas.`
  );
  return result;
}

/**
 * Después de procesar una lista: confirma si el objetivo se cumplió,
 * recorriendo detected_posts con la MISMA clasificación que usa
 * /api/monitoring/posts (server.js) — así el número coincide exactamente
 * con lo que va a mostrar la tabla.
 */
function printGoalCheck() {
  const { posts, total } = db.listDetectedPosts({ page: 1, pageSize: 1_000_000 });
  const statsMap = accountStats.buildAccountStatsMap();

  let withBenchmark = 0;
  let withFollowers = 0;
  let highlightCandidates = 0;
  let basisTipo = 0;
  let basisGlobal = 0;

  for (const post of posts) {
    const benchmark = accountStats.classifyPostAgainstBenchmark({
      account: post.account,
      postType: post.post_type,
      likes: post.likes,
      comments: post.comments,
      statsMap,
    });

    const likesReal = benchmark.likes.level !== 'sin-referencia';
    const commentsReal = benchmark.comments.level !== 'sin-referencia';
    if (likesReal || commentsReal) {
      withBenchmark += 1;
      // El basis es el mismo para likes y comments (viene de la misma fila
      // de account_stats) — con que una de las dos sea real alcanza para leerlo.
      const basis = (likesReal && benchmark.likes.basis) || (commentsReal && benchmark.comments.basis);
      if (basis === 'tipo') basisTipo += 1;
      else if (basis === 'global') basisGlobal += 1;
    }
    if (post.followers != null) withFollowers += 1;

    // Mismo criterio que las tarjetas "Se despegaron" del frontend: ambas
    // métricas con referencia real, y el mayor de los dos ratios >= 1.5x.
    if (likesReal && commentsReal) {
      const best = Math.max(benchmark.likes.ratio, benchmark.comments.ratio);
      if (best >= accountStats.RATIO_HIGH) highlightCandidates += 1;
    }
  }

  console.log('\n--- Chequeo del objetivo ---');
  console.log(`Posteos con benchmark disponible (likes o comentarios): ${withBenchmark} de ${total}`);
  console.log(`  de esos, por tipo exacto: ${basisTipo} · por mediana global (fallback): ${basisGlobal}`);
  console.log(`Posteos con seguidores (no nulo): ${withFollowers} de ${total}`);
  console.log(`Posteos que superan 1.5x su propia mediana ("Se despegaron"): ${highlightCandidates} de ${total}`);
}

/**
 * Procesa una lista de cuentas (todo el universo, o solo las pendientes).
 * @returns {Promise<{ quotaExceeded: boolean }>}
 */
async function runAccountList(accounts, { si, sourceLabel } = {}) {
  if (accounts.length === 0) {
    console.log('No hay cuentas para procesar.');
    return { quotaExceeded: false };
  }

  console.log(
    `Se van a procesar ${accounts.length} cuentas${sourceLabel ? ` (${sourceLabel})` : ''}. Estimado: hasta ` +
      `${accounts.length} x ${accountStats.BENCHMARK_POST_LIMIT} resultados de Apify, más ${accounts.length} ` +
      `consultas de perfil.`
  );
  if (!si) {
    const ok = await confirm('¿Continuar? (S/N)');
    if (!ok) {
      console.log('Cancelado.');
      return { quotaExceeded: false };
    }
  }

  let computed = 0;
  let insufficientData = 0;
  let failed = 0;
  let withoutFollowers = 0;
  let postsUpdated = 0;
  let apifyResultsConsumed = 0;
  let profileChecks = 0;
  let quotaExceeded = false;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const result = await recalcOne(account, { index: i + 1, total: accounts.length });
      if (result.groupsSaved > 0) computed += 1;
      else insufficientData += 1;
      if (!result.followersFound) withoutFollowers += 1;
      postsUpdated += result.postsUpdated;
      apifyResultsConsumed += result.fetched;
      profileChecks += result.followersChecked;
    } catch (err) {
      if (isQuotaExceededError(err)) {
        // Se agotó la cuota mensual de Apify: seguir con las que faltan
        // solo generaría el mismo 403 una por una. Corta acá — la cuenta
        // que acaba de fallar tampoco se procesó, así que también queda
        // pendiente.
        const remaining = accounts.slice(i);
        writePendientesFile(remaining);
        quotaExceeded = true;
        console.log(
          `\nCuota de Apify agotada. Quedan ${remaining.length} cuentas pendientes en ` +
            `scripts/pendientes-benchmark.txt`
        );
        break;
      }
      // Una cuenta que falla por otro motivo (privada, borrada, error
      // puntual de Apify) nunca aborta la corrida — se loguea y se sigue.
      failed += 1;
      console.error(`  @${account}: falló — ${err.message}`);
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Calculadas: ${computed}`);
  console.log(`Sin stats (menos de 5 posteos recientes): ${insufficientData}`);
  console.log(`Fallaron: ${failed}`);
  console.log(`Sin seguidores (fetch fallido o cuenta privada): ${withoutFollowers}`);
  console.log(`Posteos actualizados: ${postsUpdated}`);
  console.log(`Resultados de Apify consumidos: ${apifyResultsConsumed} posteos + ${profileChecks} consultas de perfil`);

  printGoalCheck();

  return { quotaExceeded };
}

async function main() {
  const { todas, pendientes, si, account } = parseArgs(process.argv);

  if (account) {
    await recalcOne(account.replace(/^@/, ''));
    return;
  }

  if (pendientes) {
    const accounts = readPendientesFile();
    if (accounts.length === 0) {
      console.log('scripts/pendientes-benchmark.txt no existe o está vacío — no hay nada pendiente.');
      return;
    }
    const { quotaExceeded } = await runAccountList(accounts, { si, sourceLabel: 'pendientes' });
    // Si terminó la lista sin volver a chocar con la cuota, ya no queda
    // nada pendiente — se limpia el archivo para que el próximo
    // --pendientes no vuelva a intentar cuentas ya resueltas.
    if (!quotaExceeded) writePendientesFile([]);
    return;
  }

  if (todas) {
    await runAccountList(accountStats.buildAccountUniverse(), { si });
    return;
  }

  console.log(
    [
      'Uso:',
      '  node scripts/recalc-account-stats.js <cuenta>        # una cuenta puntual',
      '  node scripts/recalc-account-stats.js --todas          # todo el universo (trackeadas + detected_posts), pide confirmación',
      '  node scripts/recalc-account-stats.js --todas --si     # sin pedir confirmación',
      '  node scripts/recalc-account-stats.js --pendientes     # solo las de scripts/pendientes-benchmark.txt',
      '  node scripts/recalc-account-stats.js --pendientes --si',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err.userMessage || err.message);
  process.exit(1);
});
