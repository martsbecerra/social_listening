// ==========================================================================
// analysisMetrics.js — Todo lo numérico del análisis de publicación.
// --------------------------------------------------------------------------
// El modelo clasifica cada comentario y escribe la lectura; ningún número de
// la pantalla sale de él. Acá se cuenta todo, AL LEER (GET /api/analisis/:id,
// src/analysisRoutes.js), desde la fila guardada: los comentarios con sus
// campos, lo que dijo el modelo (`resultado`), los temas con sus renombres,
// y lo que se lee al día (figuras públicas, reclamos del posteo, análisis
// anteriores de la cuenta). Así un análisis viejo (v1, fase E) muestra todo
// lo que se puede contar con sus comentarios, y los bloques que necesitan
// los campos nuevos (postura, tema por comentario, sobre el posteo, pedido)
// vienen como no disponibles.
//
// Bases (decisiones del dueño, 24/10/2026):
//   - las proporciones de tono, postura y "hablan del posteo" son sobre los
//     clasificados sin el ruido (bots, spam, repetidos), que va aparte; lo
//     sin clasificar (una tanda caída) tampoco entra;
//   - el ponderado por likes pesa cada comentario likes + 1;
//   - el hecho dominante vale solo si el modelo lo marcó sobre el tema
//     principal de los que no hablan del posteo Y ese tema junta al menos
//     el 20 % de los analizados.
// Desde la fase G (resultado.respuestas) llegan también las respuestas:
// cuentan como cualquier comentario, salvo las de la propia cuenta
// (deLaCuenta), que quedan fuera de todo lo que se cuenta y van solo a
// "¿La cuenta respondió?". Los debates son los comentarios con más
// respuestas traídas. Un análisis anterior los trae como no disponibles.
//
// Sin dependencias (no carga la base): la usan las rutas, el trabajo (las
// columnas de la galería al terminar) y reportBuilder (el informe).
// ==========================================================================

const UMBRAL_HECHO = 0.2;
const TOP_LIKES = 6;
const MAX_ETIQUETAS = 8;
const MAX_EMOJIS = 8;
const MAX_DESVIOS = 4;
const HORA = 3600 * 1000;

// Las listas fijas de apoyo y bronca (sin el selector de variante U+FE0F:
// "❤️" y "❤" son el mismo).
const APOYO = new Set(['👏', '❤', '🙌', '😍', '🌳', '🙏', '💪', '👍', '✨', '🥰']);
const BRONCA = new Set(['😡', '🤬', '🤦', '👎', '😤', '🙄', '💩', '🤡', '😠']);

const TONOS = ['positivo', 'neutral', 'negativo'];
const POSTURAS = ['favor', 'neutra', 'critica'];
const TIPO_TEXTO = { reel: 'Reel', imagen: 'Foto', carrusel: 'Carrusel' };

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const likesDe = (c) => (Number.isFinite(c.likes) && c.likes > 0 ? c.likes : 0);
const usuarioClave = (u) => String(u || '').trim().replace(/^@+/, '').toLowerCase();

// Sin acentos ni mayúsculas ni espacios de más: "Seguridad en el parque" y
// "seguridad en el Parque" son el mismo tema (analyzeComments, analysisTemas).
function claveTema(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function proporciones(cuentas, claves) {
  const base = claves.reduce((n, k) => n + (cuentas[k] || 0), 0);
  const out = {};
  for (const k of claves) out[k] = base > 0 ? (cuentas[k] || 0) / base : 0;
  return { base, proporcion: out };
}

function horasDesde(fecha, desde) {
  const t = fecha ? Date.parse(fecha) : NaN;
  const d = desde ? Date.parse(desde) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
  return Math.max(0, (t - d) / HORA);
}

// ---------------------------------------------------------------- temas

/**
 * Los temas de la fila, con su id canónico: v2 ({ version: 2, lista }) con
 * los renombres y uniones (unidoA), o v1 (la lista de la síntesis de la
 * fase E, cada uno con los números de sus comentarios).
 * @returns {{ lista: Array<{ id: number, nombre: string, manual: boolean, texto: string|null, comentariosV1: number[]|null }>, canonico: (id: any) => number|null }}
 */
function temasDeFila(temas) {
  if (temas && typeof temas === 'object' && !Array.isArray(temas) && Array.isArray(temas.lista)) {
    const porId = new Map(temas.lista.filter((t) => t && Number.isInteger(t.id)).map((t) => [t.id, t]));
    const canonico = (id) => {
      let t = porId.get(Number(id));
      const vistos = new Set();
      while (t && Number.isInteger(t.unidoA) && porId.has(t.unidoA) && !vistos.has(t.id)) {
        vistos.add(t.id);
        t = porId.get(t.unidoA);
      }
      return t ? t.id : null;
    };
    const lista = [...porId.values()]
      .filter((t) => !Number.isInteger(t.unidoA) || !porId.has(t.unidoA))
      .map((t) => ({ id: t.id, nombre: String(t.nombre || '').trim() || `Tema ${t.id}`, manual: Boolean(t.manual), texto: t.texto || null, comentariosV1: null }));
    return { lista, canonico, version: 2 };
  }
  const v1 = Array.isArray(temas) ? temas : [];
  const lista = v1
    .filter((t) => t && typeof t.titulo === 'string' && t.titulo.trim())
    .map((t, i) => {
      const comentariosV1 = [...new Set((Array.isArray(t.comentarios) ? t.comentarios : []).filter(Number.isInteger))];
      const texto = typeof t.texto === 'string' && t.texto.trim() ? t.texto.trim() : null;
      // Sin comentarios: uno que agregó el equipo en la E (la E descartaba
      // los del modelo sin texto; sale con su texto si tiene, sin conteo).
      return { id: i + 1, nombre: t.titulo.trim(), manual: comentariosV1.length === 0, texto, comentariosV1 };
    });
  return { lista, canonico: (id) => (lista.some((t) => t.id === Number(id)) ? Number(id) : null), version: 1 };
}

// ---------------------------------------------------------------- etiquetas y emojis

// La @mención con la que Instagram abre una respuesta (a quien se le
// responde) no es una etiqueta.
const MENCION_DE_RESPUESTA = /^\s*@[A-Za-z0-9._]{1,30}\s*/;

function etiquetasDe(comentarios, verificados) {
  const cuentas = new Map();
  const hashtags = new Map();
  let conEtiqueta = 0;
  for (const c of comentarios) {
    const texto = c.esRespuesta ? String(c.texto || '').replace(MENCION_DE_RESPUESTA, '') : String(c.texto || '');
    const menciones = new Set([...texto.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => m[1].replace(/\.+$/, '').toLowerCase()).filter(Boolean));
    if (menciones.size) conEtiqueta += 1;
    for (const m of menciones) cuentas.set(m, (cuentas.get(m) || 0) + 1);
    const tags = new Map();
    for (const m of texto.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
      const k = m[1].toLowerCase();
      if (!tags.has(k)) tags.set(k, m[1]);
    }
    for (const [k, original] of tags) {
      const h = hashtags.get(k) || { tag: `#${original}`, n: 0 };
      h.n += 1;
      hashtags.set(k, h);
    }
  }
  const orden = (a, b) => b.n - a.n || a.k.localeCompare(b.k);
  return {
    cuentas: [...cuentas.entries()]
      .map(([k, n]) => ({ k, cuenta: `@${k}`, n, verificadaQueComento: verificados.has(k) }))
      .sort(orden)
      .slice(0, MAX_ETIQUETAS)
      .map(({ k, ...r }) => r),
    hashtags: [...hashtags.entries()]
      .map(([k, h]) => ({ k, ...h }))
      .sort(orden)
      .slice(0, MAX_ETIQUETAS)
      .map(({ k, ...r }) => r),
    comentarios: conEtiqueta,
  };
}

/** Los emojis de un texto: sin tonos de piel ni selector de variante; una secuencia con ZWJ cuenta por su primer emoji. */
function emojisDe(texto) {
  const limpio = String(texto || '')
    .replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '')
    .replace(/‍\p{Extended_Pictographic}/gu, '');
  return limpio.match(/\p{Extended_Pictographic}/gu) || [];
}

function emojisResumen(comentarios) {
  const cuenta = new Map();
  for (const c of comentarios) for (const e of emojisDe(c.texto)) cuenta.set(e, (cuenta.get(e) || 0) + 1);
  let apoyo = 0;
  let bronca = 0;
  for (const [e, n] of cuenta) {
    if (APOYO.has(e)) apoyo += n;
    else if (BRONCA.has(e)) bronca += n;
  }
  const lista = [...cuenta.entries()]
    .map(([emoji, n]) => ({ emoji, n }))
    .sort((a, b) => b.n - a.n || a.emoji.localeCompare(b.emoji))
    .slice(0, MAX_EMOJIS);
  return { lista, apoyo, bronca, proporcionApoyo: apoyo + bronca > 0 ? apoyo / (apoyo + bronca) : null };
}

// ---------------------------------------------------------------- tiempo

function tiempoDe(row, comentarios) {
  const fechas = comentarios
    .map((c) => (c.fecha ? Date.parse(c.fecha) : NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const desde = row.postedAt ? Date.parse(row.postedAt) : NaN;
  const ref = row.finishedAt ? Date.parse(row.finishedAt) : NaN;
  const cuando = row.cuando && Array.isArray(row.cuando.tramos) ? row.cuando : null;
  if (!cuando && !fechas.length) return null;
  const primeroMin = Number.isFinite(desde) && fechas.length ? Math.max(0, Math.round((fechas[0] - desde) / 60000)) : null;
  const mitadHoras = Number.isFinite(desde) && fechas.length ? Math.max(0, (fechas[Math.ceil(fechas.length / 2) - 1] - desde) / HORA) : null;
  const ultimas24 = Number.isFinite(ref) ? fechas.filter((t) => t >= ref - 24 * HORA && t <= ref).length : null;
  return {
    cuando,
    primeroMin,
    mitadHoras,
    picoHoras: cuando && cuando.pico ? cuando.pico.h : null,
    ultimas24,
    sigueVivo: ultimas24 !== null ? ultimas24 > 0 : null,
  };
}

// ---------------------------------------------------------------- la vista

/**
 * La forma completa de un análisis terminado.
 * @param {object} row db.getAnalisis(...)
 * @param {{ figuras?: Map<string, object>, reclamos?: object[], anteriores?: object[] }} [ctx]
 *   figuras: usuario → figura (db.getFigurasPorUsernames); reclamos: los del
 *   posteo (db.listReclamosDePost); anteriores: db.listAnterioresDeCuenta.
 */
function buildAnalysisView(row, { figuras = new Map(), reclamos = [], anteriores = [] } = {}) {
  const resultado = row.resultado && typeof row.resultado === 'object' ? row.resultado : {};
  const v2 = resultado.version === 2;
  const temas = temasDeFila(row.temas);
  const postedAt = row.postedAt || null;

  // Los comentarios, con su tema canónico y las horas desde la publicación.
  const nombreTema = new Map(temas.lista.map((t) => [t.id, t.nombre]));
  // v1: un comentario podía estar en varios temas; temaId es el primero
  // (para filtrar) y temasV1 todos (el CSV los nombra, como los cuenta la vista).
  const temaV1 = new Map();
  const todosV1 = new Map();
  if (temas.version === 1) {
    for (const t of temas.lista) {
      for (const n of t.comentariosV1) {
        if (!temaV1.has(n)) temaV1.set(n, t.id);
        todosV1.set(n, [...(todosV1.get(n) || []), t.nombre]);
      }
    }
  }
  const comentarios = (Array.isArray(row.comentarios) ? row.comentarios : []).filter((c) => c && typeof c === 'object').map((c) => {
    const temaId = v2 ? temas.canonico(c.tema) : temaV1.get(c.n) ?? null;
    return {
      n: c.n,
      usuario: c.usuario ? String(c.usuario) : 'desconocido',
      verificada: Boolean(c.verificada),
      likes: num(c.likes),
      fecha: c.fecha || null,
      horas: horasDesde(c.fecha, postedAt),
      texto: c.texto || '',
      tono: TONOS.includes(c.tono) || c.tono === 'ruido' ? c.tono : null,
      postura: v2 && POSTURAS.includes(c.postura) ? c.postura : null,
      temaId,
      tema: temaId !== null ? nombreTema.get(temaId) || null : null,
      temasV1: v2 ? null : todosV1.get(c.n) || [],
      sobrePosteo: v2 && typeof c.sobrePosteo === 'boolean' ? c.sobrePosteo : null,
      pedido: v2 && typeof c.pedido === 'boolean' ? c.pedido : null,
      esRespuesta: Boolean(c.esRespuesta),
      respondeA: Number.isInteger(c.respondeA) ? c.respondeA : null,
      respondeAUsuario: c.respondeAUsuario ? String(c.respondeAUsuario) : null,
      deLaCuenta: Boolean(c.deLaCuenta),
      respuestasDeclaradas: num(c.respuestasDeclaradas),
    };
  });
  // Fase G: las respuestas de cada comentario (por su número) y, en cada
  // uno de primer nivel, cuántas llegaron; null en un análisis anterior.
  const conRespuestas = Boolean(resultado.respuestas);
  const respuestasDe = new Map();
  if (conRespuestas) {
    for (const c of comentarios) if (c.esRespuesta && c.respondeA !== null) respuestasDe.set(c.respondeA, [...(respuestasDe.get(c.respondeA) || []), c]);
  }
  for (const c of comentarios) c.respuestas = conRespuestas && !c.esRespuesta ? (respuestasDe.get(c.n) || []).length : null;
  // Lo que se cuenta es del público: los de la propia cuenta no van al
  // modelo (sin tono) y quedan fuera de todo, salvo "¿La cuenta respondió?".
  const publico = comentarios.filter((c) => !c.deLaCuenta);
  const clasificados = publico.filter((c) => c.tono !== null);
  const base = clasificados.filter((c) => c.tono !== 'ruido');
  const analizados = num(row.analizados) ?? clasificados.length;

  // ---- tono
  const cuentaTono = { positivo: 0, neutral: 0, negativo: 0 };
  const pesoTono = { positivo: 0, neutral: 0, negativo: 0 };
  for (const c of base) {
    cuentaTono[c.tono] += 1;
    pesoTono[c.tono] += likesDe(c) + 1;
  }
  const tonoP = proporciones(cuentaTono, TONOS);
  const tono = {
    positivos: cuentaTono.positivo,
    neutrales: cuentaTono.neutral,
    negativos: cuentaTono.negativo,
    ruido: clasificados.length - base.length,
    sinClasificar: publico.length - clasificados.length,
    base: tonoP.base,
    proporcion: tonoP.proporcion,
    ponderado: proporciones(pesoTono, TONOS).proporcion,
    neto: tonoP.base > 0 ? Math.round((tonoP.proporcion.positivo - tonoP.proporcion.negativo) * 100) : 0,
  };

  // ---- postura
  let postura = null;
  if (v2) {
    const cuenta = { favor: 0, neutra: 0, critica: 0 };
    for (const c of base) if (c.postura) cuenta[c.postura] += 1;
    const p = proporciones(cuenta, POSTURAS);
    postura = { ...cuenta, base: p.base, proporcion: p.proporcion };
  }

  // ---- ¿hablan del posteo? y a qué se desvían
  let sobrePosteo = null;
  if (v2) {
    const conDato = base.filter((c) => c.sobrePosteo !== null);
    const si = conDato.filter((c) => c.sobrePosteo).length;
    const desvio = new Map();
    for (const c of conDato) if (!c.sobrePosteo && c.temaId !== null) desvio.set(c.temaId, (desvio.get(c.temaId) || 0) + 1);
    sobrePosteo = {
      si,
      no: conDato.length - si,
      base: conDato.length,
      proporcion: conDato.length ? si / conDato.length : 0,
      desvios: [...desvio.entries()]
        .map(([id, n]) => ({ temaId: id, tema: nombreTema.get(id), n, proporcion: conDato.length ? n / conDato.length : 0 }))
        .sort((a, b) => b.n - a.n || a.temaId - b.temaId)
        .slice(0, MAX_DESVIOS),
    };
  }

  // ---- temas con su tono (y, en un v2, cuántos no hablan del posteo)
  // conOpinion: los que no son ruido (en un v1 la estrella tiene que tener
  // alguno: un tema de puro spam no es el de la publicación).
  const porTema = new Map(temas.lista.map((t) => [t.id, { positivo: 0, neutral: 0, negativo: 0, n: 0, conOpinion: 0, fuera: v2 ? 0 : null }]));
  if (temas.version === 1) {
    // Fase E: un comentario podía estar en varios temas y cada tema se
    // contaba por su lista (también el ruido, que no suma tono). Igual acá.
    const porNumero = new Map(clasificados.map((c) => [c.n, c]));
    for (const t of temas.lista) {
      const x = porTema.get(t.id);
      for (const n of t.comentariosV1) {
        const c = porNumero.get(n);
        if (!c) continue;
        x.n += 1;
        if (TONOS.includes(c.tono)) {
          x[c.tono] += 1;
          x.conOpinion += 1;
        }
      }
    }
  } else {
    for (const c of base) {
      const t = c.temaId !== null ? porTema.get(c.temaId) : null;
      if (!t) continue;
      t.n += 1;
      t.conOpinion += 1;
      t[c.tono] += 1;
      if (t.fuera !== null && c.sobrePosteo === false) t.fuera += 1;
    }
  }
  const temasVista = temas.lista
    .map((t) => {
      const x = porTema.get(t.id);
      return {
        id: t.id,
        nombre: t.nombre,
        manual: t.manual,
        texto: t.texto,
        n: t.manual ? null : x.n,
        fuera: t.manual ? null : x.fuera,
        tonos: { positivo: x.positivo, neutral: x.neutral, negativo: x.negativo },
      };
    })
    // Un tema del modelo sin ningún comentario no se muestra (en la corrida
    // real armó "Comentarios de spam o ruido", y el ruido no lleva tema). Un
    // v1 los conserva: ahí uno sin comentarios es el que agregó el equipo.
    .filter((t) => temas.version !== 2 || t.manual || t.n > 0)
    .sort((a, b) => Number(a.manual) - Number(b.manual) || (b.n ?? 0) - (a.n ?? 0) || a.id - b.id);
  const estrella = temasVista.find((t) => !t.manual && t.n > 0 && porTema.get(t.id).conOpinion > 0) || null;
  for (const t of temasVista) t.estrella = Boolean(estrella && t.id === estrella.id);

  // ---- verificados y figuras públicas (todos los que comentaron se cruzan con la tabla)
  // Una sugerida que el equipo descartó no es figura: sin rol, y si no es
  // verificada no aparece (descartada avisa a la pantalla que ya se vio).
  const verificados = new Set(publico.filter((c) => c.verificada).map((c) => usuarioClave(c.usuario)));
  const vigentes = new Map([...figuras].filter(([, f]) => f && f.origen !== 'descartada'));
  const porUsuario = new Map();
  for (const c of publico) {
    const k = usuarioClave(c.usuario);
    if (!verificados.has(k) && !vigentes.has(k)) continue;
    const actual = porUsuario.get(k);
    if (!actual || likesDe(c) > likesDe(actual)) porUsuario.set(k, c);
  }
  const quienHablo = [...porUsuario.entries()]
    .map(([k, c]) => {
      const f = vigentes.get(k) || null;
      return {
        usuario: c.usuario,
        verificada: verificados.has(k),
        figura: f ? { nombre: f.nombre, rol: f.rol, alineacion: f.alineacion, origen: f.origen } : null,
        descartada: !f && Boolean(figuras.get(k)),
        comentario: { n: c.n, texto: c.texto, likes: c.likes, tono: c.tono, horas: c.horas },
      };
    })
    .sort((a, b) => (b.comentario.likes || 0) - (a.comentario.likes || 0) || String(a.usuario).localeCompare(String(b.usuario)));

  // ---- hecho dominante
  let hecho = null;
  let sinHecho = null;
  const fueraDelPosteo = sobrePosteo && sobrePosteo.desvios.length ? sobrePosteo.desvios[0].temaId : null;
  const propuesto = v2 && resultado.hecho && typeof resultado.hecho === 'object' ? resultado.hecho : null;
  if (propuesto && fueraDelPosteo !== null && temas.canonico(propuesto.temaId) === fueraDelPosteo) {
    // Los del tema que NO hablan del posteo: el informe dice "un hecho ajeno al posteo".
    const delTema = base.filter((c) => c.temaId === fueraDelPosteo && c.sobrePosteo === false);
    const share = analizados > 0 ? delTema.length / analizados : 0;
    if (share >= UMBRAL_HECHO) {
      const likesTotal = publico.reduce((n, c) => n + likesDe(c), 0);
      const likesTema = delTema.reduce((n, c) => n + likesDe(c), 0);
      const horas = delTema.map((c) => c.horas).filter((h) => h !== null);
      hecho = {
        temaId: fueraDelPosteo,
        tema: nombreTema.get(fueraDelPosteo),
        titulo: String(propuesto.titulo || '').trim() || nombreTema.get(fueraDelPosteo),
        descripcion: String(propuesto.descripcion || '').trim(),
        n: delTema.length,
        proporcion: share,
        proporcionLikes: likesTotal > 0 ? likesTema / likesTotal : 0,
        verificados: new Set(delTema.filter((c) => c.verificada).map((c) => usuarioClave(c.usuario))).size,
        ejemplos: [...delTema].sort((a, b) => likesDe(b) - likesDe(a) || a.n - b.n).slice(0, 3),
        desdeHoras: horas.length ? Math.min(...horas) : null,
      };
    }
  }
  // Del hecho: del tema y fuera del posteo (los mismos que cuenta el hecho).
  const esDelHecho = (c) => Boolean(hecho) && c.temaId === hecho.temaId && c.sobrePosteo === false;
  if (!hecho && estrella) {
    sinHecho = {
      tema: estrella.nombre,
      n: estrella.n,
      proporcion: analizados > 0 ? estrella.n / analizados : 0,
      // De los comentarios del tema con opinión, los positivos (la tarjeta tranquila).
      positivo: porTema.get(estrella.id).conOpinion > 0 ? estrella.tonos.positivo / porTema.get(estrella.id).conOpinion : null,
      temas: temasVista.filter((t) => !t.manual).slice(0, 4),
    };
  }

  // ---- pedidos
  let pedidos = null;
  if (v2) {
    const porN = new Map(comentarios.map((c) => [c.n, c]));
    pedidos = (Array.isArray(resultado.pedidos) ? resultado.pedidos : [])
      .map((p) => {
        const ids = [...new Set((Array.isArray(p.ids) ? p.ids : []).filter((n) => porN.has(n)))];
        const lista = ids.map((n) => porN.get(n));
        const ejemplo = [...lista].sort((a, b) => likesDe(b) - likesDe(a) || a.n - b.n)[0] || null;
        const delHecho = Boolean(hecho && lista.filter(esDelHecho).length * 2 > lista.length);
        return { texto: String(p.texto || '').trim(), n: ids.length, proporcion: analizados > 0 ? ids.length / analizados : 0, ejemplo: ejemplo ? ejemplo.texto : null, delHecho, ids };
      })
      .filter((p) => p.texto && p.n > 0)
      .sort((a, b) => b.n - a.n);
  }

  // ---- los que más pegaron: por likes y, con respuestas, los debates (los
  // comentarios del público con más respuestas traídas, con el tono de esas
  // respuestas; las de la cuenta no tienen tono y se marcan aparte)
  const top = [...publico]
    .sort((a, b) => likesDe(b) - likesDe(a) || a.n - b.n)
    .slice(0, TOP_LIKES)
    .map((c) => ({ ...c, delHecho: esDelHecho(c) }));
  let debates = null;
  let respuestas = null;
  let laCuentaRespondio = null;
  if (conRespuestas) {
    // Un debate es del público: uno que solo contestó la cuenta no entra.
    const conDelPublico = publico
      .filter((c) => !c.esRespuesta && c.respuestas > 0)
      .map((c) => {
        const suyas = respuestasDe.get(c.n);
        const delPublico = suyas.filter((r) => !r.deLaCuenta);
        const tonos = { positivo: 0, neutral: 0, negativo: 0 };
        for (const r of delPublico) if (TONOS.includes(r.tono)) tonos[r.tono] += 1;
        return { ...c, respuestasPublico: delPublico.length, tonosRespuestas: tonos, respondioLaCuenta: suyas.length > delPublico.length, delHecho: esDelHecho(c) };
      })
      .filter((c) => c.respuestasPublico > 0);
    debates = [...conDelPublico].sort((a, b) => b.respuestasPublico - a.respuestasPublico || likesDe(b) - likesDe(a) || a.n - b.n).slice(0, TOP_LIKES);
    const declaradas = publico.filter((c) => !c.esRespuesta).map((c) => c.respuestasDeclaradas).filter((v) => v !== null);
    respuestas = {
      // Del público (las de la cuenta, aparte): las que llegaron, que no
      // son todas las que declara Instagram. Una cuyo comentario no entró
      // en la muestra cuenta en traidas pero no en ningún comentario.
      traidas: publico.filter((c) => c.esRespuesta).length,
      deLaCuenta: comentarios.filter((c) => c.deLaCuenta && c.esRespuesta).length,
      comentariosConRespuesta: conDelPublico.length,
      declaradas: declaradas.length ? declaradas.reduce((a, b) => a + b, 0) : null,
    };
    // ¿La cuenta respondió?: a qué comentarios y qué les dijo. Una respuesta
    // cuyo comentario no llegó va sola, con el @usuario si se sabe.
    const porN = new Map(comentarios.map((c) => [c.n, c]));
    const grupos = new Map();
    for (const r of comentarios.filter((c) => c.deLaCuenta && c.esRespuesta)) {
      const padre = r.respondeA !== null ? porN.get(r.respondeA) || null : null;
      if (padre && padre.deLaCuenta) continue; // un hilo de la cuenta consigo misma
      const clave = padre ? `n${padre.n}` : `r${r.n}`;
      if (!grupos.has(clave)) {
        grupos.set(clave, {
          comentario: padre
            ? { n: padre.n, usuario: padre.usuario, texto: padre.texto, likes: padre.likes, tono: padre.tono, verificada: padre.verificada, horas: padre.horas }
            : { n: null, usuario: r.respondeAUsuario, texto: null, likes: null, tono: null, verificada: false, horas: null },
          respuestas: [],
        });
      }
      grupos.get(clave).respuestas.push({ n: r.n, texto: r.texto, likes: r.likes, horas: r.horas });
    }
    const lista = [...grupos.values()].sort((a, b) => likesDe(b.comentario) - likesDe(a.comentario) || a.respuestas[0].n - b.respuestas[0].n);
    laCuentaRespondio = {
      comentarios: lista.length,
      respuestas: lista.reduce((n, g) => n + g.respuestas.length, 0),
      negativos: lista.filter((g) => g.comentario.tono === 'negativo').length,
      // Lo que la cuenta comentó suelto en su publicación (no una respuesta).
      sueltos: comentarios.filter((c) => c.deLaCuenta && !c.esRespuesta).length,
      lista,
    };
  }
  const topResumen = {
    likes: top.reduce((n, c) => n + likesDe(c), 0),
    delHecho: top.filter((c) => c.delHecho).length,
    positivos: top.filter((c) => c.tono === 'positivo').length,
  };
  // Lo que cuenta la tarjeta de verificados y su KPI: con alineación = una
  // figura del equipo con oficialismo u oposición (roles políticos o de prensa).
  const personas = {
    verificados: quienHablo.filter((q) => q.verificada).length,
    conAlineacion: quienHablo.filter((q) => q.verificada && q.figura && q.figura.origen === 'equipo' && q.figura.alineacion).length,
    enLista: quienHablo.filter((q) => q.figura && q.figura.origen === 'equipo').length,
  };

  // ---- comparación con la cuenta
  const actual = {
    neg: tonoP.base > 0 ? tonoP.proporcion.negativo * 100 : null,
    comentarios: num(row.comentariosTotal),
    verificados: verificados.size,
    sobrePosteo: sobrePosteo && sobrePosteo.base ? sobrePosteo.proporcion * 100 : null,
  };
  let comparacion = { primero: true, n: 0, actual };
  if (anteriores.length) {
    const prom = (vals) => {
      const xs = vals.filter((v) => v !== null && Number.isFinite(v));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    const onDe = (a) => {
      const vista = buildAnalysisView({ resultado: { version: 2 }, comentarios: a.comentarios, temas: a.temas, analizados: null }, {});
      return (a.comentarios || []).some((c) => typeof c.sobrePosteo === 'boolean') && vista.sobrePosteo && vista.sobrePosteo.base ? vista.sobrePosteo.proporcion * 100 : null;
    };
    const serie = [...anteriores]
      .reverse()
      .map((a) => ({ id: a.id, neg: a.pctNeg, actual: false }))
      .concat([{ id: row.id, neg: actual.neg !== null ? Math.round(actual.neg * 10) / 10 : null, actual: true }]);
    comparacion = {
      primero: false,
      n: anteriores.length,
      actual,
      promedio: {
        neg: prom(anteriores.map((a) => a.pctNeg)),
        comentarios: prom(anteriores.map((a) => a.comentariosTotal)),
        verificados: prom(anteriores.map((a) => a.nVerificados)),
        sobrePosteo: prom(anteriores.map(onDe)),
      },
      serie,
    };
  }

  return {
    id: row.id,
    version: v2 ? 2 : 1,
    url: row.url,
    cuenta: row.cuenta || null,
    cuentaNombre: row.cuentaNombre || null,
    tipo: TIPO_TEXTO[row.postType] || null,
    caption: row.caption || '',
    postedAt,
    finishedAt: row.finishedAt || null,
    likes: num(row.likes),
    comentariosTotal: num(row.comentariosTotal),
    traidos: num(row.traidos),
    analizados,
    disponible: { postura: v2, sobrePosteo: v2, hecho: v2, pedidos: v2, respuestas: conRespuestas },
    tono,
    postura,
    sobrePosteo,
    temas: temasVista,
    hecho,
    sinHecho,
    lectura: (v2 ? resultado.lectura : resultado.lecturaEstrategica) || null,
    queMirar: v2 ? resultado.queMirar || null : null,
    quienHablo,
    personas,
    pedidos,
    etiquetas: etiquetasDe(publico, verificados),
    emojis: emojisResumen(publico),
    top,
    topResumen,
    debates,
    respuestas,
    laCuentaRespondio,
    tiempo: tiempoDe({ postedAt, finishedAt: row.finishedAt, cuando: row.cuando }, publico),
    comparacion,
    reclamos,
    costo: {
      apify: num(row.usdApify),
      modelo: num(row.usdModelo),
      total: num(row.usdApify) !== null || num(row.usdModelo) !== null ? (num(row.usdApify) || 0) + (num(row.usdModelo) || 0) : null,
    },
    comentarios,
  };
}

/** Las columnas de la galería, de la misma cuenta que la pantalla (las escribe el trabajo al terminar). */
function columnasDeVista(vista) {
  return {
    pctNeg: vista.tono.base > 0 ? Math.round(vista.tono.proporcion.negativo * 1000) / 10 : null,
    tieneHecho: Boolean(vista.hecho),
    nVerificados: vista.quienHablo.filter((q) => q.verificada).length,
    temaEstrella: (vista.temas.find((t) => t.estrella) || {}).nombre || null,
  };
}

module.exports = {
  buildAnalysisView,
  columnasDeVista,
  temasDeFila,
  claveTema,
  emojisDe,
  UMBRAL_HECHO,
  APOYO,
  BRONCA,
};
