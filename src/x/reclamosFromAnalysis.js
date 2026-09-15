// ==========================================================================
// reclamosFromAnalysis.js — reclamosGeo del hilo X → filas SQLite.
// ==========================================================================

const crypto = require('crypto');

function fallbackId(url, username, text) {
  const hash = crypto
    .createHash('sha1')
    .update(`${url}|${username || ''}|${text || ''}`)
    .digest('hex');
  return `xhash:${hash.slice(0, 16)}`;
}

function buildReclamosFromAnalysis({ url, sample, classifications }) {
  const rows = [];
  const now = new Date().toISOString();

  classifications.forEach((item, i) => {
    const reclamosGeo = item && item.reclamosGeo;
    if (!reclamosGeo || reclamosGeo.length === 0) return;
    const comment = sample[i];
    if (!comment) return;

    const baseId = comment.id ? `x:${comment.id}` : fallbackId(url, comment.username, comment.text);

    reclamosGeo.forEach((r, idx) => {
      if (!r || !r.direccionDetectada) return;
      const comentarioId = idx === 0 ? baseId : `${baseId}-${idx + 1}`;
      rows.push({
        id: comentarioId,
        comentarioId,
        plataforma: 'x',
        postUrl: url,
        commentUrl: comment.url || null,
        autor: comment.username || null,
        fecha: comment.timestamp || null,
        detectedAt: now,
        textoOriginal: comment.text || '',
        categoria: r.categoria,
        subcategoria: '',
        direccionDetectada: r.direccionDetectada,
        direccionNormalizada: null,
        calle: null,
        altura: null,
        cruce: null,
        x: null,
        y: null,
        comuna: null,
        barrio: null,
        precision: r.tipoUbicacion === 'lugar_nombrado' ? 'aproximada' : 'exacta',
        geoStatus: 'pendiente',
        estado: 'Pendiente',
      });
    });
  });

  return rows;
}

module.exports = { buildReclamosFromAnalysis };
