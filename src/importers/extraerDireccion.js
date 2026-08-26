// ==========================================================================
// importers/extraerDireccion.js
// --------------------------------------------------------------------------
// Decide, leyendo el TEXTO de cada fila importada, si hay una ubicación
// accionable y de qué tipo. Mismas reglas que el análisis de publicación
// (ver src/prompt.js), pero acá el input es una fila de archivo, no un
// comentario de Instagram.
//
// POR QUÉ NO SE CONFÍA EN LA COLUMNA `direccion` DEL ARCHIVO. El histórico de
// X trae una dirección por fila, pero salió de un extractor ingenuo y está
// llena de falsos positivos: "hasta las 18h" -> "Carreras, Santiago de las
// 18"; "antes de las 7am" -> "...de las 7"; "mi hijo vive en España" ->
// "España Av.". En el 28% de las filas el nombre de calle no aparece en
// ningún lado del texto. Si se importara tal cual, el mapa quedaría lleno de
// pines precisos en lugares equivocados.
//
// Entonces la columna entra como PISTA (el modelo la ve y la puede confirmar),
// pero el texto manda. El valor original del archivo se guarda igual en
// `direccion_detectada`, aunque el modelo lo descarte, para poder auditar
// después si el criterio está descartando de más.
// ==========================================================================

const { requestText } = require('../llm');

const MAX_TOKENS = 2000;
// Filas por llamada. Los textos son tuits (~270 caracteres): con 15 el prompt
// queda holgado y el modelo no pierde la correspondencia por índice.
const CHUNK_SIZE = 15;

const SYSTEM_PROMPT = `Sos un extractor de ubicaciones de reclamos vecinales de la Ciudad de Buenos Aires.
Para cada texto numerado tenés que decidir si menciona una ubicación ACCIONABLE, es decir, un lugar al que se podría mandar una cuadrilla.

SÍ son accionables (devolvé el tipo correspondiente):
- "calle_altura": calle con número. Ej: "Juramento 3109", "un bache en Salta 250".
- "cruce": esquina entre dos calles. Ej: "Nazca y Rivadavia", "Corrientes esquina Medrano".
- "tramo": una calle entre otras dos. Ej: "Cabildo entre Juramento y Mendoza".
- "lugar_nombrado": lugar con nombre propio y ubicación única: plazas, parques, estaciones, hospitales, escuelas, monumentos, clubes. Ej: "Plaza Italia", "Hospital Durand", "estación Palermo".

NO son accionables. Devolvé tipo null:
- Un barrio solo: "vivo en Palermo", "esto pasa en Almagro".
- Una comuna, la ciudad, una provincia o un país: "la Comuna 7", "en CABA", "mi hijo vive en España".
- Referencias vagas: "en el centro", "por mi casa", "toda la zona", "a la vuelta".
- Números que NO son altura: horarios ("hasta las 18h", "a las 7am"), fechas, precios ("por 200 pesos"), cantidades ("1 o 2 o 3"). Un número cerca de un nombre de calle no lo convierte en dirección.

IMPORTANTE sobre la PISTA: a cada texto puede acompañarlo una dirección sugerida por un sistema anterior, poco confiable. Usala sólo si el TEXTO la respalda. Si el texto no menciona esa calle ni ese lugar, ignorala y devolvé null: esa pista suele venir de confundir un horario o un precio con una altura.

Respondé SOLO un JSON, sin markdown, con esta forma exacta:
{"ubicaciones": [{"i": 1, "direccion": "Juramento 3109", "tipo": "calle_altura"}, {"i": 2, "direccion": null, "tipo": null}]}
Un elemento por cada texto numerado, con su mismo número en "i". En "direccion" va la cita del texto, no la pista.`;

function buildUserPrompt(items) {
  return items
    .map((it, i) => {
      const pista = it.pista ? `\n   pista (poco confiable): ${it.pista}` : '';
      return `${i + 1}. ${String(it.texto || '').slice(0, 700)}${pista}`;
    })
    .join('\n\n');
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

const TIPOS_VALIDOS = new Set(['calle_altura', 'cruce', 'tramo', 'lugar_nombrado']);

/**
 * @param {Array<{texto: string, pista?: string}>} filas
 * @param {{ onProgress?: (hechas: number, total: number) => void }} [opts]
 * @returns {Promise<{ ubicaciones: Array<{direccion: string|null, tipo: string|null}>, usage: object|null, llamadas: number }>}
 *   `ubicaciones` viene en el mismo orden que `filas`.
 */
async function extraerUbicaciones(filas, { onProgress } = {}) {
  const total = Array.isArray(filas) ? filas.length : 0;
  const salida = new Array(total).fill(null).map(() => ({ direccion: null, tipo: null }));
  if (total === 0) return { ubicaciones: salida, usage: null, llamadas: 0 };

  let usage = null;
  let llamadas = 0;

  for (let desde = 0; desde < total; desde += CHUNK_SIZE) {
    const lote = filas.slice(desde, desde + CHUNK_SIZE);

    try {
      const { text, usage: u } = await requestText({
        system: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(lote),
        maxTokens: MAX_TOKENS,
      });
      llamadas += 1;
      usage = sumarUsage(usage, u);

      const parsed = JSON.parse(extractJson(text));
      const ubic = Array.isArray(parsed.ubicaciones) ? parsed.ubicaciones : [];
      for (const it of ubic) {
        const pos = Number(it && it.i) - 1;
        if (!Number.isInteger(pos) || pos < 0 || pos >= lote.length) continue;
        const tipo = TIPOS_VALIDOS.has(it.tipo) ? it.tipo : null;
        const dir = it.direccion == null ? '' : String(it.direccion).trim();
        // Sin tipo válido no hay ubicación, aunque haya mandado un texto.
        salida[desde + pos] = tipo && dir ? { direccion: dir, tipo } : { direccion: null, tipo: null };
      }
    } catch (err) {
      // Un lote que falla deja esas filas sin ubicación: se guardan igual con
      // geo_status 'sin_direccion', que es el mismo destino que una fila sin
      // dirección. No se pierde ninguna.
      console.error(
        `[importar] falló la extracción del lote ${Math.floor(desde / CHUNK_SIZE) + 1} ` +
        `(${lote.length} filas): ${err.message}. Esas filas quedan sin ubicación.`
      );
    }

    if (onProgress) onProgress(Math.min(desde + CHUNK_SIZE, total), total);
  }

  return { ubicaciones: salida, usage, llamadas };
}

function sumarUsage(a, b) {
  if (!b) return a;
  if (!a) return b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.costUsd != null || b.costUsd != null
      ? { costUsd: (a.costUsd || 0) + (b.costUsd || 0), costSource: b.costSource || a.costSource }
      : {}),
  };
}

module.exports = { extraerUbicaciones, sumarUsage, CHUNK_SIZE };
