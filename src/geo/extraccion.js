// ==========================================================================
// geo/extraccion.js
// --------------------------------------------------------------------------
// La ubicación estructurada de reclamos YA GUARDADOS (fase H, el reproceso
// de scripts/geo-reprocesar.js): solo la ubicación, con las mismas reglas
// que la tanda del análisis (REGLAS_UBICACION de src/prompt.js), el mismo
// schema y la misma validación (validateAnalysis.sanitizeUbicacion). No
// vuelve a clasificar tono, postura ni temas. Por tandas, de a una, con un
// tope de gasto: con lo gastado en el tope no sale ninguna llamada más.
//
// Precios para la estimación (--costo): los que cobró el modelo en las
// corridas reales del 25/10/2026 (US$ 2 por millón de tokens de entrada y
// 10 por millón de salida, el ajuste da exacto en las 11 llamadas) y 1,83
// caracteres por token en estos textos. La salida depende de cuánto razone
// el modelo: va como rango.
// ==========================================================================

const llm = require('../llm');
const { REGLAS_UBICACION } = require('../prompt');
const { UBICACION_SCHEMA } = require('../analysisSchema');
const { sanitizeUbicacion } = require('../validateAnalysis');

const TANDA = 15;
const MAX_TOKENS = 8000;
const TEXTO_MAX = 700;
const CAPTION_MAX = 400;

const SYSTEM_PROMPT = `Sos un extractor de ubicaciones de reclamos vecinales de la Ciudad de Buenos Aires.
Cada texto numerado ya es un reclamo (un comentario de Instagram o un posteo de X). No lo vuelvas a clasificar: solo devolvé, para cada uno, la ubicación que NOMBRA, con estas reglas.

${REGLAS_UBICACION}

Si el texto no nombra ningún lugar, el tipo es ninguna con todos los campos vacíos.
Si nombra varios lugares, devolvé el del reclamo principal (el problema que se reporta).
A veces viene "lo que se había leído": una ubicación que detectó un sistema anterior. Usala solo si el TEXTO la respalda; si el texto no la nombra, ignorala.
Respondé únicamente con JSON según el schema: un ítem por cada texto numerado, con su mismo número en "i".`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ubicaciones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { i: { type: 'integer', minimum: 1 }, ubicacion: UBICACION_SCHEMA },
        required: ['i', 'ubicacion'],
      },
    },
  },
  required: ['ubicaciones'],
};

const recortar = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * El mensaje de una tanda. Cada ítem: { texto, pista?, caption?, lugarPublicacion? }.
 */
function buildPrompt(items) {
  return items
    .map((it, k) => {
      const lineas = [`${k + 1}. ${recortar(it.texto, TEXTO_MAX)}`];
      if (it.pista) lineas.push(`   lo que se había leído: ${recortar(it.pista, 120)}`);
      if (it.caption) lineas.push(`   texto de la publicación: ${recortar(it.caption, CAPTION_MAX)}`);
      if (it.lugarPublicacion) lineas.push(`   LUGAR DE LA PUBLICACIÓN: ${recortar(it.lugarPublicacion, 120)}`);
      return lineas.join('\n');
    })
    .join('\n\n');
}

const tandas = (items, n = TANDA) => Array.from({ length: Math.ceil(items.length / n) }, (_, k) => items.slice(k * n, k * n + n));

const PRECIO = { entradaPorMillon: 2, salidaPorMillon: 10, caracteresPorToken: 1.83 };
// Salida por texto: el JSON de una ubicación son unos 70 tokens; el resto es
// lo que razona el modelo (en la tanda del análisis, ~160 por comentario).
const SALIDA_POR_TEXTO = { minimo: 80, maximo: 220 };

/**
 * Lo que va a costar, sin llamar a nada: los tokens de entrada salen de los
 * caracteres de cada mensaje (system, schema y texto), la salida es un rango.
 * @returns {{ textos, llamadas, caracteres, tokensEntrada, tokensSalida: { minimo, maximo }, usd: { minimo, maximo } }}
 */
function estimarCosto(items) {
  const lotes = tandas(items);
  const fijo = SYSTEM_PROMPT.length + JSON.stringify(SCHEMA).length;
  const caracteres = lotes.reduce((s, lote) => s + fijo + buildPrompt(lote).length, 0);
  const tokensEntrada = Math.round(caracteres / PRECIO.caracteresPorToken);
  const tokensSalida = { minimo: items.length * SALIDA_POR_TEXTO.minimo, maximo: items.length * SALIDA_POR_TEXTO.maximo };
  const usd = (salida) => (tokensEntrada * PRECIO.entradaPorMillon + salida * PRECIO.salidaPorMillon) / 1e6;
  return { textos: items.length, llamadas: lotes.length, caracteres, tokensEntrada, tokensSalida, usd: { minimo: usd(tokensSalida.minimo), maximo: usd(tokensSalida.maximo) } };
}

/**
 * Extrae la ubicación de cada ítem ({ id, texto, pista?, caption?, lugarPublicacion? }).
 * @param {object[]} items
 * @param {{ tope?: number, modelo?: object, onProgress?: (hechos: number, total: number, usd: number) => void }} [opts]
 *   tope: con lo gastado en el tope no sale ninguna llamada más; modelo: para
 *   los tests (por defecto, src/llm).
 * @returns {Promise<{ ubicaciones: Map<string, object>, usd: number, tokens: number, llamadas: number, fallidas: number, cortadoPorTope: boolean }>}
 */
async function extraerUbicaciones(items, { tope = Infinity, modelo = llm, onProgress = null } = {}) {
  const ubicaciones = new Map();
  let usd = 0;
  let tokens = 0;
  let llamadas = 0;
  let fallidas = 0;
  let cortadoPorTope = false;
  let hechos = 0;
  for (const lote of tandas(items)) {
    if (usd >= tope) {
      cortadoPorTope = true;
      break;
    }
    llamadas += 1;
    try {
      const { parsed, usage } = await modelo.requestStructuredAnalysis({
        system: SYSTEM_PROMPT,
        userPrompt: buildPrompt(lote),
        schema: SCHEMA,
        schemaName: 'ubicacion_reclamos',
        maxTokens: MAX_TOKENS,
      });
      usd += (usage && usage.costUsd) || 0;
      tokens += (usage && usage.totalTokens) || 0;
      for (const fila of (parsed && Array.isArray(parsed.ubicaciones) && parsed.ubicaciones) || []) {
        const k = Number(fila && fila.i) - 1;
        if (!Number.isInteger(k) || k < 0 || k >= lote.length || ubicaciones.has(lote[k].id)) continue;
        ubicaciones.set(lote[k].id, sanitizeUbicacion(fila.ubicacion));
      }
    } catch (err) {
      // Una tanda que falla deja esos reclamos como estaban (lo gastado igual cuenta).
      fallidas += 1;
      if (err && err.tokenUsage) {
        usd += err.tokenUsage.costUsd || 0;
        tokens += err.tokenUsage.totalTokens || 0;
      }
      console.error(`[geo] reproceso: falló una tanda de ${lote.length}: ${err && err.message}`);
    }
    hechos += lote.length;
    if (onProgress) onProgress(hechos, items.length, usd);
  }
  return { ubicaciones, usd, tokens, llamadas, fallidas, cortadoPorTope };
}

module.exports = { SYSTEM_PROMPT, SCHEMA, buildPrompt, estimarCosto, extraerUbicaciones, TANDA, PRECIO, SALIDA_POR_TEXTO };
