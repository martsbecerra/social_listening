// ==========================================================================
// busquedaTope.js
// --------------------------------------------------------------------------
// Cuántos resultados pedirle a una búsqueda (el `maxItems` del actor), y qué
// hacer cuando lo llena (noviembre 2026, openspec/changes/ventana-por-fuente).
// Sin dependencias (no carga la base), como reachRule.js.
//
// El actor no devuelve los resultados por fecha: si una búsqueda llena su
// tope no queda afuera "lo más viejo", queda afuera una parte de CADA día.
// Y el tope base (SEARCH_RESULTS_LIMIT) es el mismo para un término que trae
// 2 resultados por día que para uno que trae 150. Entonces:
//
//   1. El tope de cada búsqueda sale del volumen medido de ESE término: el
//      doble de lo que trajo por hora en su mejor consulta reciente, por las
//      horas que se piden. Nunca menos que el de siempre (el tope base, o el
//      escalado por la ventana) ni más que SEARCH_RESULTS_MAX. Pedir un tope
//      más alto no cuesta: se paga por resultado devuelto.
//   2. Si igual se llena, se hace UNA segunda consulta de la misma ventana
//      con 4 veces el tope ("prefiero pagar el excedente antes que perder
//      publicaciones", decisión del dueño), mientras entre en el techo de
//      gasto por corrida para esas segundas consultas
//      (SEARCH_EXTRA_MAX_USD_PER_CYCLE). El techo no recorta las consultas
//      normales: solo decide si entra una segunda.
//   3. Si no entra, la búsqueda queda marcada "tope lleno" y la corrida,
//      incompleta: se ve.
// ==========================================================================

const DEFAULT_RESULTS_MAX = 2000;
const DEFAULT_EXTRA_MAX_USD = 2;
// La segunda consulta pide esta cantidad de veces el tope de la primera.
const RELAUNCH_FACTOR = 4;
// Cuántas consultas recientes del término se miran para medir su volumen.
const HISTORY_CALLS = 6;
const HOUR_MS = 60 * 60 * 1000;

function invalid(name, raw, hint) {
  // El nombre de la variable va en el message (al log); el userMessage, sin él.
  const e = new Error(`${name}="${raw}" no es válido: ${hint}.`);
  e.userMessage = 'Falta configuración del servidor.';
  return e;
}

/**
 * SEARCH_RESULTS_MAX (entero, 1 o más; default 2000) y
 * SEARCH_EXTRA_MAX_USD_PER_CYCLE (número, 0 o más, con punto o coma; default
 * 2; 0 apaga las segundas consultas). Un valor mal escrito tira (server.js
 * aborta el arranque con ese mensaje).
 * @returns {{ resultsMax: number, extraMaxUsd: number }}
 */
function resolveTopeConfig(env = process.env) {
  let resultsMax = DEFAULT_RESULTS_MAX;
  const rawMax = env.SEARCH_RESULTS_MAX;
  if (rawMax !== undefined && String(rawMax).trim() !== '') {
    const text = String(rawMax).trim();
    if (!/^\d+$/.test(text) || Number(text) < 1) throw invalid('SEARCH_RESULTS_MAX', rawMax, 'tiene que ser un entero, 1 o más, sin separador de miles');
    resultsMax = Number(text);
  }
  let extraMaxUsd = DEFAULT_EXTRA_MAX_USD;
  const rawUsd = env.SEARCH_EXTRA_MAX_USD_PER_CYCLE;
  if (rawUsd !== undefined && String(rawUsd).trim() !== '') {
    const text = String(rawUsd).trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(text)) throw invalid('SEARCH_EXTRA_MAX_USD_PER_CYCLE', rawUsd, 'tiene que ser un número de dólares, 0 o más');
    extraMaxUsd = Number(text);
  }
  return { resultsMax, extraMaxUsd };
}

/** Lo mismo, pero un valor mal escrito vale el default (para el ciclo: ya se validó al arrancar). */
function topeConfig(env = process.env) {
  try {
    return resolveTopeConfig(env);
  } catch {
    return { resultsMax: DEFAULT_RESULTS_MAX, extraMaxUsd: DEFAULT_EXTRA_MAX_USD };
  }
}

/**
 * Cuántas horas pidió una consulta: desde las 00:00 UTC de su `until` hasta
 * `hasta` (cuando se lanzó). Como mínimo 1. null si no se sabe el `until`.
 */
function horasPedidas(until, hasta) {
  const desdeMs = until ? Date.parse(`${String(until).slice(0, 10)}T00:00:00.000Z`) : NaN;
  const hastaMs = typeof hasta === 'number' ? hasta : Date.parse(hasta || '');
  if (!Number.isFinite(desdeMs) || !Number.isFinite(hastaMs)) return null;
  return Math.max(1, (hastaMs - desdeMs) / HOUR_MS);
}

/**
 * Resultados por hora de un término: el MÁXIMO entre sus consultas buenas
 * recientes (una consulta que trajo 0 no baja nada), y el doble si esa
 * consulta llenó su tope (trajo lo que le dejaron, no lo que había). Una
 * consulta sin `until` (anterior a noviembre 2026) se toma como de 24 h.
 * @param {Array<{ items: number, maxItems?: number|null, until?: string|null, at: string }>} calls
 * @returns {number} 0 si no hay historia
 */
function tasaTermino(calls) {
  let max = 0;
  for (const call of Array.isArray(calls) ? calls : []) {
    const items = Number(call && call.items) || 0;
    if (items <= 0) continue;
    const horas = horasPedidas(call.until, call.at) || 24;
    const llena = Number(call.maxItems) > 0 && items >= Number(call.maxItems);
    max = Math.max(max, (items / horas) * (llena ? 2 : 1));
  }
  return max;
}

/**
 * El tope de una búsqueda: el de siempre (`topeDeHoy`: el base, o el
 * escalado por la ventana) o, si el término trae más, el doble de su tasa
 * por las horas pedidas, hasta `resultsMax`. Nunca menor que el de siempre.
 */
function topeParaTermino({ topeDeHoy, tasa = 0, horas = 24, resultsMax = DEFAULT_RESULTS_MAX }) {
  const base = Math.max(1, Math.floor(Number(topeDeHoy) || 1));
  const porVolumen = Math.ceil(2 * (Number(tasa) || 0) * (Number(horas) || 0));
  return Math.max(base, Math.min(Math.floor(resultsMax), porVolumen));
}

/**
 * Cuántos resultados se espera que traiga una búsqueda, por su historia: el
 * promedio de sus consultas buenas recientes de una ventana PARECIDA (entre
 * la mitad y el doble de las horas que se piden ahora). Lo que trae una
 * búsqueda no crece parejo con la ventana (sonda del 16/11/2026: 4
 * resultados con 1 día, 400 con 7), así que una consulta corta no sirve para
 * estimar una honda ni al revés; sin ninguna parecida, la tasa del término
 * por las horas pedidas, que es lo mejor que hay. Nunca más que el tope.
 * @param {{ calls: Array<{ items: number, maxItems?: number|null, until?: string|null, at: string }>, horas: number, tope: number }} input
 * @returns {number|null} null sin historia
 */
function estimarResultados({ calls, horas, tope }) {
  const lista = Array.isArray(calls) ? calls : [];
  const pedidas = Number(horas) > 0 ? Number(horas) : 24;
  const techo = Number(tope) > 0 ? Math.floor(Number(tope)) : Infinity;
  const parecidas = lista.filter((call) => {
    const h = horasPedidas(call && call.until, call && call.at) || 24;
    return h >= pedidas / 2 && h <= pedidas * 2;
  });
  if (parecidas.length > 0) {
    const promedio = parecidas.reduce((sum, call) => sum + (Number(call.items) || 0), 0) / parecidas.length;
    return Math.min(techo, Math.round(promedio));
  }
  const tasa = tasaTermino(lista);
  if (tasa <= 0) return null;
  return Math.min(techo, Math.round(tasa * pedidas));
}

/**
 * Costo de las búsquedas de una corrida, antes de lanzarlas: el estimado
 * (con lo que se espera que traiga cada una) y el techo (todas llenan su
 * tope). `usdDe(resultados)` es lo que cuesta una búsqueda con esa cantidad
 * (apifyCost.maxUsdForSearch): se inyecta para que este módulo no cargue
 * nada. Una búsqueda sin historia cuenta solo su consulta en el estimado.
 * @param {Array<{ estimado: number|null, limit: number }>} busquedas
 * @param {(resultados: number) => number} usdDe
 * @returns {{ estimado: number, techo: number, sinHistoria: number, n: number }}
 */
function costoDeBusquedas(busquedas, usdDe) {
  const lista = Array.isArray(busquedas) ? busquedas : [];
  let estimado = 0;
  let techo = 0;
  let sinHistoria = 0;
  for (const b of lista) {
    if (b.estimado == null) sinHistoria += 1;
    estimado += usdDe(b.estimado == null ? 0 : b.estimado);
    techo += usdDe(b.limit);
  }
  return { estimado, techo, sinHistoria, n: lista.length };
}

/** El tope de la segunda consulta: 4 veces el de la primera, hasta `resultsMax`. null si ya no hay más que pedir. */
function topeRelanzamiento(tope, resultsMax = DEFAULT_RESULTS_MAX) {
  const siguiente = Math.min(Math.floor(resultsMax), Math.floor(Number(tope) || 0) * RELAUNCH_FACTOR);
  return siguiente > tope ? siguiente : null;
}

/**
 * El techo de gasto de una corrida para las SEGUNDAS consultas. `reservar`
 * aparta lo máximo que puede costar una (si entra) y dice si entró.
 * @returns {{ reservar: (usd: number) => boolean, reservado: () => number, techo: number }}
 */
function crearPresupuesto({ extraMaxUsd = DEFAULT_EXTRA_MAX_USD } = {}) {
  const techo = Math.max(0, Number(extraMaxUsd) || 0);
  let reservado = 0;
  return {
    techo,
    reservado: () => reservado,
    reservar(usd) {
      const costo = Number(usd);
      if (!Number.isFinite(costo) || costo <= 0) return false;
      // Con una tolerancia mínima, para que 4 × 0,5 entre en un techo de 2.
      if (reservado + costo > techo + 1e-9) return false;
      reservado += costo;
      return true;
    },
  };
}

/** "tope máximo 2.000 por búsqueda · hasta US$ 2,00 por corrida en segundas consultas", para la línea del arranque. */
function describeTopeConfig({ resultsMax, extraMaxUsd } = topeConfig()) {
  const miles = String(resultsMax).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return extraMaxUsd > 0
    ? `tope máximo ${miles} resultados por búsqueda · si una llena su tope se pide más, hasta US$ ${extraMaxUsd.toFixed(2).replace('.', ',')} por corrida`
    : `tope máximo ${miles} resultados por búsqueda · sin segunda consulta cuando una llena su tope`;
}

module.exports = {
  estimarResultados,
  costoDeBusquedas,
  DEFAULT_RESULTS_MAX,
  DEFAULT_EXTRA_MAX_USD,
  RELAUNCH_FACTOR,
  HISTORY_CALLS,
  resolveTopeConfig,
  topeConfig,
  horasPedidas,
  tasaTermino,
  topeParaTermino,
  topeRelanzamiento,
  crearPresupuesto,
  describeTopeConfig,
};
