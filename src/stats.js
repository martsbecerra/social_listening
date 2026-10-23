'use strict';

// ==========================================================================
// stats.js — Los números de la sección Estadísticas.
// --------------------------------------------------------------------------
// GET /api/monitoring/stats (src/statsRoutes.js) devuelve en una sola
// respuesta todos los bloques del período, para que todos los gráficos
// muestren el mismo recorte. Este módulo:
//   - resuelve el período en hora de Argentina y el anterior, de igual largo;
//   - tiene una función pura por bloque (recibe filas, devuelve números);
//   - armarEstadisticas lee la base y arma la respuesta.
//
// Reglas de conteo:
//   - Posteos visibles (ignored = 0), recortados por posted_at (cuándo se
//     publicó), no por detected_at.
//   - Sentimiento null = neutral. Tema null = "Coyuntura / Otros", el nombre
//     de config/categorias-reclamos.json (el tema es una categoría del mapa
//     de reclamos, ver src/classifier.js): no hay mapa de nombres aparte.
//   - El alcance es la regla de siempre (accountStats.classifyPostAgainstBenchmark,
//     src/reachRule.js), calculada al armar la respuesta, como en el
//     listado; no se guarda. "Se despegó" = top.level === 'alto'.
//   - Los días anteriores al primer posteo de la base no son días sin
//     publicaciones: no hay datos. El período efectivo arranca en el primer
//     día con datos y termina hoy (un día futuro tampoco tiene datos).
//   - Se compara con el período anterior solo si empieza en o después del
//     primer día con datos (y termina antes de hoy): un día sin
//     publicaciones vale cero, es un dato. Si empieza antes, sus campos
//     *Anterior y temas[].anterior van en null (decisión del dueño,
//     23/10/2026). `anterior.diasConCorridas` dice en cuántos de sus días
//     hubo corridas: con menos de la mitad, la pantalla avisa sin dejar de
//     comparar.
//   - Menciones, por término de búsqueda (el de "Búsqueda: <término>" del
//     motivo): `detectadas` cuenta también lo que no quedó (los ignorados y
//     los resultados descartados por el clasificador, de search_seen, por el
//     día en que se vieron), `relevantes` lo guardado y visible, `positivas`
//     las positivas de esas. Los posteos que no llegaron por una búsqueda
//     (cuentas y hashtags, antes de septiembre de 2026) no entran. El share
//     of voice de la pantalla sale de acá: las relevantes de cada término
//     sobre la suma de todas.
//
// Las razones de alcance (mejorRazon, razon del ranking) van sin redondear:
// la pantalla las corta a dos decimales (formatBenchmarkRatio), y redondear
// acá podría dejar un 1,4996 como "1,50" al lado de "medio". La razón de un
// pico es otra cosa: publicaciones del día / lo habitual, sin colchón, y sí
// se puede decir "2,5× lo habitual".
// ==========================================================================

const db = require('./db');
const accountStats = require('./accountStats');
const { CATEGORIA_FALLBACK } = require('./categoriasConfig');
const { STOPWORDS } = require('./stopwords');

const TZ = 'America/Argentina/Buenos_Aires';
const DIA_MS = 24 * 60 * 60 * 1000;
const DIAS_POR_DEFECTO = 30;
const MAX_DIAS = 366;
const CUBETAS = 12; // tendencias de los indicadores
const PICO_FACTOR = 2; // un pico es un día con al menos el doble de lo habitual
const PICOS_MAX = 3;
const PALABRAS_MAX = 60;
const RANKING_MAX = 10;
const DIAS_TEMAS_POR_DIA = 14; // hasta 14 días, la evolución de los temas va por día; más, por semana
// Frases de la nube que cuentan como una aunque no estén en las listas del
// monitoreo (sin esto, "Buenos Aires" salía partida en "Buenos" y "Aires").
const FRASES_FIJAS = ['Buenos Aires'];

// --------------------------------------------------------------------------
// Fechas en hora de Argentina
// --------------------------------------------------------------------------

const formatoArgentina = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});
// Lunes primero, como el mapa de horas de la pantalla.
const DIA_SEMANA = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Fecha ('AAAA-MM-DD'), hora (0-23), minuto y día de la semana (lunes = 0) de un instante, en hora de Argentina. */
function partesArgentina(ms) {
  const p = {};
  for (const { type, value } of formatoArgentina.formatToParts(new Date(ms))) p[type] = value;
  return {
    fecha: `${p.year}-${p.month}-${p.day}`,
    hora: Number(p.hour),
    minuto: Number(p.minute),
    dow: DIA_SEMANA[p.weekday],
  };
}

function fechaArgentina(ms) {
  return partesArgentina(ms).fecha;
}

/** Instante (ms UTC) de las 00:00 de una fecha en hora de Argentina. Dos pasadas, como scripts/gastos.js. */
function inicioDelDia(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  const objetivo = Date.UTC(y, m - 1, d);
  let ms = objetivo;
  for (let i = 0; i < 2; i++) {
    const p = partesArgentina(ms);
    const [py, pm, pd] = p.fecha.split('-').map(Number);
    ms += objetivo - Date.UTC(py, pm - 1, pd, p.hora, p.minuto);
  }
  return ms;
}

function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Días entre dos fechas, contando las dos. */
function diasEntre(desde, hasta) {
  const [y1, m1, d1] = desde.split('-').map(Number);
  const [y2, m2, d2] = hasta.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DIA_MS) + 1;
}

function listarDias(desde, hasta) {
  const dias = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) dias.push(f);
  return dias;
}

// --------------------------------------------------------------------------
// Período
// --------------------------------------------------------------------------

function errorDePedido(mensaje) {
  const err = new Error(mensaje);
  err.userMessage = mensaje;
  err.status = 400;
  return err;
}

function fechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const [y, m, d] = texto.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === texto; // descarta 2026-02-30
}

/**
 * El período pedido y el anterior, de igual largo y pegado antes. Sin
 * fechas: los últimos 30 días hasta hoy (hora de Argentina). Van las dos
 * fechas o ninguna; una fecha mal escrita, desde posterior a hasta o más de
 * 366 días tiran con `status` 400 y `userMessage`.
 * @returns {{ periodo: {desde: string, hasta: string, dias: number}, anterior: {desde: string, hasta: string} }}
 */
function resolverPeriodo({ desde, hasta, ahora = Date.now() } = {}) {
  const tieneDesde = desde != null && String(desde).trim() !== '';
  const tieneHasta = hasta != null && String(hasta).trim() !== '';
  if (tieneDesde !== tieneHasta) {
    throw errorDePedido('Mandá "desde" y "hasta" juntas, o ninguna (últimos 30 días).');
  }
  let d;
  let h;
  if (tieneDesde) {
    d = String(desde).trim();
    h = String(hasta).trim();
    if (!fechaValida(d) || !fechaValida(h)) throw errorDePedido('Las fechas van como AAAA-MM-DD.');
    if (d > h) throw errorDePedido('"desde" no puede ser posterior a "hasta".');
    if (diasEntre(d, h) > MAX_DIAS) throw errorDePedido(`El período puede tener hasta ${MAX_DIAS} días.`);
  } else {
    h = fechaArgentina(ahora);
    d = sumarDias(h, -(DIAS_POR_DEFECTO - 1));
  }
  const dias = diasEntre(d, h);
  const anteriorHasta = sumarDias(d, -1);
  return {
    periodo: { desde: d, hasta: h, dias },
    anterior: { desde: sumarDias(anteriorHasta, -(dias - 1)), hasta: anteriorHasta },
  };
}

/**
 * La parte de un rango que tiene datos: desde el primer día con posteos
 * hasta hoy. null si el rango queda entero fuera (no hay datos).
 * @returns {{desde: string, hasta: string, dias: number}|null}
 */
function rangoEfectivo(rango, primerDia, hoy) {
  if (!primerDia) return null;
  const desde = rango.desde > primerDia ? rango.desde : primerDia;
  const hasta = rango.hasta < hoy ? rango.hasta : hoy;
  if (desde > hasta) return null;
  return { desde, hasta, dias: diasEntre(desde, hasta) };
}

// --------------------------------------------------------------------------
// Cada posteo, listo para contar
// --------------------------------------------------------------------------

function sentimientoDe(post) {
  return post.sentiment === 'positivo' || post.sentiment === 'negativo' ? post.sentiment : 'neutral';
}

function conversacionDe(post) {
  return (Number(post.likes) || 0) + (Number(post.comments) || 0);
}

function seDespego(post) {
  return Boolean(post.top && post.top.level === 'alto');
}

/**
 * Fila de la base + lo que hace falta para contar: fecha, hora y día de la
 * semana en hora de Argentina, sentimiento y tema ya normalizados, y el
 * alcance (`benchmark`, `top`) si se calculó.
 */
function prepararPosteo(row, benchmark = null) {
  const ms = Date.parse(row.posted_at);
  const partes = partesArgentina(ms);
  return {
    ...row,
    ms,
    fecha: partes.fecha,
    hora: partes.hora,
    dow: partes.dow,
    sentimiento: sentimientoDe(row),
    temaNombre: row.tema || CATEGORIA_FALLBACK,
    benchmark,
    top: benchmark ? benchmark.top : null,
  };
}

// --------------------------------------------------------------------------
// Bloques (funciones puras: reciben posteos preparados, devuelven números)
// --------------------------------------------------------------------------

function redondear(valor, decimales = 1) {
  const f = 10 ** decimales;
  return Math.round(valor * f) / f;
}

/** Porcentaje (0 a 100, un decimal) o null si no hay posteos. */
function porcentaje(parte, total) {
  return total > 0 ? redondear((parte / total) * 100) : null;
}

/** Publicaciones por día de la lista de días, con los que no tuvieron ninguna en cero. */
function contarPorDia(posts, dias) {
  const porFecha = new Map(dias.map((fecha) => [fecha, { fecha, total: 0, positivo: 0, neutral: 0, negativo: 0 }]));
  for (const post of posts) {
    const dia = porFecha.get(post.fecha);
    if (!dia) continue;
    dia.total++;
    dia[post.sentimiento]++;
  }
  return [...porFecha.values()];
}

/** Lo habitual: la mediana de publicaciones por día. null sin días. */
function habitualDe(porDia) {
  return accountStats.median(porDia.map((d) => d.total));
}

/** El posteo que explica un día: el de mayor razón de alcance; si ninguno tiene referencia, el de más likes + comentarios. */
function posteoDelDia(postsDelDia) {
  let elegido = null;
  for (const post of postsDelDia) {
    if (!elegido) {
      elegido = post;
      continue;
    }
    const a = post.top ? post.top.ratio : null;
    const b = elegido.top ? elegido.top.ratio : null;
    if (a != null && (b == null || a > b)) elegido = post;
    else if (a == null && b == null && conversacionDe(post) > conversacionDe(elegido)) elegido = post;
  }
  return elegido ? { id: elegido.id, titulo: elegido.title || null, cuenta: elegido.account || null } : null;
}

/**
 * Días con al menos el doble de lo habitual (hasta 3, los de más
 * publicaciones primero). Si lo habitual es 0 no hay picos: cualquier día
 * con un posteo sería "infinitas veces" lo habitual.
 */
function calcularPicos(porDia, habitual, posts) {
  if (!habitual || habitual <= 0) return [];
  return porDia
    .filter((d) => d.total >= PICO_FACTOR * habitual)
    .sort((a, b) => b.total - a.total || (a.fecha < b.fecha ? -1 : 1))
    .slice(0, PICOS_MAX)
    .map((d) => ({
      fecha: d.fecha,
      total: d.total,
      razon: redondear(d.total / habitual, 2),
      posteo: posteoDelDia(posts.filter((p) => p.fecha === d.fecha)),
    }));
}

/** Publicaciones por día de la semana (lunes primero) y hora, en hora de Argentina: 7 filas de 24. */
function mapaPorHora(posts) {
  const mapa = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const post of posts) mapa[post.dow][post.hora]++;
  return mapa;
}

/**
 * Las tendencias de los indicadores: el período efectivo partido en 12
 * cubetas iguales de tiempo (hasta ahora si el período termina hoy). Los
 * porcentajes de una cubeta sin posteos van en null, no en 0.
 */
function calcularTendencias(posts, inicioMs, finMs) {
  const vacias = () => Array.from({ length: CUBETAS }, () => ({ n: 0, alto: 0, neg: 0, pos: 0, conv: 0 }));
  const cubetas = vacias();
  const largo = finMs - inicioMs;
  if (largo > 0) {
    for (const post of posts) {
      const i = Math.min(CUBETAS - 1, Math.max(0, Math.floor(((post.ms - inicioMs) / largo) * CUBETAS)));
      const c = cubetas[i];
      c.n++;
      if (seDespego(post)) c.alto++;
      if (post.sentimiento === 'negativo') c.neg++;
      if (post.sentimiento === 'positivo') c.pos++;
      c.conv += conversacionDe(post);
    }
  }
  return {
    relevantes: cubetas.map((c) => c.n),
    seDespegaron: cubetas.map((c) => c.alto),
    negativo: cubetas.map((c) => porcentaje(c.neg, c.n)),
    positivo: cubetas.map((c) => porcentaje(c.pos, c.n)),
    conversacion: cubetas.map((c) => c.conv),
  };
}

/** Los números de un período para el resumen. */
function totalesDe(posts) {
  const n = posts.length;
  return {
    relevantes: n,
    seDespegaron: posts.filter(seDespego).length,
    negativoPct: porcentaje(posts.filter((p) => p.sentimiento === 'negativo').length, n),
    positivoPct: porcentaje(posts.filter((p) => p.sentimiento === 'positivo').length, n),
    conversacion: posts.reduce((suma, p) => suma + conversacionDe(p), 0),
  };
}

/** Resumen con la comparación: sin datos en el período anterior, cada *Anterior va en null. */
function calcularResumen(actuales, anteriores, tendencias) {
  const a = totalesDe(actuales);
  const b = anteriores ? totalesDe(anteriores) : null;
  return {
    relevantes: a.relevantes,
    relevantesAnterior: b ? b.relevantes : null,
    seDespegaron: a.seDespegaron,
    seDespegaronAnterior: b ? b.seDespegaron : null,
    negativoPct: a.negativoPct,
    negativoPctAnterior: b ? b.negativoPct : null,
    positivoPct: a.positivoPct,
    positivoPctAnterior: b ? b.positivoPct : null,
    conversacion: a.conversacion,
    conversacionAnterior: b ? b.conversacion : null,
    tendencias,
  };
}

// ---- Texto: palabras y menciones ----

function sinTildes(texto) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Una palabra: letras y números, con un # o @ adelante si los tiene, y
// puntos, apóstrofes o guiones solo entre letras ("j.macri", "co-working").
const PALABRA = /[#@]?[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/giu;

/** Las palabras de un texto, cada una con su forma original y la de comparar (sin tildes ni mayúsculas). */
function tokenizar(texto) {
  const limpio = String(texto || '').replace(LINK, ' ');
  return [...limpio.matchAll(PALABRA)].map((m) => ({ original: m[0], clave: sinTildes(m[0]) }));
}

/**
 * Frases para buscar, indexadas por su primera palabra: cada una como lista
 * de claves, sin repetidas y, para una misma primera palabra, las más
 * largas primero ("jefe de gobierno porteño" antes que "jefe de gobierno").
 * @returns {Map<string, string[][]>}
 */
function prepararFrases(frases) {
  const vistas = new Map();
  for (const frase of frases || []) {
    const claves = tokenizar(frase).map((t) => t.clave);
    if (claves.length) vistas.set(claves.join(' '), claves);
  }
  const indice = new Map();
  for (const claves of [...vistas.values()].sort((a, b) => b.length - a.length)) {
    if (!indice.has(claves[0])) indice.set(claves[0], []);
    indice.get(claves[0]).push(claves);
  }
  return indice;
}

/** La frase de la lista que empieza en la palabra i, o null. */
function fraseEn(tokens, i, indice) {
  const candidatas = indice.get(tokens[i].clave);
  if (!candidatas) return null;
  return (
    candidatas.find(
      (claves) => i + claves.length <= tokens.length && claves.every((clave, k) => tokens[i + k].clave === clave)
    ) || null
  );
}

function textoDe(post) {
  return `${post.title || ''}\n${post.caption || ''}`;
}

function cantidadDeLetras(texto) {
  return (texto.match(/\p{L}/gu) || []).length;
}

/**
 * Las 60 palabras más usadas: `n` es la cantidad de posteos que la usan
 * (título y texto). Primero se buscan las frases de las listas del monitoreo
 * y las fijas (FRASES_FIJAS: así "Jorge Macri" y "Buenos Aires" cuentan como
 * una); después, palabras sueltas de 3 letras
 * o más que no sean palabras vacías (src/stopwords.js). Hashtags,
 * menciones (@usuario), links y números no cuentan, salvo que estén en la
 * lista. Se compara sin tildes ni mayúsculas y se muestra la forma más usada.
 * `positivas` y `negativas`: cuántos de esos posteos son de cada tono (el
 * modo "Positivos reales" de la nube y su color, el tono que predomina).
 * `ids`: esos posteos, para que un clic en la palabra muestre en el
 * Monitoreo exactamente los que se contaron (buscar el texto traería más:
 * "Macri" está también dentro de "Jorge Macri" y "Ciudad" en "ciudadanos").
 */
function contarPalabras(posts, frases = []) {
  const indiceFrases = prepararFrases([...FRASES_FIJAS, ...frases]);
  const posteosPorClave = new Map();
  const idsPorClave = new Map();
  const tonoPorClave = new Map();
  const formasPorClave = new Map();

  const anotarForma = (clave, forma) => {
    if (!formasPorClave.has(clave)) formasPorClave.set(clave, new Map());
    const formas = formasPorClave.get(clave);
    formas.set(forma, (formas.get(forma) || 0) + 1);
  };

  for (const post of posts) {
    const tokens = tokenizar(textoDe(post));
    const enEstePosteo = new Set();
    for (let i = 0; i < tokens.length; ) {
      const frase = fraseEn(tokens, i, indiceFrases);
      if (frase) {
        const clave = frase.join(' ');
        enEstePosteo.add(clave);
        anotarForma(clave, tokens.slice(i, i + frase.length).map((t) => t.original).join(' '));
        i += frase.length;
        continue;
      }
      const { original, clave } = tokens[i];
      i++;
      if (/^[#@]/.test(clave) || clave.includes('.')) continue;
      if (cantidadDeLetras(clave) < 3 || STOPWORDS.has(clave)) continue;
      enEstePosteo.add(clave);
      anotarForma(clave, original);
    }
    for (const clave of enEstePosteo) {
      posteosPorClave.set(clave, (posteosPorClave.get(clave) || 0) + 1);
      if (!idsPorClave.has(clave)) idsPorClave.set(clave, []);
      idsPorClave.get(clave).push(post.id);
      if (!tonoPorClave.has(clave)) tonoPorClave.set(clave, { positivas: 0, negativas: 0 });
      const tono = tonoPorClave.get(clave);
      if (post.sentimiento === 'positivo') tono.positivas++;
      if (post.sentimiento === 'negativo') tono.negativas++;
    }
  }

  const formaMasUsada = (clave) => {
    let mejor = null;
    let veces = -1;
    for (const [forma, n] of formasPorClave.get(clave)) {
      if (n > veces) {
        mejor = forma;
        veces = n;
      }
    }
    return mejor;
  };

  return [...posteosPorClave]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))
    .slice(0, PALABRAS_MAX)
    .map(([clave, n]) => ({ palabra: formaMasUsada(clave), n, ...tonoPorClave.get(clave), ids: idsPorClave.get(clave) }));
}

/**
 * El término de búsqueda de un motivo ("Búsqueda: macri · <motivo del
 * modelo>" → "macri"), o null si el posteo no llegó por una búsqueda. Lee
 * el motivo base igual que la pantalla (postReasonParts en
 * public/js/monitoring.js): corta en " · ", " (" o " — ".
 */
function terminoDeBusqueda(motivo) {
  const base = String(motivo || '').split(' · ')[0].trim();
  const m = base.match(/^Búsqueda:\s*(.+?)(?:\s+\(|\s+—\s|$)/);
  return m ? m[1].trim() : null;
}

/**
 * Menciones por término de búsqueda, de más detectadas a menos: una fila por
 * término con algo en el período (esté o no en la config hoy). Los términos
 * se juntan sin tildes ni mayúsculas y se muestran como llegaron primero.
 * @param {object[]} posts los del período, preparados (visibles)
 * @param {{ ignorados?: (string|null)[], descartados?: {term: string, n: number}[] }} [otros]
 *   el motivo de los ignorados del período y los descartados por término
 * @returns {{termino: string, detectadas: number, relevantes: number, positivas: number}[]}
 */
function contarMenciones(posts, { ignorados = [], descartados = [] } = {}) {
  const porTermino = new Map();
  const fila = (termino) => {
    const clave = sinTildes(termino);
    if (!porTermino.has(clave)) porTermino.set(clave, { termino, detectadas: 0, relevantes: 0, positivas: 0 });
    return porTermino.get(clave);
  };
  for (const post of posts) {
    const termino = terminoDeBusqueda(post.matched_reason);
    if (!termino) continue;
    const f = fila(termino);
    f.detectadas++;
    f.relevantes++;
    if (post.sentimiento === 'positivo') f.positivas++;
  }
  for (const motivo of ignorados) {
    const termino = terminoDeBusqueda(motivo);
    if (termino) fila(termino).detectadas++;
  }
  for (const { term, n } of descartados) {
    const termino = String(term || '').trim();
    if (termino && n > 0) fila(termino).detectadas += n;
  }
  return [...porTermino.values()].sort(
    (a, b) => b.detectadas - a.detectadas || b.relevantes - a.relevantes || a.termino.localeCompare(b.termino, 'es')
  );
}

// ---- Temas, cuentas y ranking ----

/**
 * Los tramos de la evolución de los temas y del tono neto por semana: por
 * día hasta 14 días; más largo, de a 7 días contados hacia atrás desde el
 * último, así el último tramo son los últimos 7 días ("esta semana") y el
 * que puede quedar más corto es el primero. En orden, del más viejo al más
 * nuevo.
 * @returns {{desde: string, hasta: string}[]}
 */
function tramosDeTemas(rango) {
  if (!rango) return [];
  const paso = rango.dias <= DIAS_TEMAS_POR_DIA ? 1 : 7;
  const tramos = [];
  for (let hasta = rango.hasta; hasta >= rango.desde; hasta = sumarDias(hasta, -paso)) {
    const inicio = sumarDias(hasta, -(paso - 1));
    tramos.unshift({ desde: inicio > rango.desde ? inicio : rango.desde, hasta });
  }
  return tramos;
}

/**
 * Temas del período con su tono y su evolución por tramo, los más frecuentes
 * primero. `anterior`: cuántos tuvo en el período anterior (null si ese
 * período no tiene datos: la pantalla no pone badge). `destacada`: la
 * publicación del tema con mayor razón de alcance, para la cita de la
 * tarjeta (a igual razón, la más nueva), con su `nivel` (puede no haberse
 * despegado: la de mayor razón de un tema chico puede ser "bajo"); null si
 * ninguna tiene referencia.
 * @param {object[]} posts los del período, preparados
 * @param {{desde: string, hasta: string}[]} tramos
 * @param {object[]|null} [anteriores] los del período anterior (null sin datos)
 */
function contarTemas(posts, tramos, anteriores = null) {
  const porTema = new Map();
  const mejor = new Map();
  for (const post of posts) {
    if (!porTema.has(post.temaNombre)) {
      porTema.set(post.temaNombre, { tema: post.temaNombre, n: 0, negativo: 0, neutral: 0, positivo: 0, porSemana: tramos.map(() => 0) });
    }
    const t = porTema.get(post.temaNombre);
    t.n++;
    t[post.sentimiento]++;
    const i = tramos.findIndex((tr) => post.fecha >= tr.desde && post.fecha <= tr.hasta);
    if (i >= 0) t.porSemana[i]++;
    const actual = mejor.get(post.temaNombre);
    if (post.top && (!actual || post.top.ratio > actual.top.ratio || (post.top.ratio === actual.top.ratio && post.ms > actual.ms))) {
      mejor.set(post.temaNombre, post);
    }
  }
  const antes = new Map();
  for (const post of anteriores || []) antes.set(post.temaNombre, (antes.get(post.temaNombre) || 0) + 1);
  for (const t of porTema.values()) {
    t.anterior = anteriores ? antes.get(t.tema) || 0 : null;
    const p = mejor.get(t.tema);
    t.destacada = p
      ? { id: p.id, titulo: p.title || null, cuenta: p.account || null, razon: p.top.ratio, metrica: p.top.label, nivel: p.top.level }
      : null;
  }
  return [...porTema.values()].sort((a, b) => b.n - a.n || a.tema.localeCompare(b.tema, 'es'));
}

/**
 * Cada cuenta con al menos un posteo en el período. `impacto` = likes +
 * comentarios de sus posteos (lo que generaron hablando de nosotros);
 * `seguidores`, el último conocido (null si no hay); `seDespego`, sus
 * posteos con alcance alto; `mejorRazon`, su mayor razón (null sin
 * referencia). El orden lo elige la pantalla; acá van por publicaciones.
 */
function contarCuentas(posts, seguidores = new Map()) {
  const porCuenta = new Map();
  for (const post of posts) {
    const cuenta = post.account;
    if (!cuenta || cuenta === 'N/D') continue;
    if (!porCuenta.has(cuenta)) {
      porCuenta.set(cuenta, {
        cuenta,
        publicaciones: 0,
        impacto: 0,
        seguidores: seguidores.has(cuenta) ? seguidores.get(cuenta) : null,
        seDespego: 0,
        mejorRazon: null,
        negativo: 0,
        neutral: 0,
        positivo: 0,
      });
    }
    const c = porCuenta.get(cuenta);
    c.publicaciones++;
    c.impacto += conversacionDe(post);
    if (seDespego(post)) c.seDespego++;
    if (post.top && (c.mejorRazon == null || post.top.ratio > c.mejorRazon)) c.mejorRazon = post.top.ratio;
    c[post.sentimiento]++;
  }
  return [...porCuenta.values()].sort((a, b) => b.publicaciones - a.publicaciones || a.cuenta.localeCompare(b.cuenta, 'es'));
}

/**
 * Los 10 posteos con mayor razón de alcance, con la métrica que decidió, su
 * valor, la mediana usada y su `nivel` (con pocas publicaciones altas, la
 * lista sigue con las de nivel medio o bajo).
 */
function calcularRanking(posts) {
  return posts
    .filter((p) => p.top)
    .sort((a, b) => b.top.ratio - a.top.ratio || b.ms - a.ms)
    .slice(0, RANKING_MAX)
    .map((p) => {
      const metrica = p.benchmark[p.top.metric];
      return {
        id: p.id,
        titulo: p.title || null,
        cuenta: p.account || null,
        fecha: p.posted_at,
        metrica: p.top.label,
        valor: metrica.value,
        mediana: metrica.median,
        razon: p.top.ratio,
        nivel: p.top.level,
        sentimiento: p.sentimiento,
      };
    });
}

// --------------------------------------------------------------------------
// La respuesta
// --------------------------------------------------------------------------

/**
 * Todos los bloques de Estadísticas para un período, desde la base.
 * @param {object} opts
 * @param {string} opts.plataforma obligatoria
 * @param {string} [opts.desde] 'AAAA-MM-DD' (con hasta) o nada: últimos 30 días
 * @param {string} [opts.hasta]
 * @param {string[]} [opts.frases] palabras clave y búsquedas del monitoreo (frases para la nube)
 * @param {boolean} [opts.conAlcance] si la plataforma tiene benchmark (Instagram sí, X no)
 * @param {number} [opts.ahora] para los tests
 */
function armarEstadisticas({ plataforma, desde, hasta, frases = [], conAlcance = false, ahora = Date.now() } = {}) {
  if (typeof plataforma !== 'string' || !plataforma.trim()) {
    throw errorDePedido('Falta el parámetro plataforma (instagram | x).');
  }
  const { periodo, anterior } = resolverPeriodo({ desde, hasta, ahora });
  const hoy = fechaArgentina(ahora);
  const primero = db.getFirstPostedAt(plataforma);
  const primerDia = primero ? fechaArgentina(Date.parse(primero)) : null;
  const efectivo = rangoEfectivo(periodo, primerDia, hoy);
  const efectivoAnterior = rangoEfectivo(anterior, primerDia, hoy);
  // Comparable: el anterior entero tiene datos (empieza en o después del
  // primer día con posteos y no llega a hoy).
  const comparable = Boolean(primerDia) && anterior.desde >= primerDia && anterior.hasta < hoy;

  const filas = db.listPostsForStats({
    plataforma,
    desdeIso: new Date(inicioDelDia(anterior.desde)).toISOString(),
    hastaIso: new Date(inicioDelDia(sumarDias(periodo.hasta, 1))).toISOString(),
  });
  const statsMap = conAlcance ? accountStats.buildAccountStatsMap() : null;
  const posts = filas.map((row) =>
    prepararPosteo(
      row,
      conAlcance
        ? accountStats.classifyPostAgainstBenchmark({
            account: row.account,
            plataforma,
            postType: row.post_type,
            likes: row.likes,
            comments: row.comments,
            statsMap,
          })
        : null
    )
  );
  const inicioPeriodo = inicioDelDia(periodo.desde);
  const actuales = posts.filter((p) => p.ms >= inicioPeriodo);
  const anteriores = comparable ? posts.filter((p) => p.ms < inicioPeriodo) : null;
  // En cuántos días del anterior hubo corridas (ver db.listRunTracesForStats).
  const diasConCorridas = new Set(
    db
      .listRunTracesForStats({
        plataforma,
        desdeIso: new Date(inicioDelDia(anterior.desde)).toISOString(),
        hastaIso: new Date(inicioPeriodo).toISOString(),
      })
      .map((t) => fechaArgentina(Date.parse(t)))
  ).size;

  const porDia = efectivo ? contarPorDia(actuales, listarDias(efectivo.desde, efectivo.hasta)) : [];
  const habitual = habitualDe(porDia);
  const tendencias = efectivo
    ? calcularTendencias(actuales, inicioDelDia(efectivo.desde), Math.min(inicioDelDia(sumarDias(efectivo.hasta, 1)), ahora))
    : calcularTendencias([], 0, 0);
  const tramos = tramosDeTemas(efectivo);
  const rangoDelPeriodo = {
    plataforma,
    desdeIso: new Date(inicioPeriodo).toISOString(),
    hastaIso: new Date(inicioDelDia(sumarDias(periodo.hasta, 1))).toISOString(),
  };

  return {
    periodo: {
      ...periodo,
      desdeEfectivo: efectivo ? efectivo.desde : null,
      hastaEfectivo: efectivo ? efectivo.hasta : null,
      diasEfectivos: efectivo ? efectivo.dias : 0,
      // El primer día con datos de la plataforma (null sin ningún posteo):
      // con un período entero antes, la pantalla dice desde cuándo hay.
      primerDia,
    },
    anterior: {
      ...anterior,
      desdeEfectivo: efectivoAnterior ? efectivoAnterior.desde : null,
      hastaEfectivo: efectivoAnterior ? efectivoAnterior.hasta : null,
      diasEfectivos: efectivoAnterior ? efectivoAnterior.dias : 0,
      comparable,
      diasConCorridas,
    },
    resumen: calcularResumen(actuales, anteriores, tendencias),
    porDia,
    habitual,
    picos: calcularPicos(porDia, habitual, actuales),
    porHora: mapaPorHora(actuales),
    palabras: contarPalabras(actuales, frases),
    menciones: contarMenciones(actuales, {
      ignorados: db.listIgnoredPostsForStats(rangoDelPeriodo),
      descartados: db.countDiscardedSearchesForStats(rangoDelPeriodo),
    }),
    semanas: tramos,
    temas: contarTemas(actuales, tramos, anteriores),
    cuentas: contarCuentas(actuales, db.listFollowersForStats(plataforma)),
    ranking: calcularRanking(actuales),
  };
}

module.exports = {
  armarEstadisticas,
  resolverPeriodo,
  rangoEfectivo,
  prepararPosteo,
  contarPorDia,
  habitualDe,
  calcularPicos,
  mapaPorHora,
  calcularTendencias,
  calcularResumen,
  contarPalabras,
  contarMenciones,
  terminoDeBusqueda,
  tramosDeTemas,
  contarTemas,
  contarCuentas,
  calcularRanking,
  partesArgentina,
  inicioDelDia,
};
