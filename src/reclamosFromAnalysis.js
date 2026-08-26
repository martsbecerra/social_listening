// ==========================================================================
// reclamosFromAnalysis.js
// --------------------------------------------------------------------------
// Convierte el reclamosGeo que ya devuelve Claude por comentario (el mismo
// que arma el CSV legacy en reportBuilder.js) en filas listas para
// db.upsertReclamo. No pega a la red ni geocodifica — eso lo hace
// geoWorker.js después. Las filas quedan con geo_status = 'pendiente'.
// ==========================================================================

const crypto = require('crypto');

/** Id determinístico cuando Apify no trajo id de comentario. */
function fallbackId(url, username, text) {
  const hash = crypto
    .createHash('sha1')
    .update(`${url}|${username || ''}|${text || ''}`)
    .digest('hex');
  return `ighash:${hash.slice(0, 16)}`;
}

/**
 * @param {{ url: string, sample: Array, classifications: Array }} params
 * @returns {Array} Filas para db.upsertReclamo (id === comentarioId, únicas
 *   por comentario; sufijo -2/-3 si un comentario menciona varias direcciones).
 */
function buildReclamosFromAnalysis({ url, sample, classifications }) {
  const rows = [];
  const now = new Date().toISOString();

  classifications.forEach((item, i) => {
    const reclamosGeo = item && item.reclamosGeo;
    if (!reclamosGeo || reclamosGeo.length === 0) return;
    const comment = sample[i];
    if (!comment) return;

    const baseId =
      comment.apifyId != null ? `ig:${comment.apifyId}` : fallbackId(url, comment.username, comment.text);

    reclamosGeo.forEach((r, idx) => {
      if (!r || !r.direccionDetectada) return;
      const comentarioId = idx === 0 ? baseId : `${baseId}-${idx + 1}`;
      rows.push({
        id: comentarioId,
        comentarioId,
        plataforma: 'instagram',
        postUrl: url,
        commentUrl: null,
        autor: comment.username || null,
        fecha: comment.timestamp || null,
        detectedAt: now,
        textoOriginal: comment.text || '',
        categoria: r.categoria,
        direccionDetectada: r.direccionDetectada,
        direccionNormalizada: null,
        calle: null,
        altura: null,
        cruce: null,
        x: null,
        y: null,
        comuna: null,
        barrio: null,
        precision: null,
        geoStatus: 'pendiente',
        estado: 'Pendiente',
      });
    });
  });

  return rows;
}

module.exports = { buildReclamosFromAnalysis };
