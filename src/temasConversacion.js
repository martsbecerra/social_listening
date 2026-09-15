// ==========================================================================
// temasConversacion.js
// --------------------------------------------------------------------------
// Temas emergentes del análisis (IG y X): normalización, texto WhatsApp y
// armado del reporte alrededor de esa sección (entre KPI 2️⃣ y buckets 3️⃣).
// ==========================================================================

const MAX_TEMAS = 8;
const TEMAS_HEADING = '🗣️ TEMAS DE LA CONVERSACIÓN';

const TEMAS_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titulo: { type: 'string' },
    texto: { type: 'string' },
  },
  required: ['titulo', 'texto'],
};

const TEMAS_ARRAY_SCHEMA = {
  type: 'array',
  items: TEMAS_ITEM_SCHEMA,
  maxItems: MAX_TEMAS,
};

function normalizeTemas(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const titulo = typeof item.titulo === 'string' ? item.titulo.trim() : '';
    const texto = typeof item.texto === 'string' ? item.texto.trim() : '';
    if (!titulo || !texto) continue;
    out.push({ titulo, texto });
    if (out.length >= MAX_TEMAS) break;
  }
  return out;
}

function formatTemasSection(temas) {
  const list = normalizeTemas(temas);
  if (list.length === 0) return '';
  const body = list.map((t, i) => `${i + 1}. ${t.titulo}: ${t.texto}`).join('\n\n');
  return `${TEMAS_HEADING}\n\n${body}`;
}

function assembleReport(beforeTemas, temas, afterTemas) {
  const section = formatTemasSection(temas);
  const before = String(beforeTemas || '').replace(/\s+$/, '');
  const after = String(afterTemas || '').replace(/^\s+/, '');
  if (!section) return `${before}\n\n${after}`;
  return `${before}\n\n${section}\n\n${after}`;
}

module.exports = {
  MAX_TEMAS,
  TEMAS_HEADING,
  TEMAS_ITEM_SCHEMA,
  TEMAS_ARRAY_SCHEMA,
  normalizeTemas,
  formatTemasSection,
  assembleReport,
};
