// ==========================================================================
// influencers.js — Carga el padrón ANTIK-PRO a SQLite y lo expone al análisis.
// ==========================================================================

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { parseAndMergeInfluencerCsvs, normalizeHandle } = require('./influencersParse');

const DEFAULT_NUMERIC = path.join(__dirname, '..', '..', 'config', 'x-influencers', 'antik-pro.csv');
const DEFAULT_EXTRA = path.join(__dirname, '..', '..', 'config', 'x-influencers', 'antik-pro-extra.csv');

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function importInfluencerCsvs(numericPath = DEFAULT_NUMERIC, extraPath = DEFAULT_EXTRA) {
  const rows = parseAndMergeInfluencerCsvs(readIfExists(numericPath), readIfExists(extraPath));
  db.upsertXInfluencers(rows);
  return { imported: rows.length, numericPath, extraPath };
}

/** Si la tabla está vacía, carga los CSV canónicos (arranque de la app). */
function seedXInfluencersIfEmpty() {
  if (db.countXInfluencers() > 0) {
    return { seeded: false, total: db.countXInfluencers() };
  }
  const result = importInfluencerCsvs();
  return { seeded: true, total: result.imported };
}

function applyInfluencerAccountTypes(sample, classifications, influencerMap) {
  const map = influencerMap || db.getXInfluencerMap();
  return classifications.map((row, i) => {
    if (row.sentiment === 'ruido' || row.accountType === 'ruido') {
      return { ...row, sentiment: 'ruido', accountType: 'ruido', reclamosGeo: [] };
    }
    const handle = normalizeHandle(sample[i]?.username);
    if (handle && map.has(handle)) {
      return { ...row, accountType: 'oficial' };
    }
    return row;
  });
}

function formatInfluencerPromptBlock(sample, influencerMap) {
  const map = influencerMap || db.getXInfluencerMap();
  const lines = [];
  for (let i = 0; i < sample.length; i++) {
    const handle = normalizeHandle(sample[i]?.username);
    const row = handle ? map.get(handle) : null;
    if (!row) continue;
    const idLabel = row.tipoIdentidad === 'con_identidad' ? 'con identidad' : 'sin identidad';
    lines.push(
      `- Ítem ${i + 1} (@${handle}): padrón ANTIK-PRO (${idLabel}). accountType fijo "oficial". Clasificá igual sentiment y reclamosGeo.`
    );
  }
  if (lines.length === 0) return '';
  return `
=== CUENTAS DEL PADRÓN ANTIK-PRO (accountType fijo oficial) ===
${lines.join('\n')}
`;
}

function isIdentifiedInfluencer(username, influencerMap) {
  if (!influencerMap) return false;
  const handle = normalizeHandle(username);
  const row = handle ? influencerMap.get(handle) : null;
  return row?.tipoIdentidad === 'con_identidad';
}

module.exports = {
  DEFAULT_NUMERIC,
  DEFAULT_EXTRA,
  importInfluencerCsvs,
  seedXInfluencersIfEmpty,
  applyInfluencerAccountTypes,
  formatInfluencerPromptBlock,
  isIdentifiedInfluencer,
};
