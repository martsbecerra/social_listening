// ==========================================================================
// migrate-categorias.js
// --------------------------------------------------------------------------
// Traduce las categorías del esquema viejo (9 valores planos) al esquema de
// dos niveles del cliente (categoría + subcategoría, ver
// config/categorias-reclamos.json).
//
//   node scripts/migrate-categorias.js --dry-run   muestra qué haría
//   node scripts/migrate-categorias.js             migra
//   node scripts/migrate-categorias.js --revert    vuelve al estado anterior
//
// Antes de tocar nada guarda (categoria, subcategoria) de cada fila en
// `categorias_backup`, así --revert no depende de acordarse del mapeo. Es
// idempotente: correrlo dos veces no rompe nada, la segunda no encuentra
// filas viejas que traducir.
// ==========================================================================

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { resolveAliasViejo, resolveCategoria } = require('../src/categoriasConfig');

const DB_PATH = path.join(__dirname, '..', 'data', 'monitoring.db');

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    revert: args.includes('--revert'),
  };
}

function abrirDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS categorias_backup (
      reclamo_id TEXT PRIMARY KEY,
      categoria_anterior TEXT,
      subcategoria_anterior TEXT,
      migrado_at TEXT NOT NULL
    )
  `);
  return db;
}

// --------------------------------------------------------------------------

function migrar({ dryRun }) {
  const db = abrirDb();
  const filas = db.prepare('SELECT id, categoria, subcategoria FROM reclamos').all();

  const aMigrar = [];
  const yaValidas = [];
  const sinMapeo = [];

  for (const f of filas) {
    // Si ya es una categoría del esquema nuevo, no se toca.
    if (resolveCategoria(f.categoria)) {
      // Salvo que sea "Seguridad", que existe en los DOS esquemas: si no tiene
      // subcategoría, viene del viejo y le corresponde una.
      const esAmbigua = !f.subcategoria && resolveAliasViejo(f.categoria);
      if (!esAmbigua) {
        yaValidas.push(f);
        continue;
      }
    }

    const alias = resolveAliasViejo(f.categoria);
    if (!alias) {
      sinMapeo.push(f);
      continue;
    }
    aMigrar.push({
      id: f.id,
      de: { categoria: f.categoria, subcategoria: f.subcategoria },
      a: { categoria: alias.categoria, subcategoria: alias.subcategoria || null },
    });
  }

  // Resumen por par (viejo -> nuevo).
  const porPar = new Map();
  for (const m of aMigrar) {
    const k = `${m.de.categoria}  ->  ${m.a.categoria} / ${m.a.subcategoria || '(vacía)'}`;
    porPar.set(k, (porPar.get(k) || 0) + 1);
  }

  console.log(`\nTotal de reclamos: ${filas.length}`);
  console.log(`  ya en el esquema nuevo : ${yaValidas.length}`);
  console.log(`  a migrar               : ${aMigrar.length}`);
  console.log(`  sin mapeo conocido     : ${sinMapeo.length}`);

  if (porPar.size > 0) {
    console.log('\nMapeo a aplicar:');
    for (const [k, n] of [...porPar.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${k}`);
    }
  }

  if (sinMapeo.length > 0) {
    const vals = [...new Set(sinMapeo.map((f) => f.categoria))];
    console.log('\n⚠️  Categorías sin mapeo (quedan como están, revisalas a mano):');
    vals.forEach((v) => console.log(`   ${JSON.stringify(v)}`));
  }

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada.\n');
    db.close();
    return;
  }

  if (aMigrar.length === 0) {
    console.log('\nNada que migrar.\n');
    db.close();
    return;
  }

  const guardarBackup = db.prepare(`
    INSERT INTO categorias_backup (reclamo_id, categoria_anterior, subcategoria_anterior, migrado_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(reclamo_id) DO NOTHING
  `);
  const actualizar = db.prepare('UPDATE reclamos SET categoria = ?, subcategoria = ? WHERE id = ?');
  const ahora = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const m of aMigrar) {
      guardarBackup.run(m.id, m.de.categoria, m.de.subcategoria ?? null, ahora);
      actualizar.run(m.a.categoria, m.a.subcategoria, m.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`\n✅ ${aMigrar.length} reclamos migrados. Estado anterior guardado en categorias_backup.`);
  console.log('   Para volver atrás: node scripts/migrate-categorias.js --revert\n');
  db.close();
}

// --------------------------------------------------------------------------

function revertir({ dryRun }) {
  const db = abrirDb();
  const backup = db.prepare('SELECT * FROM categorias_backup').all();

  if (backup.length === 0) {
    console.log('\nNo hay nada en categorias_backup: no se migró nada todavía.\n');
    db.close();
    return;
  }

  console.log(`\nFilas a revertir: ${backup.length}`);
  const porCat = new Map();
  for (const b of backup) {
    porCat.set(b.categoria_anterior, (porCat.get(b.categoria_anterior) || 0) + 1);
  }
  for (const [k, n] of porCat.entries()) console.log(`  ${String(n).padStart(5)}  vuelve a "${k}"`);

  if (dryRun) {
    console.log('\n--dry-run: no se escribió nada.\n');
    db.close();
    return;
  }

  const restaurar = db.prepare('UPDATE reclamos SET categoria = ?, subcategoria = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const b of backup) {
      restaurar.run(b.categoria_anterior, b.subcategoria_anterior, b.reclamo_id);
    }
    db.exec('DELETE FROM categorias_backup');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`\n✅ ${backup.length} reclamos revertidos al estado anterior.\n`);
  db.close();
}

// --------------------------------------------------------------------------

const { dryRun, revert } = parseArgs(process.argv);
try {
  if (revert) revertir({ dryRun });
  else migrar({ dryRun });
} catch (err) {
  console.error('\n❌ Falló la migración:', err.message);
  process.exit(1);
}
