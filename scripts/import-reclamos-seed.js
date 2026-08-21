// ==========================================================================
// import-reclamos-seed.js
// --------------------------------------------------------------------------
// Carga el TSV Brandwatch/X a monitoring.db. Solo se corre a mano:
//   node scripts/import-reclamos-seed.js [--dry-run] <tsvPath>
// --dry-run imprime claves únicas y sale (sin DB ni Nominatim).
// ==========================================================================

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { extractAddress, inferTematica } = require('../src/reclamosAddress');

function printUsage() {
  console.error('Uso: node scripts/import-reclamos-seed.js [--dry-run] <tsvPath>');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  const tsvPath = positional[0];
  return { dryRun, tsvPath };
}

function stripQuotes(value) {
  return String(value || '')
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .trim();
}

function readUtf16Tsv(filePath) {
  const buf = fs.readFileSync(filePath);
  const encoding = buf[0] === 0xff && buf[1] === 0xfe ? 'utf16le' : 'utf8';
  let raw = buf.toString(encoding);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split('\t').map((h) => stripQuotes(h));
  return lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((name, i) => {
      row[name] = stripQuotes(cols[i] || '');
    });
    return row;
  });
}

function usernameFromRow(row) {
  const raw = row.Influencer || row['Twitter Screen Name'] || '';
  return raw.replace(/^@/, '').trim() || 'desconocido';
}

function mapSeedRow(row) {
  const commentText = row['Opening Text'] || '';
  const address = extractAddress(commentText);
  return {
    id: stripQuotes(row['Document ID']),
    source: 'seed-x',
    username: usernameFromRow(row),
    commentText,
    postUrl: row['Parent URL'] || '',
    commentUrl: row.URL || '',
    tematica: inferTematica(commentText, { implicitParking: true }),
    direccionDetectada: address ? address.direccionDetectada : null,
    direccionNormalizada: address ? address.direccionNormalizada : null,
    lat: null,
    lng: null,
    geocodeStatus: address ? 'pending' : 'no_address',
    postedAt: row.Date || null,
    importedAt: new Date().toISOString(),
  };
}

function printDryRun(reclamos) {
  const counts = new Map();
  let withAddress = 0;
  for (const r of reclamos) {
    if (!r.direccionNormalizada) continue;
    withAddress += 1;
    counts.set(r.direccionNormalizada, (counts.get(r.direccionNormalizada) || 0) + 1);
  }

  const unique = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`Filas: ${reclamos.length}`);
  console.log(`Con dirección extraída: ${withAddress}`);
  console.log(`Claves únicas: ${unique.length}`);
  for (const [key, n] of unique) {
    console.log(`  ${n}\t${key}`);
  }
}

async function importLive(reclamos) {
  const db = require('../src/db');
  const { requireNominatimUserAgent, geocodePendingReclamos } = require('../src/geocode');
  requireNominatimUserAgent();

  const removed = db.deleteReclamosBySource('seed-x');
  console.log(`Borrados: ${removed} reclamos seed-x previos`);

  for (const reclamo of reclamos) {
    db.upsertReclamo(reclamo);
  }
  console.log(`Upsert: ${db.countReclamos()} reclamos en monitoring.db`);

  const geo = await geocodePendingReclamos();
  console.log(
    `Geocode: ${geo.pending} claves pendientes, ${geo.fromCache} de cache, ${geo.fetched} a Nominatim`
  );
}

async function main() {
  const { dryRun, tsvPath } = parseArgs(process.argv);
  if (!tsvPath) {
    printUsage();
    process.exit(1);
  }

  const resolved = path.resolve(tsvPath);
  if (!fs.existsSync(resolved)) {
    console.error(`No existe el archivo: ${resolved}`);
    process.exit(1);
  }

  const rows = readUtf16Tsv(resolved);
  const reclamos = rows.filter((row) => stripQuotes(row['Document ID'])).map(mapSeedRow);

  if (dryRun) {
    printDryRun(reclamos);
    return;
  }

  await importLive(reclamos);
}

main().catch((err) => {
  console.error(err.userMessage || err.message);
  process.exit(1);
});
