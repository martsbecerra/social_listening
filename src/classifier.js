// ==========================================================================
// classifier.js
// --------------------------------------------------------------------------
// Clasificación de un posteo del monitoreo en UNA llamada al LLM: relevancia
// (¿habla de Jorge Macri o de la gestión de la Ciudad?), título, sentimiento,
// TEMA y el MOTIVO de la decisión (una frase corta que queda en
// matched_reason, para auditar por qué entró o salió cada posteo). Una sola
// función, clasificarPosteo, para todas las
// plataformas (Instagram, X, ...): solo cambia la etiqueta de la red en el
// prompt (platformLabel).
//
// El tema alimenta la sección Estadísticas y es una categoría de primer nivel
// del mapa de reclamos (config/categorias-reclamos.json, vía
// categoriasConfig): así el tema de un posteo y la categoría de un reclamo
// hablan el mismo idioma. El enum del schema y las líneas del prompt (cada
// categoría con sus subcategorías) se arman de esa lista al cargar, como el
// análisis de publicación (src/analysisSchema.js, src/prompt.js): si el
// cliente cambia el JSON, el clasificador cambia solo. Viene en la misma
// llamada, sin modelo ni llamada aparte, y se pide siempre, también cuando
// relevant es false (ahí no se usa). Lo que devuelve el modelo pasa por
// normalizeClasificacion, el mismo camino que la categoría de un reclamo:
// mayúsculas, acentos y alias se resuelven, y lo que no existe cae en el
// fallback ("Coyuntura / Otros").
//
// Antes había dos caminos y ninguno verificaba geografía: con una keyword
// literal en el caption el posteo entraba sin preguntarle nada al modelo
// (solo título y sentimiento), y sin keyword se le preguntaba a un modelo
// barato si "igual hablaba del Jefe de Gobierno". "Jefe de Gobierno" es
// también el título del titular de la Ciudad de México, y términos como
// "gobierno de la ciudad" o PDLC son ambiguos entre ciudades: eso metía
// falsos positivos. Ahora la coincidencia literal viaja como PISTA de
// contexto (junto con cuenta trackeada, hashtag o búsqueda) y el modelo
// decide siempre. Es una guía, no una garantía.
//
// Va por src/llm/ (requestStructuredAnalysis, con schema: JSON válido y
// enum de sentimiento garantizados), con el MISMO modelo que el análisis de
// publicación — ya no hay un "modelo clasificador" aparte (ver
// src/llm/providerConfig.js). Nunca por el SDK de un proveedor: cambiar
// LLM_PROVIDER migra el monitoreo igual que el análisis.
//
// SOBRE LOS FALLOS: un error del LLM, una respuesta que no cumple el schema
// o un "relevant" que no es booleano devuelven unclassified:true y el posteo
// se guarda igual, con title/sentiment/tema en null → la UI lo muestra como
// "(sin clasificar)" y backfillClassification lo reintenta después.
// Preferimos ruido visible a pérdida silenciosa. Un relevant:false del
// modelo, en cambio, es una respuesta legítima y sí descarta.
// ==========================================================================

// Por el objeto del módulo (no destructurado): los tests stubean
// llm.requestStructuredAnalysis para ejercitar esta función sin red.
const llm = require('./llm');
const { listCategorias, subcategoriasDe, normalizeClasificacion, CATEGORIA_FALLBACK } = require('./categoriasConfig');

const VALID_SENTIMENTS = ['positivo', 'neutral', 'negativo'];
// Temas posibles: los nombres canónicos de las categorías de reclamos, en el
// orden del JSON. Es lo que se guarda en detected_posts.tema y lo que
// Estadísticas muestra, sin mapa de nombres aparte.
const TEMAS = listCategorias();
// Una línea por categoría con sus subcategorías como descripción, tal cual
// están en el JSON (los ejemplos entre paréntesis ayudan a clasificar). Con
// la lista de octubre 2026 (26 categorías, 85 subcategorías) la sección TEMA
// suma unos 5.700 caracteres al system prompt, del orden de 1.500 tokens de
// entrada más por clasificación; el schema solo lleva los nombres.
const TEMAS_PARA_PROMPT = TEMAS.map((nombre) => {
  const subs = subcategoriasDe(nombre);
  return subs.length > 0 ? `- ${nombre}: ${subs.join('; ')}` : `- ${nombre}`;
}).join('\n');
const DEFAULT_PLATFORM_LABEL = 'Instagram';
const MAX_CAPTION_CHARS = 2000;
// Un título de hasta 10 palabras, el sentimiento, el tema, un motivo de hasta
// 12 y el JSON: sobra con esto.
const MAX_TOKENS = 300;
// Una clasificación tarda segundos; si en un minuto no llegó, el proveedor
// está trabado. El provider aborta la request y reintenta una vez (ver
// src/llm/openrouterProvider.js); si tampoco, el posteo queda sin
// clasificar en vez de frenar el ciclo entero durante minutos por posteo.
const TIMEOUT_MS = 60000;
const SCHEMA_NAME = 'clasificacion_posteo';

/** Schema de la respuesta (structured outputs). Estricto: todo requerido, sin extras. */
const CLASIFICACION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevant', 'title', 'sentiment', 'tema', 'motivo'],
  properties: {
    relevant: {
      type: 'boolean',
      description: 'true solo si el posteo habla de Jorge Macri o de la gestión de la Ciudad de Buenos Aires',
    },
    title: { type: 'string', description: 'De qué habla el posteo, en español, máximo 10 palabras' },
    sentiment: { type: 'string', enum: VALID_SENTIMENTS },
    tema: {
      type: 'string',
      // Generado desde config/categorias-reclamos.json, nunca escrito a mano.
      enum: TEMAS,
      description: `Categoría del tema central del posteo, de la lista TEMA del prompt; "${CATEGORIA_FALLBACK}" si no encaja en ninguna`,
    },
    motivo: { type: 'string', description: 'Razón de la decisión en una frase corta (máximo 12 palabras), para auditoría' },
  },
};

function systemPrompt(platformLabel) {
  return `Sos el clasificador de menciones del equipo de monitoreo del Gobierno de la Ciudad de Buenos Aires.

OBJETIVO
Decidir si un posteo de ${platformLabel} habla de Jorge Macri, Jefe de Gobierno de la Ciudad Autónoma de Buenos Aires (CABA), Argentina, o de su gestión (obras, políticas, anuncios, funcionarios y organismos porteños, Legislatura porteña, comunas, servicios de la Ciudad), aunque no lo nombre. Para los que sí, resumir de qué hablan y cómo lo retratan.

ATENCIÓN: "Jefe de Gobierno" es también el título del titular de la Ciudad de México. Un contenido sobre la Ciudad de México NO es relevante aunque use ese título o hable del "gobierno de la ciudad". Lo mismo vale para cualquier otra ciudad o país: relevante es solo lo porteño.

TÉRMINOS AMBIGUOS ENTRE CIUDADES
"Jefe de Gobierno", "gobierno de la ciudad", "la Ciudad", "alcalde", "intendente", "PDLC" / "Policía de la Ciudad" y siglas parecidas solo cuentan si el contexto es claramente porteño. Por sí solos no alcanzan.

SEÑALES A FAVOR (contexto porteño)
- Apodos y variantes con los que se nombra a Jorge Macri en redes: "Blackri", "Blacri", "jorgemacri".
- GCBA (Gobierno de la Ciudad de Buenos Aires), "gobierno porteño", CABA, Ciudad Autónoma de Buenos Aires, porteño/porteña, Legislatura porteña, comunas y barrios porteños (Palermo, Caballito, Villa Lugano, etc.), subte, SUBE, AUSA, Policía de la Ciudad en contexto argentino, hospitales y escuelas de la Ciudad, referencias a Mauricio Macri, Horacio Rodríguez Larreta, el PRO, legisladores porteños.

SEÑALES DE ALERTA (mirar con más cuidado; NO descartan por sí solas)
- Ciudad de México y sus figuras: Clara Brugada, Martí Batres, Ernestina Godoy, Santiago Taboada, Marcelo Ebrard, López Obrador, Claudia Sheinbaum, Morena, PRI, CDMX, GobCDMX, alcaldías (Benito Juárez, Cuauhtémoc, etc.), "Jefa de Gobierno".
- Colombia: Gustavo Petro, Bogotá. España: Pedro Sánchez, Vox, Zapatero. Chile: Boric. Otros países de la región.
REGLA CLAVE: una señal de alerta no descarta el posteo. Si el contenido menciona una de esas figuras Y ADEMÁS habla de Jorge Macri o de la gestión de CABA, es relevante. Se descarta solo cuando el contenido es claramente de otra ciudad o país y no tiene nada que ver con Buenos Aires.

TAMBIÉN SE DESCARTA
- Contenido sobre Mauricio Macri (expresidente) que no involucre a Jorge Macri ni a la gestión porteña.
- Política NACIONAL argentina que no involucre a Jorge Macri ni a la gestión de CABA: gobierno nacional, Javier Milei, sus voceros y ministros (Manuel Adorni, etc.), el Congreso nacional. Que sea política argentina no lo hace relevante; tiene que tocar a Jorge Macri o a la Ciudad.
- Provincia de Buenos Aires o sus municipios cuando no involucran a la Ciudad.
- Contenido genérico, turístico, cultural o comercial sin relación con la gestión, aunque transcurra en Buenos Aires.

PISTA DE CONTEXTO
El mensaje puede incluir una línea "CONTEXTO" con cómo llegó el posteo: contiene un término de nuestra lista de seguimiento, viene de una cuenta trackeada, de un hashtag o de una búsqueda. Los términos de la lista son una guía, no una señal fuerte ni una garantía: explican por qué el posteo llegó hasta acá, pero la decisión es tuya por el contenido; un término de la lista en un posteo de otra ciudad o sin relación con la gestión sigue siendo no relevante. Venir de una cuenta trackeada es una señal débil: las cuentas de política general publican mucho contenido nacional sin relación con la gestión porteña, así que eso solo no alcanza para darlo por relevante.

TEMA
El tema central del posteo: una de estas categorías, copiada tal cual (respetá mayúsculas y acentos). Si toca varias, la que más pesa en el posteo. Después de cada categoría van sus subcategorías: están escritas como reclamos, pero acá describen el tema, así que un anuncio, un logro o un elogio va en la misma categoría que una crítica sobre lo mismo.
${TEMAS_PARA_PROMPT}
Si no encaja en ninguna, "${CATEGORIA_FALLBACK}".

RESPUESTA (JSON según el schema)
- relevant: true solo si habla de Jorge Macri o de la gestión de CABA según lo de arriba.
- title: frase corta (máximo 10 palabras) en español de qué habla el posteo. Siempre, también si relevant es false.
- sentiment: cómo retrata a Jorge Macri o a su gestión. "positivo" si lo muestra favorablemente o destaca un logro; "negativo" si lo critica, cuestiona o muestra un hecho desfavorable; "neutral" si es informativo, no queda claro o relevant es false. Ante la duda, "neutral".
- tema: una de las categorías de TEMA, copiada tal cual. Siempre, también si relevant es false: la más cercana, o "${CATEGORIA_FALLBACK}".
- motivo: una frase corta (máximo 12 palabras) con la razón de la decisión, para auditoría. Ejemplos: "habla de una obra en CABA", "es de la Ciudad de México", "Mauricio Macri sin relación con la gestión porteña", "menciona a Sheinbaum pero critica a Jorge Macri".`;
}

/**
 * Línea CONTEXTO del mensaje de usuario, a partir de la pista que arma
 * evaluateRelevance con cómo llegó el posteo. Sin pista, sin línea.
 * @param {{ termino?: string|null, cuenta?: string|null, hashtag?: boolean, busqueda?: string|null } | null} pista
 */
function renderContexto(pista, platformLabel) {
  if (!pista) return '';
  const partes = [];
  if (pista.termino) partes.push(`el texto contiene el término "${pista.termino}" de nuestra lista de seguimiento`);
  if (pista.busqueda) partes.push(`llegó por la búsqueda del término "${pista.busqueda}" en ${platformLabel}`);
  if (pista.hashtag) partes.push('llegó por un hashtag monitoreado (la página del hashtag trae todo lo que lo usa)');
  if (pista.cuenta) partes.push(`es de la cuenta trackeada @${pista.cuenta}`);
  return partes.length > 0 ? `CONTEXTO: ${partes.join('; ')}.\n` : '';
}

function buildUserPrompt(caption, { pista, platformLabel }) {
  return `${renderContexto(pista, platformLabel)}POSTEO:\n${caption.slice(0, MAX_CAPTION_CHARS)}`;
}

/**
 * Resultado cuando no se pudo clasificar (API caída, respuesta fuera del
 * schema). relevant:true para que el posteo se guarde; title, sentiment y
 * tema en null a propósito: es lo que hace que aparezca como "(sin
 * clasificar)" en la tabla y que listUnclassified() lo agarre en el próximo
 * backfill (su criterio es title IS NULL o tema IS NULL).
 */
function unclassifiedResult() {
  return { relevant: true, title: null, sentiment: null, tema: null, motivo: null, unclassified: true };
}

/** Log uniforme, distinguiendo el tipo de fallo para poder diagnosticar. */
function logClassifierFailure(err) {
  const motivo = err.isApiFailure ? 'falló la API del LLM' : 'respuesta inválida del modelo';
  console.error(
    `Clasificador: ${motivo} — el posteo se guarda SIN CLASIFICAR ` +
    `y se reintenta en el próximo backfill. Detalle: ${err.message}`
  );
}

/**
 * Clasifica un caption en una sola llamada: relevancia + título + sentimiento
 * + tema + motivo. Si el LLM falla o responde algo fuera del schema, devuelve
 * unclassified:true en vez de inventar un "neutral" o un "no relevante".
 * @param {string} caption
 * @param {{ platformLabel?: string, pista?: object|null }} [options]
 *   platformLabel: etiqueta de la red para el prompt; pista: cómo llegó el
 *   posteo (ver renderContexto), va como contexto para el modelo.
 * @returns {Promise<{ relevant: boolean, title: string|null, sentiment: string|null, tema: string|null, motivo: string|null, unclassified?: true }>}
 *   tema: una de TEMAS (nombre canónico de la categoría); null solo si no
 *   se pudo clasificar.
 */
async function clasificarPosteo(caption, { platformLabel = DEFAULT_PLATFORM_LABEL, pista = null } = {}) {
  if (!caption || !caption.trim()) {
    // Nada que evaluar; quien llama decide qué hacer con un posteo sin texto
    // (evaluateRelevance ni siquiera llega acá). El backfill sí puede llegar
    // con uno viejo: con el tema de fallback no queda pendiente para siempre.
    return { relevant: false, title: 'Sin descripción', sentiment: 'neutral', tema: CATEGORIA_FALLBACK, motivo: null };
  }

  try {
    const { parsed } = await llm.requestStructuredAnalysis({
      system: systemPrompt(platformLabel),
      userPrompt: buildUserPrompt(caption, { pista, platformLabel }),
      schema: CLASIFICACION_SCHEMA,
      schemaName: SCHEMA_NAME,
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
    });

    if (!parsed || typeof parsed.relevant !== 'boolean') {
      throw new Error('el modelo no devolvió un campo "relevant" booleano');
    }
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
    const sentiment = VALID_SENTIMENTS.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    // Con structured outputs el enum viene garantizado; sin él (el respaldo
    // json_object de OpenRouter) puede llegar otra cosa. Mismo camino que la
    // categoría de un reclamo: lo que no existe cae en el fallback, con aviso.
    const { categoria: tema } = normalizeClasificacion({ categoria: parsed.tema, contexto: 'tema de un posteo del monitoreo' });
    const motivo = typeof parsed.motivo === 'string' && parsed.motivo.trim() ? parsed.motivo.trim() : null;

    if (!parsed.relevant) return { relevant: false, title, sentiment, tema, motivo };

    // Dijo que es relevante pero no dio título: sirve como hallazgo, no como
    // clasificación — se guarda para reintentar el título después.
    if (!title) return unclassifiedResult();

    return { relevant: true, title, sentiment, tema, motivo };
  } catch (err) {
    logClassifierFailure(err);
    return unclassifiedResult();
  }
}

module.exports = { clasificarPosteo, systemPrompt, CLASIFICACION_SCHEMA, TEMAS };
