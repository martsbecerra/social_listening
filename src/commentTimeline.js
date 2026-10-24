// ==========================================================================
// commentTimeline.js — "Cuándo comentaron" del análisis de publicación.
// --------------------------------------------------------------------------
// Cuenta los comentarios traídos por tramo de tiempo desde la publicación
// hasta el último comentario. Sin dependencias (no carga la base).
//
// - Sobre TODOS los comentarios traídos, no la muestra: la muestra está
//   ordenada por likes y dejaría la curva sesgada.
// - Solo con la fecha de la publicación y al menos MIN_CON_FECHA (10)
//   comentarios con fecha; si no, null y la pantalla no muestra el bloque.
// - El tramo sale del largo de la ventana: por hora hasta 48 h, de a 6 h
//   hasta 7 días, por día después.
// - Un comentario con fecha anterior a la publicación (relojes) cuenta en
//   el primer tramo.
// ==========================================================================

const MIN_CON_FECHA = 10;
const HORA_MS = 3600 * 1000;

function toMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function unidadHorasPara(ventanaMs) {
  if (ventanaMs <= 48 * HORA_MS) return 1;
  if (ventanaMs <= 7 * 24 * HORA_MS) return 6;
  return 24;
}

/**
 * @param {{ postedAt: string|null, comments: Array<{ timestamp?: string|null }> }} params
 * @returns {null | {
 *   desde: string, hasta: string, unidadHoras: 1|6|24,
 *   tramos: Array<{ h: number, n: number }>,
 *   pico: { indice: number, h: number, n: number },
 *   conFecha: number, total: number,
 * }} `h`: horas desde la publicación al empezar el tramo. `pico`: el tramo
 *   con más comentarios (a igualdad, el primero).
 */
function buildCommentTimeline({ postedAt, comments }) {
  const desdeMs = toMs(postedAt);
  const lista = Array.isArray(comments) ? comments : [];
  if (desdeMs === null) return null;
  const fechas = lista.map((c) => toMs(c && c.timestamp)).filter((ms) => ms !== null);
  if (fechas.length < MIN_CON_FECHA) return null;

  const hastaMs = Math.max(desdeMs, ...fechas);
  const unidadHoras = unidadHorasPara(hastaMs - desdeMs);
  const tramoMs = unidadHoras * HORA_MS;
  const cantidad = Math.max(1, Math.floor((hastaMs - desdeMs) / tramoMs) + 1);
  const tramos = Array.from({ length: cantidad }, (_, i) => ({ h: i * unidadHoras, n: 0 }));
  for (const ms of fechas) {
    const i = Math.min(cantidad - 1, Math.max(0, Math.floor((ms - desdeMs) / tramoMs)));
    tramos[i].n += 1;
  }
  let indice = 0;
  tramos.forEach((t, i) => {
    if (t.n > tramos[indice].n) indice = i;
  });
  return {
    desde: new Date(desdeMs).toISOString(),
    hasta: new Date(hastaMs).toISOString(),
    unidadHoras,
    tramos,
    pico: { indice, h: tramos[indice].h, n: tramos[indice].n },
    conFecha: fechas.length,
    total: lista.length,
  };
}

module.exports = { buildCommentTimeline, MIN_CON_FECHA };
