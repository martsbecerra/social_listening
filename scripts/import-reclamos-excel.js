// ==========================================================================
// import-reclamos-excel.js
// --------------------------------------------------------------------------
// Carga la hoja "Reclamos" de un Excel ya resuelto (direccion + X/Y + comuna
// + barrio ya cargados a mano) a la tabla `reclamos`. No pasa por USIG: las
// filas ya vienen con geo_status = 'ok'. Idempotente: usa `link` como
// comentario_id/id, así que correrlo dos veces no duplica.
//   node scripts/import-reclamos-excel.js [--dry-run] <xlsxPath>
// --dry-run solo imprime un resumen (sin tocar la DB).
// ==========================================================================

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SHEET_NAME = 'Reclamos';
const CATEGORIA_FIJA = 'Estacionamientos truchos';

function printUsage() {
  console.error('Uso: node scripts/import-reclamos-excel.js [--dry-run] <xlsxPath>');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  return { dryRun, xlsxPath: positional[0] };
}

function stripAt(value) {
  return String(value || '').replace(/^@/, '').trim();
}

function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** Fila de la hoja "Reclamos" -> forma de db.upsertReclamo, o null si falta `link` (no hay id estable). */
function mapRow(row) {
  const link = String(row.link || '').trim();
  if (!link) return null;

  const x = Number(row.X);
  const y = Number(row.Y);
  const comuna = row.comuna != null && row.comuna !== '' ? Number(row.comuna) : null;

  return {
    id: link,
    comentarioId: link,
    plataforma: 'x',
    postUrl: null,
    commentUrl: link,
    autor: stripAt(row.autor) || null,
    fecha: toIsoDate(row.fecha),
    detectedAt: new Date().toISOString(),
    textoOriginal: String(row.texto || '').trim(),
    categoria: CATEGORIA_FIJA,
    direccionDetectada: null,
    direccionNormalizada: row.direccion ? String(row.direccion).trim() : null,
    calle: null,
    altura: null,
    cruce: null,
    x: Number.isFinite(x) ? x : null,
    y: Number.isFinite(y) ? y : null,
    comuna: Number.isFinite(comuna) ? comuna : null,
    barrio: row.barrio ? String(row.barrio).trim() : null,
    precision: 'exacta',
    geoStatus: 'ok',
    estado: 'Pendiente',
  };
}

function printDryRun(rows, totalRaw) {
  console.log(`Filas en hoja "${SHEET_NAME}": ${totalRaw}`);
  console.log(`Mapeadas: ${rows.length}`);
  console.log(`Descartadas (sin link): ${totalRaw - rows.length}`);
  console.log(`Con comuna: ${rows.filter((r) => r.comuna != null).length}`);
  console.log(`Con barrio: ${rows.filter((r) => r.barrio).length}`);
  console.log(`Con x/y: ${rows.filter((r) => r.x != null && r.y != null).length}`);
}

function importLive(rows) {
  const db = require('../src/db');
  const before = db.countReclamos();
  for (const row of rows) {
    db.upsertReclamo(row);
  }
  const after = db.countReclamos();
  console.log(`Upsert: ${rows.length} filas procesadas. Total en reclamos: ${after} (antes: ${before}).`);
}

function main() {
  const { dryRun, xlsxPath } = parseArgs(process.argv);
  if (!xlsxPath) {
    printUsage();
    process.exit(1);
  }

  const resolved = path.resolve(xlsxPath);
  if (!fs.existsSync(resolved)) {
    console.error(`No existe el archivo: ${resolved}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(resolved, { cellDates: true });
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    console.error(
      `El archivo no tiene una hoja "${SHEET_NAME}". Hojas encontradas: ${wb.SheetNames.join(', ')}`
    );
    process.exit(1);
  }

  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const rows = rawRows.map(mapRow).filter(Boolean);

  if (dryRun) {
    printDryRun(rows, rawRows.length);
    return;
  }

  importLive(rows);
}

main();
