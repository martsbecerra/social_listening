// ==========================================================================
// influencersParse.js — CSV ANTIK-PRO → filas normalizadas + merge.
// ==========================================================================

const { parseCount } = require('./parseCount');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => String(cell).trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((cell) => String(cell).trim())) rows.push(row);
  }
  return rows;
}

function normalizeHandle(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, '')
    .replace(/^@+/, '')
    .trim()
    .toLowerCase();
}

function normalizeIdentity(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.includes('con identidad')) return 'con_identidad';
  if (s.includes('sin identidad')) return 'sin_identidad';
  return 'sin_identidad';
}

function normalizeLista(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'antik-pro';
  return s.replace(/\s+/g, '-');
}

/**
 * @param {string} csvText
 * @param {{ preferNumeric?: boolean, source?: string }} [opts]
 * @returns {Array<{ handle: string, lista: string, tipoIdentidad: string, seguidores: number|null, source: string }>}
 */
function parseInfluencerCsv(csvText, opts = {}) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];
  const body = rows.slice(1);
  const out = [];
  for (const cols of body) {
    const handle = normalizeHandle(cols[2]);
    if (!handle) continue;
    out.push({
      handle,
      lista: normalizeLista(cols[0]) || 'antik-pro',
      tipoIdentidad: normalizeIdentity(cols[1]),
      seguidores: parseCount(cols[3]),
      source: opts.source || 'csv',
      preferNumeric: Boolean(opts.preferNumeric),
    });
  }
  return out;
}

/**
 * Unión por handle. Si hay conflicto de seguidores, gana la fila
 * `preferNumeric` (archivo de enteros). Identidad: con_identidad gana.
 * @param {Array} rows
 */
function mergeInfluencerRows(rows) {
  const byHandle = new Map();
  for (const row of rows) {
    if (!row?.handle) continue;
    const existing = byHandle.get(row.handle);
    if (!existing) {
      byHandle.set(row.handle, {
        handle: row.handle,
        lista: row.lista || 'antik-pro',
        tipoIdentidad: row.tipoIdentidad || 'sin_identidad',
        seguidores: row.seguidores ?? null,
      });
      continue;
    }
    if (row.tipoIdentidad === 'con_identidad') {
      existing.tipoIdentidad = 'con_identidad';
    }
    if (existing.seguidores == null && row.seguidores != null) {
      existing.seguidores = row.seguidores;
    } else if (row.preferNumeric && row.seguidores != null) {
      existing.seguidores = row.seguidores;
    }
    if (row.lista) existing.lista = row.lista;
  }
  return [...byHandle.values()].sort((a, b) => a.handle.localeCompare(b.handle, 'es'));
}

function parseAndMergeInfluencerCsvs(numericCsvText, extraCsvText) {
  const numeric = parseInfluencerCsv(numericCsvText, {
    preferNumeric: true,
    source: 'antik-pro',
  });
  const extra = parseInfluencerCsv(extraCsvText, {
    preferNumeric: false,
    source: 'antik-pro-extra',
  });
  return mergeInfluencerRows([...numeric, ...extra]);
}

module.exports = {
  parseCsv,
  normalizeHandle,
  normalizeIdentity,
  parseInfluencerCsv,
  mergeInfluencerRows,
  parseAndMergeInfluencerCsvs,
};
