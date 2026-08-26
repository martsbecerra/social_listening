// ==========================================================================
// clasificarReclamo.js
// --------------------------------------------------------------------------
// Paso 2 de la clasificación de reclamos: la SUBCATEGORÍA.
//
// Por qué en dos pasos. El esquema del cliente tiene 26 categorías y 85
// subcategorías, varias de ellas frases largas con ejemplos. Mandar el árbol
// completo en cada llamada cuesta miles de tokens de entrada por análisis, y
// la mayoría serían de categorías que ese análisis ni toca.
//
// Entonces: el paso 1 (la categoría) ya viene en el structured output del
// análisis — son 26 opciones cortas, no justifica una llamada aparte. El paso
// 2 es UNA sola llamada por análisis, no una por reclamo: se juntan todos los
// reclamos detectados, se agrupan por categoría y se manda únicamente la
// sublista de las categorías presentes. Con 5 reclamos en 2 categorías van 2
// sublistas, no 26.
//
// Lo que devuelva el modelo se valida contra el JSON en Node
// (categoriasConfig): si la subcategoría no pertenece a su categoría, queda
// vacía. Preferimos un dato parcial correcto a uno completo inventado.
// ==========================================================================

const { requestText } = require('./llm');
const { subcategoriasDe, resolveSubcategoria, resolveCategoria } = require('./categoriasConfig');

const MAX_TOKENS = 1500;
// Tope de reclamos por llamada. Con más, el prompt se vuelve largo y el modelo
// empieza a perder la correspondencia por índice.
const CHUNK_SIZE = 25;

// Se pide el NÚMERO de la subcategoría, no su texto. Copiar textos largos y
// parecidos entre sí ("Reclamos por falta de limpieza y recolección de
// residuos" vs "Quejas por falta de limpieza en la vía pública...") hace que
// el modelo cambie una palabra al transcribir y la validación lo rechace, aun
// habiendo elegido bien. Con un número no hay transcripción posible: o el
// índice existe o no. Además baja los tokens de salida.
const SYSTEM_PROMPT = `Sos un clasificador de reclamos vecinales de la Ciudad de Buenos Aires.
Cada reclamo YA tiene asignada su categoría. Tu única tarea es elegir la SUBCATEGORÍA que le corresponde, de la lista numerada de esa categoría.

Reglas:
- Devolvé el NÚMERO de la subcategoría dentro de la lista de SU categoría.
- Si ninguna subcategoría de esa categoría describe el reclamo, devolvé 0. Es una respuesta válida y preferible a forzar una que no corresponde.
- No uses números de otra categoría ni inventes opciones.

Respondé SOLO un JSON, sin texto adicional ni markdown, con esta forma exacta:
{"asignaciones": [{"i": 1, "sub": 3}, {"i": 2, "sub": 0}]}
Devolvé un elemento por cada reclamo numerado, con su mismo número en "i".`;

/**
 * Arma el bloque de opciones: sólo las sublistas de las categorías presentes,
 * numeradas desde 1 dentro de cada categoría.
 * @param {string[]} categorias nombres canónicos, sin repetir
 */
function buildOpciones(categorias) {
  return categorias
    .map((cat) => {
      const subs = subcategoriasDe(cat);
      const items =
        subs.length > 0 ? subs.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  (sin subcategorías)';
      return `Categoría "${cat}":\n${items}\n  0. ninguna de las anteriores`;
    })
    .join('\n\n');
}

function buildUserPrompt(items) {
  const categorias = [...new Set(items.map((it) => it.categoria))];
  const lista = items
    .map((it, i) => {
      const dir = it.direccionDetectada ? ` | ubicación: ${it.direccionDetectada}` : '';
      return `${i + 1}. [${it.categoria}]${dir}\n   texto: ${String(it.texto || '').slice(0, 600)}`;
    })
    .join('\n');

  return `SUBCATEGORÍAS DISPONIBLES (usá sólo las de la categoría de cada reclamo):

${buildOpciones(categorias)}

RECLAMOS A CLASIFICAR:

${lista}`;
}

function extractJson(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

/**
 * Asigna subcategoría a un lote de reclamos que YA tienen categoría.
 *
 * No tira nunca: si el LLM falla, todos quedan con subcategoría vacía. El
 * reclamo con su categoría ya es utilizable; perder el análisis entero porque
 * no se pudo afinar el segundo nivel sería peor.
 *
 * @param {Array<{categoria: string, texto: string, direccionDetectada?: string}>} reclamos
 * @returns {Promise<{subcategorias: string[], usage: object|null, llamadas: number}>}
 *   `subcategorias` viene en el mismo orden que `reclamos`.
 */
async function asignarSubcategorias(reclamos) {
  const total = Array.isArray(reclamos) ? reclamos.length : 0;
  const resultado = new Array(total).fill('');
  if (total === 0) return { subcategorias: resultado, usage: null, llamadas: 0 };

  // Los que no tienen categoría válida no van al modelo: no hay sublista que
  // ofrecerle. Quedan en "" y los resuelve la validación de db.upsertReclamo.
  const indices = [];
  for (let i = 0; i < total; i++) {
    const cat = resolveCategoria(reclamos[i] && reclamos[i].categoria);
    if (cat && subcategoriasDe(cat).length > 0) indices.push(i);
  }
  if (indices.length === 0) return { subcategorias: resultado, usage: null, llamadas: 0 };

  let usage = null;
  let llamadas = 0;

  for (let desde = 0; desde < indices.length; desde += CHUNK_SIZE) {
    const loteIdx = indices.slice(desde, desde + CHUNK_SIZE);
    const items = loteIdx.map((i) => ({
      categoria: resolveCategoria(reclamos[i].categoria),
      texto: reclamos[i].texto,
      direccionDetectada: reclamos[i].direccionDetectada,
    }));

    try {
      const { text, usage: u } = await requestText({
        system: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(items),
        maxTokens: MAX_TOKENS,
      });
      llamadas += 1;
      if (u) {
        usage = usage
          ? {
              inputTokens: usage.inputTokens + u.inputTokens,
              outputTokens: usage.outputTokens + u.outputTokens,
              totalTokens: usage.totalTokens + u.totalTokens,
              ...(u.costUsd != null || usage.costUsd != null
                ? {
                    costUsd: (usage.costUsd || 0) + (u.costUsd || 0),
                    costSource: u.costSource || usage.costSource,
                  }
                : {}),
            }
          : u;
      }

      const parsed = JSON.parse(extractJson(text));
      const asignaciones = Array.isArray(parsed.asignaciones) ? parsed.asignaciones : [];

      for (const a of asignaciones) {
        const pos = Number(a && a.i) - 1;
        if (!Number.isInteger(pos) || pos < 0 || pos >= loteIdx.length) continue;
        const idxReal = loteIdx[pos];
        const cat = resolveCategoria(reclamos[idxReal].categoria);
        const subs = subcategoriasDe(cat);

        // Camino normal: el número de la opción.
        const n = Number(a.sub);
        if (Number.isInteger(n)) {
          if (n === 0) continue; // "ninguna", respuesta válida.
          if (n >= 1 && n <= subs.length) {
            resultado[idxReal] = subs[n - 1];
            continue;
          }
          console.warn(`[subcategoria] índice ${n} fuera de rango para "${cat}" — queda vacía.`);
          continue;
        }

        // Tolerancia: si igual mandó el texto, se intenta resolver.
        const propuesta = a.subcategoria == null ? '' : String(a.subcategoria).trim();
        if (!propuesta) continue;
        const canonica = resolveSubcategoria(cat, propuesta);
        if (canonica) resultado[idxReal] = canonica;
        else console.warn(`[subcategoria] "${propuesta}" no pertenece a "${cat}" — queda vacía.`);
      }
    } catch (err) {
      // Un lote que falla deja sus reclamos sin subcategoría, pero el resto
      // del análisis sigue. La categoría ya está y el reclamo es usable.
      console.error(
        `[subcategoria] falló el lote ${desde / CHUNK_SIZE + 1} (${loteIdx.length} reclamos): ${err.message}. ` +
        'Esos reclamos quedan con subcategoría vacía.'
      );
    }
  }

  return { subcategorias: resultado, usage, llamadas };
}

module.exports = { asignarSubcategorias, CHUNK_SIZE };
