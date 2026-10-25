// --------------------------------------------------------------------
// Análisis de publicación (fase F2): los bloques del resultado. Prefijo
// ana / ANA_ (comparte el ámbito con analysis.js, que va antes, y
// analysisFiguras.js, que va después). anaRender(a) dibuja todo desde
// a.vista (src/analysisMetrics.js): acá no se cuenta nada, solo se
// muestra. En un análisis anterior a la fase F (vista.version 1) los
// bloques que necesitan los campos nuevos dicen "No disponible en
// análisis anteriores" (decisión del dueño), sin ocultarse.
//
// Bloques: la publicación con sus cuatro KPI y la lectura; el hecho
// dominante o la tarjeta tranquila; tono, postura y "¿hablan del posteo?";
// los temas (un clic filtra los comentarios, ✎ los edita, "+ tema");
// la comparación con la cuenta; "Cuándo comentaron"; los pedidos; los que
// más pegaron; los reclamos en el mapita; etiquetas y emojis; los
// comentarios con búsqueda y filtros; compartir.
//
// Todo dato entra por textContent o atributos; el SVG, con createElementNS.
// --------------------------------------------------------------------

const ANA_WA_CAP = 4000;
const ANA_CMTS_PAGE = 50;
const ANA_TOP = 6;
const ANA_RECL_LISTA = 9;
const ANA_NA = 'No disponible en análisis anteriores';

const ANA_TONO = {
  positivo: { bar: 'bg-pos', text: 'sent-pos', label: 'Positivo' },
  neutral: { bar: 'bg-neu', text: 'sent-neu', label: 'Neutro' },
  negativo: { bar: 'bg-neg', text: 'sent-neg', label: 'Negativo' },
  ruido: { bar: 'bg-none', text: '', label: 'Ruido' },
};
const ANA_SIN_CLASIFICAR = { bar: 'bg-none', text: '', label: 'Sin clasificar' };
const ANA_POSTURA = {
  favor: { label: 'a favor', bar: 'bg-favor' },
  neutra: { label: 'neutra', bar: 'bg-neutra' },
  critica: { label: 'crítica', bar: 'bg-critica' },
};

// El contorno de la Ciudad y los centros de las comunas (los de la
// maqueta), en longitud y latitud: el mapita no es el Mapa, es para ubicar.
const ANA_CABA = [
  [-58.467, -34.527], [-58.44, -34.549], [-58.41, -34.561], [-58.36, -34.572], [-58.335, -34.59], [-58.345, -34.62],
  [-58.355, -34.64], [-58.37, -34.655], [-58.4, -34.661], [-58.42, -34.671], [-58.44, -34.69], [-58.47, -34.701],
  [-58.5, -34.705], [-58.53, -34.69], [-58.531, -34.66], [-58.525, -34.63], [-58.52, -34.6], [-58.51, -34.57], [-58.49, -34.55],
];
const ANA_COMUNAS = [
  [-58.38, -34.603], [-58.395, -34.585], [-58.405, -34.612], [-58.375, -34.64], [-58.42, -34.615], [-58.44, -34.617],
  [-58.46, -34.637], [-58.47, -34.68], [-58.51, -34.655], [-58.49, -34.625], [-58.5, -34.6], [-58.48, -34.56],
  [-58.455, -34.555], [-58.42, -34.58], [-58.455, -34.59],
];

const anaB = {
  post: document.getElementById('anaPost'),
  img: document.getElementById('anaImg'),
  av: document.getElementById('anaAv'),
  acc: document.getElementById('anaAcc'),
  date: document.getElementById('anaDate'),
  caption: document.getElementById('anaCaption'),
  likes: document.getElementById('anaLikes'),
  coms: document.getElementById('anaComs'),
  analizados: document.getElementById('anaAnalizados'),
  link: document.getElementById('anaLink'),
  kpis: document.getElementById('anaKpis'),
  ai: document.getElementById('aiText'),
  event: document.getElementById('anaEvent'),
  n: document.getElementById('anaN'),
  donut: document.getElementById('anaDonut'),
  donutMid: document.getElementById('anaDonutMid'),
  tono: document.getElementById('anaTono'),
  tonoNote: document.getElementById('anaTonoNote'),
  postura: document.getElementById('anaPostura'),
  splitBox: document.getElementById('anaSplitBox'),
  split: document.getElementById('anaSplit'),
  splitLbl: document.getElementById('anaSplitLbl'),
  desv: document.getElementById('anaDesv'),
  themes: document.getElementById('anaThemes'),
  themesLegend: document.getElementById('anaThemesLegend'),
  temaForm: document.getElementById('anaTemaForm'),
  temaTituloL: document.getElementById('anaTemaTituloL'),
  temaTitulo: document.getElementById('anaTemaTitulo'),
  temaTextoBox: document.getElementById('anaTemaTextoBox'),
  temaTexto: document.getElementById('anaTemaTexto'),
  temaMsg: document.getElementById('anaTemaMsg'),
  temaSave: document.getElementById('anaTemaSave'),
  temaDel: document.getElementById('anaTemaDel'),
  temaCancel: document.getElementById('anaTemaCancel'),
  cmpAcc: document.getElementById('anaCmpAcc'),
  cmpHint: document.getElementById('anaCmpHint'),
  cmp: document.getElementById('anaCmp'),
  hist: document.getElementById('anaHist'),
  histLbl: document.getElementById('anaHistLbl'),
  whenHint: document.getElementById('anaWhenHint'),
  when: document.getElementById('anaWhen'),
  tlk: document.getElementById('anaTlk'),
  whenNote: document.getElementById('anaWhenNote'),
  asks: document.getElementById('anaAsks'),
  top: document.getElementById('anaTop'),
  topNote: document.getElementById('anaTopNote'),
  reclHint: document.getElementById('anaReclHint'),
  map: document.getElementById('anaMap'),
  recl: document.getElementById('anaRecl'),
  tagRows: document.getElementById('anaTagRows'),
  tagsTitle: document.getElementById('anaTagsTitle'),
  tags: document.getElementById('anaTags'),
  tagsNote: document.getElementById('anaTagsNote'),
  emo: document.getElementById('anaEmo'),
  emoSplit: document.getElementById('anaEmoSplit'),
  emoNote: document.getElementById('anaEmoNote'),
  cmtsTitle: document.getElementById('anaCmtsTitle'),
  cmtQ: document.getElementById('cmtQ'),
  cmtSeg: document.getElementById('cmtSeg'),
  cmtN: document.getElementById('anaCmtN'),
  cmts: document.getElementById('anaCmts'),
  cmtsMore: document.getElementById('anaCmtsMore'),
  copyBtn: document.getElementById('copyBtn'),
  waBtn: document.getElementById('waBtn'),
  waShareBtn: document.getElementById('waShareBtn'),
  csvBtn: document.getElementById('csvBtn'),
  reclCsvBtn: document.getElementById('reclCsvBtn'),
  cost: document.getElementById('anaCost'),
  waLen: document.getElementById('waLen'),
  waWarn: document.getElementById('waWarn'),
  waText: document.getElementById('waText'),
};

let anaTypeTimer = null;
let anaCmtFilter = 'top';
let anaCmtSel = null; // { tipo: 'tema' | 'pedido' | 'persona', … }: lo que filtra los comentarios
let anaCmtQ = '';
let anaCmtLimit = ANA_CMTS_PAGE;
let anaTemaEditing = null; // id del tema en edición, o 'nuevo'
let anaWhenDrawnW = 0;
let anaHistDrawnW = 0;
let anaCmtQTimer = null;

const ANA_DEC = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

/** "57 %" de una proporción 0..1. */
function anaPct(p) {
  return `${Math.round((Number(p) || 0) * 100)} %`;
}

/** "+5 min", "+3 h", "+4 d" desde la publicación. */
function anaHh(h) {
  if (h === null || h === undefined || !Number.isFinite(h)) return '';
  if (h < 1) return `+${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `+${Math.round(h)} h`;
  return `+${Math.round(h / 24)} d`;
}

function anaVista() {
  return anaShown ? anaShown.vista : null;
}

function anaEsV2() {
  const v = anaVista();
  return Boolean(v && v.version === 2);
}

/** La placa de lo que un análisis anterior no tiene. */
function anaNa(detalle) {
  const box = anaEl('div', 'an-na', `${ANA_NA}${detalle ? `: ${detalle}` : '.'}`);
  return box;
}

// Las barras crecen desde 0 (data-w) en el cuadro siguiente.
function anaGrow(container) {
  requestAnimationFrame(() => container.querySelectorAll('[data-w]').forEach((i) => (i.style.width = i.dataset.w)));
}

function anaStopTyping() {
  clearInterval(anaTypeTimer);
}

function anaCount(el, target, format) {
  if (typeof kpiCountUp === 'function') kpiCountUp(el, target, format);
  else el.textContent = format(target);
}

// ---------------------------------------------------------------- todo

function anaRender(a) {
  const v = a.vista;
  anaShow(anaEls.result, true);
  anaShow(anaEls.empty, false);
  anaCloseTemaForm({ restoreFocus: false });
  anaCmtFilter = 'top';
  anaCmtSel = null;
  anaCmtQ = '';
  anaB.cmtQ.value = '';
  anaCmtLimit = ANA_CMTS_PAGE;
  anaShow(anaB.waText, false);
  anaB.waBtn.setAttribute('aria-expanded', 'false');
  anaB.waBtn.textContent = 'Ver texto para WhatsApp';
  if (typeof anaFigReset === 'function') anaFigReset();
  anaRenderPost(a, v);
  anaRenderKpis(v);
  anaRenderAi(v);
  anaRenderEvent(v);
  anaRenderTono(v);
  anaRenderPostura(v);
  anaRenderSplit(v);
  anaRenderThemes();
  anaRenderCmp(v);
  anaRenderWhen();
  anaRenderAsks(v);
  anaRenderPeople(v);
  anaRenderTop(v);
  anaRenderRecl(v);
  anaRenderTags(v);
  anaRenderEmo(v);
  anaRenderSeg();
  anaRenderCmts();
  anaRenderShare();
}

/** Después de editar temas o figuras: lo que depende de ellos, sin tocar los filtros ni la lectura. */
function anaRefresh() {
  const v = anaVista();
  if (!v) return;
  // El tema elegido: si se unió a otro o se quitó, se suelta; si cambió de
  // nombre, la pastilla (y el filtro de un v1, que va por nombre) lo siguen.
  if (anaCmtSel && anaCmtSel.tipo === 'tema') {
    const t = v.temas.find((x) => x.id === anaCmtSel.id);
    if (!t || t.manual) anaCmtSel = null;
    else anaCmtSel.nombre = t.nombre;
  }
  anaRenderKpis(v, { animar: false });
  anaRenderEvent(v, { animar: false });
  anaRenderSplit(v);
  anaRenderThemes();
  anaRenderAsks(v);
  anaRenderPeople(v);
  anaRenderTop(v);
  anaRenderCmts();
  anaRenderShare();
}

// ---------------------------------------------------------------- la publicación

function anaRenderPost(a, v) {
  // La foto (la del Monitoreo o la copia del análisis), entera sobre negro.
  anaB.img.style.setProperty('--a', accountColor(v.cuenta));
  anaB.img.classList.remove('none');
  anaB.img.replaceChildren();
  const placa = (texto) => {
    anaB.img.classList.add('none');
    anaB.img.replaceChildren(anaEl('span', '', texto));
  };
  if (v.imagen && v.imagen.fullUrl) {
    const img = document.createElement('img');
    img.alt = v.cuenta ? `Foto de la publicación de @${v.cuenta}` : 'Foto de la publicación';
    img.src = v.imagen.fullUrl;
    img.addEventListener('error', () => placa('Imagen no disponible'));
    anaB.img.append(img);
  } else {
    placa(a.imagenEstado === 'vencido' || a.imagenEstado === 'error' ? 'Imagen no disponible' : 'Sin foto');
  }
  if (v.tipo) anaB.img.append(anaEl('span', 'ty', v.tipo));

  anaB.av.style.background = accountColor(v.cuenta);
  anaB.av.textContent = anaInitials(v.cuentaNombre || v.cuenta);
  anaB.acc.textContent = v.cuenta ? `@${v.cuenta}` : 'Cuenta sin dato';
  const fecha = anaDateParts(v.postedAt);
  anaB.date.textContent = fecha ? `${fecha.fecha} · ${fecha.hora}` : 'fecha sin dato';
  anaB.caption.textContent = v.caption || 'Sin texto.';
  const met = (el, pre, valor, post) => {
    el.replaceChildren(pre, anaEl('b', '', valor));
    if (post) el.append(post);
  };
  if (v.likes === null) {
    anaB.likes.textContent = '♥ ocultos';
    anaB.likes.title = 'La cuenta ocultó los me gusta';
  } else {
    met(anaB.likes, '♥ ', formatCount(v.likes));
    anaB.likes.title = 'Me gusta';
  }
  // El ancla del análisis a la vista (al abrirlo desde la galería, el foco va acá).
  anaB.post.setAttribute('aria-label', `Publicación de ${v.cuenta ? `@${v.cuenta}` : 'cuenta sin dato'}${fecha ? ` del ${fecha.fecha}` : ''}`);
  met(anaB.coms, '💬 ', formatCount(v.comentariosTotal));
  anaB.coms.title = 'Comentarios que informa Instagram (con las respuestas)';
  const de = anaDeTotal(v);
  met(anaB.analizados, 'analizados ', formatCount(v.analizados), de);
  anaB.link.href = v.url;
}

// " de M": M, el total que informa Instagram; si no lo informó, " de M
// traídos" (lo que trajo Apify, que no es el total de la publicación).
function anaDeTotal(v) {
  if (Number.isFinite(v.comentariosTotal) && v.analizados < v.comentariosTotal) return ` de ${formatCount(v.comentariosTotal)}`;
  if (!Number.isFinite(v.comentariosTotal) && Number.isFinite(v.traidos) && v.analizados < v.traidos) return ` de ${formatCount(v.traidos)} traídos`;
  return '';
}

function anaKpi(titulo, { valor, clase = '', desc, mini = null, contar = null }) {
  const box = anaEl('div');
  box.append(anaEl('div', 'eyebrow', titulo));
  const v = anaEl('div', `v num ${clase}`.trim(), valor);
  box.append(v);
  if (mini) {
    const barra = anaEl('div', 'mini');
    barra.setAttribute('aria-hidden', 'true');
    for (const [cls, p] of mini) {
      const i = anaEl('i', cls);
      i.dataset.w = `${p * 100}%`;
      barra.append(i);
    }
    box.append(barra);
  }
  box.append(anaEl('div', 'd', desc));
  return { box, v, contar };
}

function anaRenderKpis(v, { animar = true } = {}) {
  const kpis = [];
  const t = v.tono;
  const signo = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))}`;
  kpis.push(
    t.base > 0
      ? anaKpi('Tono neto', {
          valor: signo(t.neto),
          clase: t.neto > 5 ? 'pos' : t.neto < -5 ? 'neg' : '',
          desc: 'positivo menos negativo, en puntos',
          mini: [['bg-pos', t.proporcion.positivo], ['bg-neu', t.proporcion.neutral], ['bg-neg', t.proporcion.negativo]],
          contar: [t.neto, signo],
        })
      : anaKpi('Tono neto', { valor: '—', clase: 'na', desc: 'sin comentarios con opinión' })
  );
  if (v.postura && v.postura.base > 0) {
    const p = v.postura.proporcion.critica * 100;
    kpis.push(anaKpi('Postura crítica', { valor: `${Math.round(p)} %`, clase: p > 45 ? 'neg' : '', desc: 'de los comentarios cuestiona la gestión', contar: [p, (x) => `${Math.round(x)} %`] }));
  } else {
    kpis.push(anaKpi('Postura crítica', { valor: '—', clase: 'na', desc: v.postura ? 'sin comentarios con opinión' : ANA_NA }));
  }
  const { verificados, conAlineacion } = v.personas;
  kpis.push(
    anaKpi('Verificados', {
      valor: formatCount(verificados),
      clase: verificados >= 3 ? 'warn' : '',
      desc: verificados ? `comentaron${conAlineacion ? ` · ${formatCount(conAlineacion)} con alineación` : ''}` : 'ningún verificado comentó',
      contar: [verificados, (x) => formatCount(Math.round(x))],
    })
  );
  if (v.sobrePosteo && v.sobrePosteo.base > 0) {
    const p = v.sobrePosteo.proporcion * 100;
    kpis.push(
      anaKpi('Hablan del posteo', {
        valor: `${Math.round(p)} %`,
        clase: p < 50 ? 'warn' : 'pos',
        desc: p < 50 ? 'la mayoría lo usa para otra cosa' : 'el resto lo usa para otra cosa',
        contar: [p, (x) => `${Math.round(x)} %`],
      })
    );
  } else {
    kpis.push(anaKpi('Hablan del posteo', { valor: '—', clase: 'na', desc: v.sobrePosteo ? 'sin comentarios con opinión' : ANA_NA }));
  }
  anaB.kpis.replaceChildren(...kpis.map((k) => k.box));
  if (animar) kpis.forEach((k) => k.contar && anaCount(k.v, k.contar[0], k.contar[1]));
  anaGrow(anaB.kpis);
}

function anaRenderAi(v) {
  clearInterval(anaTypeTimer);
  const texto = v.lectura || 'Sin lectura.';
  const p = anaB.ai;
  // El texto entero para un lector de pantalla; el que se escribe, oculto.
  const completo = anaEl('span', 'sr', texto);
  const escrito = document.createElement('span');
  escrito.setAttribute('aria-hidden', 'true');
  p.replaceChildren(completo, escrito);
  if (anaReducedMotion()) {
    escrito.textContent = texto;
    p.classList.remove('typing');
    return;
  }
  p.classList.add('typing');
  // Como la maqueta, pero en no más de ~1,5 s aunque el texto sea largo.
  const porTick = Math.max(1, Math.ceil(texto.length / 110));
  let i = 0;
  anaTypeTimer = setInterval(() => {
    i = Math.min(texto.length, i + porTick);
    escrito.textContent = texto.slice(0, i);
    if (i >= texto.length) {
      clearInterval(anaTypeTimer);
      p.classList.remove('typing');
    }
  }, 14);
}

// ---------------------------------------------------------------- el hecho dominante

function anaEvFoot(v) {
  if (!v.queMirar) return null;
  const foot = anaEl('div', 'an-evfoot');
  foot.append(anaEl('span', 'eyebrow', 'Qué conviene mirar'), anaEl('p', '', v.queMirar));
  return foot;
}

function anaBigPct(p, texto, animar) {
  const big = anaEl('div', 'big');
  const b = anaEl('b', 'num', `${Math.round(p * 100)} %`);
  big.append(b, anaEl('span', '', texto));
  if (animar) anaCount(b, p * 100, (x) => `${Math.round(x)} %`);
  return big;
}

function anaRenderEvent(v, { animar = true } = {}) {
  const el = anaB.event;
  const h = v.hecho;
  el.classList.toggle('calm', !h);
  const ey = (texto) => {
    const e = anaEl('div', 'ey');
    const punto = document.createElement('i');
    punto.setAttribute('aria-hidden', 'true');
    e.append(punto, texto);
    return e;
  };
  if (h) {
    const partes = [ey('Lo que pasó · hecho dominante'), anaBigPct(h.proporcion, 'de los comentarios analizados habla de un mismo hecho, ajeno al posteo', animar), anaEl('h3', '', h.titulo)];
    if (h.descripcion) partes.push(anaEl('p', 'desc', h.descripcion));
    const quotes = anaEl('div', 'an-quotes');
    h.ejemplos.forEach((c, i) => {
      const q = anaEl('div');
      q.style.animationDelay = `${0.3 + i * 0.15}s`;
      const txt = anaEl('span');
      txt.append(anaEl('b', '', `@${c.usuario}`));
      if (c.verificada) txt.append(' ', anaVerificada());
      txt.append(` ${c.texto}`);
      const l = anaEl('span', 'l', c.likes === null ? '♥ —' : `♥ ${formatCount(c.likes)}`);
      if (i === 0 && c.likes) l.append(anaEl('em', '', 'más likes'));
      q.append(txt, l);
      quotes.append(q);
    });
    if (h.ejemplos.length) partes.push(quotes);
    const foot = anaEl('div', 'foot');
    const dato = (pre, b, post = '') => {
      const s = anaEl('span', '', pre);
      s.append(anaEl('b', '', b), post);
      return s;
    };
    foot.append(dato('concentra ', anaPct(h.proporcionLikes), ' de los likes'));
    if (h.desdeHoras !== null) foot.append(h.desdeHoras < 1 ? dato('empezó ', 'en la primera hora') : dato('empezó ', anaHh(h.desdeHoras), ' después de publicado'));
    if (h.verificados > 0) foot.append(dato('lo amplificaron ', anaPlural(h.verificados, 'verificado', 'verificados')));
    partes.push(foot);
    const ef = anaEvFoot(v);
    if (ef) partes.push(ef);
    el.replaceChildren(...partes);
    return;
  }
  // Sin hecho dominante: la tarjeta tranquila, con el tema que más junta.
  const s = v.sinHecho;
  const partes = [ey(v.disponible.hecho ? 'Sin un hecho dominante' : 'Tema principal')];
  if (s) {
    let explica = 'es lo máximo que junta un solo tema';
    if (v.sobrePosteo && v.sobrePosteo.base > 0) {
      const si = v.sobrePosteo.proporcion;
      explica += si >= 0.5 ? ': la conversación está repartida y responde al posteo' : `: la conversación está repartida y el ${Math.round((1 - si) * 100)} % no habla del posteo`;
    } else {
      explica += ': la conversación está repartida';
    }
    partes.push(anaBigPct(s.proporcion, explica, animar), anaEl('h3', '', `Tema principal: ${s.tema}`));
    let desc = `${anaPlural(s.n, 'comentario lo toca', 'comentarios lo tocan')}${s.positivo !== null && s.positivo !== undefined ? `; ${anaPct(s.positivo)} en tono positivo` : ''}.`;
    if (v.disponible.hecho) desc += ' Ningún hecho externo se adueñó de la conversación.';
    partes.push(anaEl('p', 'desc', desc));
    const max = Math.max(1, ...s.temas.map((t) => t.n || 0));
    const filas = anaEl('div', 'an-calm');
    s.temas.forEach((t, i) => {
      const fila = anaEl('div');
      fila.style.animationDelay = `${0.3 + i * 0.1}s`;
      fila.dataset.tipTitle = t.nombre;
      fila.dataset.tip = `${anaPlural(t.n, 'comentario', 'comentarios')} · ${t.tonos.positivo} positivos · ${t.tonos.neutral} neutros · ${t.tonos.negativo} negativos`;
      const tr = anaEl('span', 'tr');
      tr.setAttribute('aria-hidden', 'true');
      for (const k of ['positivo', 'neutral', 'negativo']) {
        const i2 = anaEl('i', ANA_TONO[k].bar);
        i2.style.setProperty('--w', `${(t.tonos[k] / max) * 100}%`);
        tr.append(i2);
      }
      fila.append(anaEl('span', '', t.nombre), tr, anaEl('b', '', formatCount(t.n)));
      filas.append(fila);
    });
    if (s.temas.length) partes.push(filas);
  } else {
    partes.push(anaEl('h3', '', 'Sin temas que se repitan'), anaEl('p', 'desc', 'El modelo no encontró temas con comentarios en esta publicación.'));
  }
  if (!v.disponible.hecho) partes.push(anaNa('el hecho dominante se busca en los análisis nuevos'));
  const ef = anaEvFoot(v);
  if (ef) partes.push(ef);
  el.replaceChildren(...partes);
}

function anaVerificada() {
  const s = anaEl('span', 'vf-s', '✓');
  s.title = 'Verificada';
  s.setAttribute('aria-label', 'verificada');
  return s;
}

// ---------------------------------------------------------------- tono, postura, desvío

function anaRow(label, { lbClass = '', barClass, p, n }) {
  const row = anaEl('div', 'an-row');
  const tr = anaEl('span', 'tr');
  tr.setAttribute('aria-hidden', 'true');
  const i = anaEl('i', barClass);
  i.dataset.w = `${p * 100}%`;
  tr.append(i);
  const num = anaEl('span', 'n', anaPct(p));
  num.append(anaEl('small', '', anaPlural(n, 'coment.', 'coment.')));
  row.append(anaEl('span', `lb ${lbClass}`.trim(), label), tr, num);
  return row;
}

function anaRenderTono(v) {
  const t = v.tono;
  anaB.n.textContent = `${formatCount(v.analizados)}${anaDeTotal(v)} comentarios`;
  const C = 2 * Math.PI * 46;
  anaB.donut.replaceChildren(anaSvg('circle', { cx: 59, cy: 59, r: 46, stroke: 'var(--line)' }));
  const segs = [
    ['positivo', 'var(--pos)'],
    ['neutral', 'var(--neu)'],
    ['negativo', 'var(--neg)'],
  ];
  let off = 0;
  const arcos = [];
  for (const [k, color] of segs) {
    const p = t.base > 0 ? t.proporcion[k] : 0;
    const c = anaSvg('circle', { cx: 59, cy: 59, r: 46, stroke: color, 'stroke-dasharray': `0 ${C}`, 'stroke-dashoffset': -off * C });
    arcos.push([c, Math.max(0, p * C - (p > 0 ? 2 : 0))]);
    anaB.donut.append(c);
    off += p;
  }
  requestAnimationFrame(() => arcos.forEach(([c, l]) => c.setAttribute('stroke-dasharray', `${l} ${C}`)));
  const mid = anaEl('div');
  if (t.base > 0) {
    mid.append(anaEl('b', t.neto > 5 ? 'sent-pos' : t.neto < -5 ? 'sent-neg' : '', `${t.neto > 0 ? '+' : t.neto < 0 ? '−' : ''}${Math.abs(t.neto)}`));
  } else {
    mid.append(anaEl('b', '', '—'));
  }
  mid.append(anaEl('small', '', 'TONO NETO'));
  anaB.donutMid.replaceChildren(mid);
  anaB.tono.replaceChildren(
    ...['positivo', 'neutral', 'negativo'].map((k) =>
      anaRow(ANA_TONO[k].label, { lbClass: ANA_TONO[k].text, barClass: ANA_TONO[k].bar, p: t.base > 0 ? t.proporcion[k] : 0, n: t[{ positivo: 'positivos', neutral: 'neutrales', negativo: 'negativos' }[k]] })
    )
  );
  anaGrow(anaB.tono);
  const partes = [];
  if (t.base > 0) {
    const w = t.ponderado;
    const lectura =
      w.negativo > t.proporcion.negativo + 0.05
        ? 'los negativos juntan más likes que los demás.'
        : w.positivo > t.proporcion.positivo + 0.05
          ? 'los positivos son los que más likes juntan.'
          : 'parecido al conteo simple.';
    partes.push(`Ponderado por likes: ${anaPct(w.positivo)} positivo · ${anaPct(w.neutral)} neutro · ${anaPct(w.negativo)} negativo — ${lectura}`);
  } else {
    partes.push('Sin comentarios con opinión para medir el tono.');
  }
  if (t.ruido > 0) partes.push(`${anaPlural(t.ruido, 'comentario', 'comentarios')} de ruido (spam, solo emojis, repetidos), aparte.`);
  if (t.sinClasificar > 0) partes.push(`${anaPlural(t.sinClasificar, 'comentario quedó', 'comentarios quedaron')} sin clasificar.`);
  anaB.tonoNote.textContent = partes.join(' ');
}

function anaRenderPostura(v) {
  const p = v.postura;
  if (!p) {
    anaB.postura.replaceChildren(anaNa('la postura se mide en los análisis nuevos'));
    return;
  }
  if (p.base === 0) {
    anaB.postura.replaceChildren(anaEl('p', 'note', 'Sin comentarios con opinión.'));
    return;
  }
  anaB.postura.replaceChildren(
    ...['favor', 'neutra', 'critica'].map((k) =>
      anaRow(ANA_POSTURA[k].label.replace(/^./, (c) => c.toUpperCase()), { barClass: ANA_POSTURA[k].bar, p: p.proporcion[k], n: p[k] })
    )
  );
  anaGrow(anaB.postura);
}

function anaRenderSplit(v) {
  const s = v.sobrePosteo;
  if (!s) {
    anaB.splitBox.replaceChildren(anaNa('si hablan del posteo se mide en los análisis nuevos'));
    return;
  }
  anaB.splitBox.replaceChildren(anaB.split, anaB.splitLbl, anaB.desv);
  if (s.base === 0) {
    anaB.split.classList.add('hidden');
    anaB.splitLbl.replaceChildren(anaEl('span', '', 'Sin comentarios con opinión.'));
    anaB.desv.replaceChildren();
    return;
  }
  anaB.split.classList.remove('hidden');
  const on = Math.round(s.proporcion * 100);
  const off = 100 - on;
  const [a, b] = anaB.split.children;
  a.style.width = '0';
  b.style.width = '0';
  a.textContent = on >= 12 ? `${on} %` : '';
  b.textContent = off >= 12 ? `${off} %` : '';
  requestAnimationFrame(() => {
    a.style.width = `${on}%`;
    b.style.width = `${off}%`;
  });
  const lbl = (n, texto) => {
    const span = anaEl('span');
    span.append(anaEl('b', '', `${n} %`), ` ${texto}`);
    return span;
  };
  anaB.splitLbl.replaceChildren(lbl(on, 'hablan del posteo'), lbl(off, 'lo usan para otra cosa'));
  const chips = s.desvios.map((d, i) => {
    const c = anaEl('span', 'chip', d.tema || 'Sin tema');
    c.append(anaEl('span', 'n', anaPct(d.proporcion)));
    c.style.animation = `pop 0.4s ${0.2 + i * 0.1}s both`;
    return c;
  });
  anaB.desv.replaceChildren(...(chips.length ? [anaEl('span', 'eyebrow', 'Se desvían a'), ...chips] : []));
}

// ---------------------------------------------------------------- temas

function anaRenderThemes() {
  const v = anaVista();
  const box = anaB.themes;
  const temas = v.temas;
  const v2 = v.version === 2;
  const conFoco = box.contains(document.activeElement) ? document.activeElement : null;
  const focoClave = conFoco ? `${conFoco.closest('[data-id]') ? conFoco.closest('[data-id]').dataset.id : 'add'}:${conFoco.className}` : null;
  box.replaceChildren();
  const max = Math.max(1, ...temas.filter((t) => !t.manual).map((t) => t.n || 0));
  temas.forEach((t, i) => {
    const elegido = Boolean(anaCmtSel && anaCmtSel.tipo === 'tema' && anaCmtSel.id === t.id);
    const row = anaEl('div', `an-theme${t.manual ? ' manual' : ''}${elegido ? ' on' : ''}`);
    row.dataset.id = String(t.id);
    row.style.animationDelay = `${i * 60}ms`;
    let nm;
    if (t.manual) {
      nm = anaEl('span', 'nm');
    } else {
      nm = anaEl('button', 'nm');
      nm.type = 'button';
      nm.setAttribute('aria-pressed', String(elegido));
      nm.dataset.tipTitle = t.nombre;
      const fuera = t.fuera ? ` · ${formatCount(t.fuera)} no hablan del posteo` : '';
      nm.dataset.tip = `${anaPlural(t.n, 'comentario', 'comentarios')} · ${t.tonos.positivo} positivos · ${t.tonos.neutral} neutros · ${t.tonos.negativo} negativos${fuera}\nUn clic: esos comentarios, abajo`;
    }
    if (t.estrella) nm.append(anaEl('span', 'star', 'estrella'));
    nm.append(anaEl('span', '', t.nombre));
    let tr;
    if (t.manual) {
      tr = anaEl('span', 'tr manual', t.texto ? t.texto : 'agregado a mano, sin conteo');
    } else {
      tr = anaEl('span', 'tr');
      tr.setAttribute('aria-hidden', 'true');
      for (const k of ['positivo', 'neutral', 'negativo']) {
        const bar = anaEl('i', ANA_TONO[k].bar);
        bar.dataset.w = `${(t.tonos[k] / max) * 100}%`;
        tr.append(bar);
      }
    }
    const n = anaEl('span', 'n', t.manual ? '—' : formatCount(t.n));
    const ed = anaEl('button', 'ed', '✎');
    ed.type = 'button';
    ed.setAttribute('aria-label', `Editar el tema «${t.nombre}»`);
    ed.dataset.tip = v2 && !t.manual ? 'Cambiar el nombre (si coincide con otro tema, se unen)' : 'Cambiar el nombre o el texto, o quitarlo';
    row.append(nm, tr, n, ed);
    box.append(row);
  });
  if (temas.length === 0) box.append(anaEl('span', 'note', 'El modelo no encontró temas que se repitan.'));
  const add = anaEl('button', 'an-theme add', '+ tema');
  add.type = 'button';
  add.id = 'anaTemaAdd';
  const lleno = !v2 && temas.length >= window.TemasConversacion.MAX;
  // aria-disabled: con el foco, el tooltip dice por qué no se puede.
  add.setAttribute('aria-disabled', String(lleno));
  add.dataset.tipTitle = 'Agregar un tema';
  add.dataset.tip = lleno ? `Ya hay ${window.TemasConversacion.MAX}, el máximo.` : 'Se guarda con el análisis y entra en el informe, sin conteo';
  box.append(add);
  anaB.themesLegend.textContent = v2 ? 'cada comentario cuenta en un tema' : 'un comentario puede tocar más de un tema';
  anaGrow(box);
  if (focoClave) {
    const [id, clase] = focoClave.split(':');
    const target = id === 'add' ? document.getElementById('anaTemaAdd') : box.querySelector(`[data-id="${id}"] .${clase.split(' ')[0]}`);
    if (target) target.focus();
  }
}

function anaTemaPorId(id) {
  return anaVista().temas.find((t) => t.id === id) || null;
}

// Cambió lo que filtra los comentarios (un tema, un pedido o una persona):
// se redibujan los tres lugares que lo marcan, el segmentado y la lista.
function anaSelCambio({ enfocar = true } = {}) {
  const v = anaVista();
  if (anaCmtSel) anaCmtFilter = 'all';
  anaCmtLimit = ANA_CMTS_PAGE;
  anaRenderThemes();
  anaRenderAsks(v);
  anaRenderPeople(v);
  anaRenderSeg();
  anaRenderCmts();
  if (enfocar && anaCmtSel) anaB.cmtsTitle.focus();
}

function anaToggleTema(id) {
  const t = anaTemaPorId(id);
  if (!t || t.manual) return;
  const elegido = anaCmtSel && anaCmtSel.tipo === 'tema' && anaCmtSel.id === id;
  anaCmtSel = elegido ? null : { tipo: 'tema', id, nombre: t.nombre };
  anaSelCambio();
}

function anaOpenTemaForm(id) {
  const v = anaVista();
  const v2 = v.version === 2;
  const t = id === 'nuevo' ? null : anaTemaPorId(id);
  if (id !== 'nuevo' && !t) return;
  anaTemaEditing = id;
  const conTexto = !v2 || id === 'nuevo' || t.manual;
  anaB.temaTituloL.textContent = v2 ? 'Nombre' : 'Título';
  anaB.temaTitulo.value = t ? t.nombre : '';
  anaB.temaTexto.value = t && t.texto ? t.texto : '';
  anaShow(anaB.temaTextoBox, conTexto);
  anaShow(anaB.temaDel, id !== 'nuevo' && (!v2 || t.manual));
  anaB.temaMsg.textContent = !v2
    ? 'Sin texto, el tema no entra en el informe.'
    : id === 'nuevo'
      ? 'Un tema agregado a mano entra en el informe con su texto, sin conteo.'
      : t.manual
        ? 'Agregado a mano: entra en el informe con su texto.'
        : 'Si el nombre coincide con el de otro tema, se unen.';
  anaShow(anaB.temaForm, true);
  anaB.temaTitulo.focus();
}

function anaCloseTemaForm({ restoreFocus = true } = {}) {
  const editing = anaTemaEditing;
  anaTemaEditing = null;
  anaShow(anaB.temaForm, false);
  if (!restoreFocus || editing === null) return;
  const target = (editing !== 'nuevo' && anaB.themes.querySelector(`[data-id="${editing}"] .ed`)) || document.getElementById('anaTemaAdd');
  if (target) target.focus();
}

// v1: los temas viejos (título, texto, números de comentarios), como los
// guarda la fase E; el id de la vista es su lugar en la lista + 1.
function anaTemasViejos() {
  return (Array.isArray(anaShown.temas) ? anaShown.temas : [])
    .filter((t) => t && typeof t.titulo === 'string' && t.titulo.trim())
    .map((t) => ({ titulo: t.titulo, texto: t.texto || '', comentarios: Array.isArray(t.comentarios) ? t.comentarios : [] }));
}

async function anaSaveTema(cambio, { focusAfter } = {}) {
  const a = anaShown;
  const botones = [anaB.temaSave, anaB.temaDel, anaB.temaCancel];
  botones.forEach((b) => (b.disabled = true));
  try {
    const url = `/api/analisis/${a.id}/temas?plataforma=${ANA_PLATAFORMA}`;
    const body = anaEsV2() ? cambio.v2 : { temas: cambio.v1 };
    const data = await anaApi(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (anaShown !== a) return;
    if (data && data.vista) anaShown = data;
    else await anaReloadShown();
    anaTemaEditing = null;
    anaShow(anaB.temaForm, false);
    anaRefresh();
    const target = focusAfter === 'add' ? null : anaB.themes.querySelector(`[data-id="${focusAfter}"] .ed`);
    (target || document.getElementById('anaTemaAdd')).focus();
    anaToast('Temas guardados con el análisis');
  } catch (err) {
    anaB.temaMsg.textContent = err.message;
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

anaB.themes.addEventListener('click', (e) => {
  if (!anaShown) return;
  const ed = e.target.closest('.ed');
  if (ed) {
    anaOpenTemaForm(Number(ed.closest('[data-id]').dataset.id));
    return;
  }
  const add = e.target.closest('#anaTemaAdd');
  if (add) {
    if (add.getAttribute('aria-disabled') !== 'true') anaOpenTemaForm('nuevo');
    return;
  }
  const row = e.target.closest('.an-theme[data-id]');
  if (row && !row.classList.contains('manual')) anaToggleTema(Number(row.dataset.id));
});

anaB.temaForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!anaShown || anaTemaEditing === null) return;
  const nombre = anaB.temaTitulo.value.trim();
  const texto = anaB.temaTexto.value.trim();
  if (!nombre) {
    anaB.temaMsg.textContent = anaEsV2() ? 'Poné un nombre.' : 'Poné un título.';
    anaB.temaTitulo.focus();
    return;
  }
  const id = anaTemaEditing;
  const t = id === 'nuevo' ? null : anaTemaPorId(id);
  const viejos = anaEsV2() ? null : anaTemasViejos();
  if (viejos) {
    if (id === 'nuevo') viejos.push({ titulo: nombre, texto, comentarios: [] });
    else viejos[id - 1] = { ...viejos[id - 1], titulo: nombre, texto };
  }
  const v2 =
    id === 'nuevo' ? { accion: 'agregar', nombre, texto } : { accion: 'renombrar', id, nombre, ...(t && t.manual ? { texto } : {}) };
  anaSaveTema({ v2, v1: viejos }, { focusAfter: id === 'nuevo' ? 'add' : id });
});

anaB.temaDel.addEventListener('click', () => {
  if (!anaShown || typeof anaTemaEditing !== 'number') return;
  const id = anaTemaEditing;
  const viejos = anaEsV2() ? null : anaTemasViejos();
  if (viejos) viejos.splice(id - 1, 1);
  if (anaCmtSel && anaCmtSel.tipo === 'tema' && anaCmtSel.id === id) anaCmtSel = null;
  // v1: los ids de la vista son el lugar en la lista; al quitar uno se corren.
  if (viejos && anaCmtSel && anaCmtSel.tipo === 'tema') anaCmtSel = null;
  anaSaveTema({ v2: { accion: 'quitar', id }, v1: viejos }, { focusAfter: 'add' });
});

anaB.temaCancel.addEventListener('click', () => anaCloseTemaForm());
anaB.temaForm.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    anaCloseTemaForm();
  }
});

// ---------------------------------------------------------------- comparación con la cuenta

function anaFmtValor(x, unidad) {
  if (x === null || x === undefined) return '—';
  return unidad === '%' ? `${Math.round(x)} %` : ANA_DEC.format(x);
}

function anaRenderCmp(v) {
  const c = v.comparacion;
  anaB.cmpAcc.textContent = v.cuenta ? `@${v.cuenta}` : 'la cuenta';
  if (!v.cuenta || c.primero || !c.promedio) {
    anaB.cmpHint.textContent = '';
    anaB.cmp.replaceChildren(anaEl('p', 'note', v.cuenta ? `No hay análisis anteriores de @${v.cuenta} para comparar.` : 'Sin la cuenta, no hay con qué comparar.'));
    anaB.hist.replaceChildren();
    anaHistDrawnW = 0;
    anaB.histLbl.textContent = '';
    return;
  }
  anaB.cmpHint.textContent = `promedio de ${anaPlural(c.n, 'análisis anterior', 'análisis anteriores')} de la cuenta`;
  const filas = [
    { lb: 'Comentarios negativos', now: c.actual.neg, avg: c.promedio.neg, unidad: '%', kind: 'bad' },
    { lb: 'Comentarios', now: c.actual.comentarios, avg: c.promedio.comentarios, unidad: '', kind: 'vol' },
    { lb: 'Verificados que comentaron', now: c.actual.verificados, avg: c.promedio.verificados, unidad: '', kind: 'warn' },
    { lb: 'Hablan del posteo', now: c.actual.sobrePosteo, avg: c.promedio.sobrePosteo, unidad: '%', kind: 'good', na: !v.disponible.sobrePosteo },
  ];
  anaB.cmp.replaceChildren(
    ...filas.map((f) => {
      const r = anaEl('div', 'r');
      const izq = anaEl('div');
      const lb = anaEl('div', 'lb');
      const val = anaEl('b', '', anaFmtValor(f.now, f.unidad));
      val.append(' ', anaEl('small', '', `vs. ${anaFmtValor(f.avg, f.unidad)}`));
      lb.append(anaEl('span', '', f.lb), val);
      izq.append(lb);
      const dl = anaEl('div', 'dl');
      if (f.now === null || f.avg === null || f.now === undefined || f.avg === undefined) {
        dl.append('—', anaEl('small', '', f.na ? 'no disponible' : 'sin dato'));
        r.append(izq, dl);
        return r;
      }
      const d = f.now - f.avg;
      let cls = '';
      let tag = 'igual';
      const distinto = f.unidad === '%' ? Math.abs(d) > 2 : f.avg > 0 ? Math.abs(d) / f.avg > 0.15 : f.now > 0;
      if (distinto) {
        if (f.kind === 'bad') [cls, tag] = d > 0 ? ['bad', 'peor'] : ['good', 'mejor'];
        else if (f.kind === 'good') [cls, tag] = d < 0 ? ['bad', 'peor'] : ['good', 'mejor'];
        else if (f.kind === 'warn') [cls, tag] = d > 0 ? ['warn', 'atención'] : ['', 'menos'];
        else tag = d > 0 ? 'más volumen' : 'menos volumen';
      }
      // Nunca "N veces": puntos para los porcentajes, % de cambio para las cantidades.
      const texto = f.unidad === '%' ? `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(Math.round(d))} pts` : f.avg > 0 ? `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(Math.round((d / f.avg) * 100))} %` : '—';
      dl.className = `dl ${cls}`.trim();
      dl.append(texto, anaEl('small', '', tag));
      const mx = Math.max(f.now, f.avg) || 1;
      const bars = anaEl('div', 'bars');
      bars.setAttribute('aria-hidden', 'true');
      const now = anaEl('i', `now ${cls}`.trim());
      now.dataset.w = `${(f.now / mx) * 100}%`;
      const avg = anaEl('i', 'avg');
      avg.dataset.w = `${(f.avg / mx) * 100}%`;
      bars.append(now, avg);
      izq.append(bars);
      r.append(izq, dl);
      return r;
    })
  );
  anaGrow(anaB.cmp);
  anaRenderHist();
}

// La serie de % negativo de los análisis anteriores de la cuenta, al ancho
// real de la tarjeta (con la vista oculta se dibuja al aparecer).
function anaRenderHist() {
  const v = anaVista();
  const c = v && v.comparacion;
  const serie = c && !c.primero && Array.isArray(c.serie) ? c.serie.filter((s) => s.neg !== null && Number.isFinite(s.neg)) : [];
  // Sin el % negativo de esta publicación (todo ruido) no hay "esta" que marcar: no se dibuja.
  if (serie.length < 2 || !serie[serie.length - 1].actual) {
    anaB.hist.replaceChildren();
    anaHistDrawnW = 0;
    anaB.histLbl.textContent = '';
    return;
  }
  const visible = Math.round(anaB.hist.clientWidth);
  const previos = serie.length - 1;
  anaB.histLbl.textContent = `% de comentarios negativos ${previos === 1 ? 'en el análisis anterior' : `en los últimos ${formatCount(previos)} análisis`} de @${v.cuenta} y en este · el punto grande es esta publicación${c.promedio.neg !== null ? ` · la línea punteada, el promedio (${Math.round(c.promedio.neg)} %)` : ''}`;
  if (!visible) {
    anaHistDrawnW = 0;
    anaB.hist.replaceChildren(anaEl('span', 'sr', ''));
    return;
  }
  anaHistDrawnW = visible;
  const W = Math.max(240, visible);
  const H = 84;
  const vals = serie.map((s) => s.neg).concat(c.promedio.neg !== null ? [c.promedio.neg] : []);
  const lo = Math.max(0, Math.min(...vals) - 8);
  const hi = Math.min(100, Math.max(...vals) + 8);
  const x = (i) => 10 + (i / (serie.length - 1)) * (W - 20);
  const y = (val) => H - 12 - ((val - lo) / (hi - lo || 1)) * (H - 28);
  const svg = anaSvg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  const ultimo = serie[serie.length - 1];
  svg.setAttribute('aria-label', `Negativos: ${Math.round(ultimo.neg)} % en esta publicación${c.promedio.neg !== null ? `, ${Math.round(c.promedio.neg)} % de promedio en la cuenta` : ''}.`);
  if (c.promedio.neg !== null) svg.append(anaSvg('line', { x1: 10, x2: W - 10, y1: y(c.promedio.neg), y2: y(c.promedio.neg), class: 'h-avg' }));
  svg.append(anaSvg('path', { d: `M${serie.map((s, i) => `${x(i).toFixed(1)},${y(s.neg).toFixed(1)}`).join('L')}`, class: 'h-line', pathLength: 1 }));
  serie.forEach((s, i) => {
    const actual = i === serie.length - 1;
    const dot = anaSvg('circle', { cx: x(i), cy: y(s.neg), r: actual ? 5 : 2.5, class: `h-dot${actual ? ' now' : ''}` });
    dot.dataset.tipTitle = actual ? 'Esta publicación' : 'Análisis anterior';
    dot.dataset.tip = `${Math.round(s.neg)} % negativo`;
    svg.append(dot);
  });
  const txt = anaSvg('text', { x: x(serie.length - 1) - 8, y: Math.max(12, y(ultimo.neg) - 9), 'text-anchor': 'end', class: 'h-txt' });
  txt.textContent = `${Math.round(ultimo.neg)} %`;
  svg.append(txt);
  anaB.hist.replaceChildren(svg);
}

// ---------------------------------------------------------------- cuándo comentaron

function anaHourLabel(h) {
  if (h === 0) return 'publicación';
  if (h >= 48 && h % 24 === 0) return `+${h / 24} d`;
  return `+${h} h`;
}

// El tramo del pico, para leer: "la primera hora", "+5 h"…
function anaPeakLabel(h, unidadHoras) {
  if (h === 0) return unidadHoras === 24 ? 'el primer día' : unidadHoras === 6 ? 'las primeras 6 h' : 'la primera hora';
  return anaHourLabel(h);
}

function anaChip(pre, valor, { vivo = false } = {}) {
  const c = anaEl('span', 'chip');
  if (vivo) {
    const dot = anaEl('i', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    c.append(dot);
  }
  c.append(pre, anaEl('b', '', valor));
  return c;
}

function anaRenderWhen() {
  const v = anaVista();
  const t = v && v.tiempo;
  const c = t && t.cuando;
  // Los chips: primer comentario, el 50 %, el pico y las últimas 24 h.
  const chips = [];
  if (t) {
    if (t.primeroMin !== null) {
      chips.push(t.primeroMin < 1 ? anaChip('Primer comentario ', 'en el primer minuto') : anaChip('Primer comentario ', t.primeroMin < 60 ? `+${t.primeroMin} min` : anaHh(t.primeroMin / 60)));
    }
    if (t.mitadHoras !== null) chips.push(anaChip('El 50 % llegó en ', t.mitadHoras < 1 ? `${Math.max(1, Math.round(t.mitadHoras * 60))} min` : `${ANA_DEC.format(Math.round(t.mitadHoras * 10) / 10)} h`));
    if (t.picoHoras !== null && c) chips.push(anaChip('Pico ', anaPeakLabel(t.picoHoras, c.unidadHoras)));
    if (t.ultimas24 !== null) {
      const ch = anaChip('Últimas 24 h: ', formatCount(t.ultimas24), { vivo: t.ultimas24 > 0 });
      ch.append(t.ultimas24 > 0 ? ' · sigue vivo' : ' · conversación cerrada');
      chips.push(ch);
    }
  }
  anaB.tlk.replaceChildren(...chips);
  if (!c || !Array.isArray(c.tramos) || !c.tramos.length) {
    anaWhenDrawnW = 0;
    anaB.when.replaceChildren();
    anaB.whenHint.textContent = '';
    anaB.whenNote.textContent = t
      ? 'La curva necesita la fecha de la publicación y al menos 10 comentarios con fecha.'
      : 'Los comentarios no traen fecha: no se puede armar.';
    return;
  }
  const unidad = { 1: 'por hora', 6: 'cada 6 horas', 24: 'por día' }[c.unidadHoras] || 'por tramo';
  anaB.whenHint.textContent = `comentarios ${unidad} desde la publicación`;
  anaB.whenNote.textContent = `${formatCount(c.conFecha)} de ${formatCount(c.total)} comentarios traídos tienen fecha.`;

  // Al ancho real de la tarjeta: el texto no se estira. Con la solapa
  // oculta no hay ancho: se dibuja cuando aparece (el ResizeObserver).
  const visible = Math.round(anaB.when.clientWidth);
  if (!visible) {
    anaWhenDrawnW = 0;
    anaB.when.replaceChildren();
    return;
  }
  const W = Math.max(280, visible);
  anaWhenDrawnW = visible;
  const H = 190;
  const L = 30;
  const R = 12;
  const T = 26;
  const B = 24;
  const data = c.tramos.map((x) => x.n);
  const n = data.length;
  const mx = Math.max(1, ...data) * 1.12;
  const x = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const y = (val) => H - B - (val / mx) * (H - T - B);
  const pico = c.pico || { indice: 0, h: 0, n: data[0] };

  const svg = anaSvg('svg', { class: 'tl', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  svg.setAttribute('aria-label', `Comentarios ${unidad} desde la publicación. Pico: ${anaPeakLabel(pico.h, c.unidadHoras)}, ${anaPlural(pico.n, 'comentario', 'comentarios')}.`);
  const defs = anaSvg('defs');
  const grad = anaSvg('linearGradient', { id: 'anaTlGrad', x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.append(anaSvg('stop', { offset: 0, 'stop-color': 'var(--accent)', 'stop-opacity': 0.45 }), anaSvg('stop', { offset: 1, 'stop-color': 'var(--accent)', 'stop-opacity': 0 }));
  defs.append(grad);
  svg.append(defs);

  // Cada línea de la grilla a la altura del número que la rotula (0, la
  // mitad y el máximo); arriba queda un 12 % de aire para el rótulo del pico.
  const maximo = Math.max(1, ...data);
  for (const k of [0, 0.5, 1]) {
    const gy = y(k * maximo);
    svg.append(anaSvg('line', { x1: L, x2: W - R, y1: gy, y2: gy, class: 'tl-grid' }));
    const label = anaSvg('text', { x: L - 4, y: gy + 3, 'text-anchor': 'end', class: 'tl-txt' });
    label.textContent = formatCount(Math.round(k * maximo));
    svg.append(label);
  }

  const line = `M${data.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('L')}`;
  svg.append(anaSvg('path', { d: `${line}L${x(n - 1).toFixed(1)},${H - B}L${x(0).toFixed(1)},${H - B}Z`, fill: 'url(#anaTlGrad)', class: 'tl-area' }));
  svg.append(anaSvg('path', { d: line, class: 'tl-line', pathLength: 1 }));

  // Cinco marcas en el eje; con poco ancho (celular), tres: si no, se pisan.
  const cortes = W < 480 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const ticks = [...new Set(cortes.map((k) => Math.round(k * (n - 1))))];
  for (const i of ticks) {
    const label = anaSvg('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', class: 'tl-txt' });
    label.textContent = anaHourLabel(c.tramos[i].h);
    svg.append(label);
  }

  // El 50 %: a qué altura de la curva llegó la mitad de los comentarios.
  if (t.mitadHoras !== null && n > 1) {
    const idx = Math.min(n - 1, t.mitadHoras / c.unidadHoras);
    const hx = L + (idx / (n - 1)) * (W - L - R);
    const half = anaSvg('g', { class: 'tl-half' });
    half.append(anaSvg('line', { x1: hx, x2: hx, y1: T + 4, y2: H - B }));
    const ht = anaSvg('text', { x: hx + 5, y: H - B - 6 });
    ht.textContent = '50 % de los comentarios';
    half.append(ht);
    svg.append(half);
    // Si no entra a la derecha, va a la izquierda de la línea.
    requestAnimationFrame(() => {
      try {
        if (hx + 5 + ht.getComputedTextLength() > W - R) {
          ht.setAttribute('x', String(hx - 5));
          ht.setAttribute('text-anchor', 'end');
        }
      } catch {
        /* sin medida, queda */
      }
    });
  }

  const px = x(pico.indice);
  const marca = anaSvg('g', { class: 'tl-peak' });
  marca.append(anaSvg('line', { x1: px, x2: px, y1: T - 6, y2: H - B }));
  marca.append(anaSvg('circle', { cx: px, cy: y(data[pico.indice]), r: 4 }));
  const cerca = px > W - 170;
  const txt = anaSvg('text', { x: cerca ? px - 6 : px + 6, y: T - 10, 'text-anchor': cerca ? 'end' : 'start', class: 'tl-peak-txt' });
  txt.textContent = `pico: ${anaPeakLabel(pico.h, c.unidadHoras)} · ${anaPlural(pico.n, 'comentario', 'comentarios')}`;
  marca.append(txt);
  svg.append(marca);

  // Una franja por tramo con su número (tip.js).
  const ancho = n === 1 ? W - L - R : (W - L - R) / (n - 1);
  data.forEach((val, i) => {
    const x0 = Math.max(L, x(i) - ancho / 2);
    const x1 = Math.min(W - R, x(i) + ancho / 2);
    const r = anaSvg('rect', { x: x0, y: T, width: Math.max(1, x1 - x0), height: H - T - B, class: 'tl-hit' });
    // El primer tramo, como lo dice el pico: "La primera hora", "Las primeras 6 h", "El primer día".
    r.dataset.tipTitle = c.tramos[i].h === 0 ? anaPeakLabel(0, c.unidadHoras).replace(/^./, (l) => l.toUpperCase()) : anaHourLabel(c.tramos[i].h);
    r.dataset.tip = anaPlural(val, 'comentario', 'comentarios');
    svg.append(r);
  });
  anaB.when.replaceChildren(svg);
  // El rótulo del pico entero adentro del gráfico (en celular puede medir casi todo el ancho).
  try {
    const largo = txt.getComputedTextLength();
    const x0 = Math.min(Math.max(cerca ? px - 6 - largo : px + 6, L), Math.max(L, W - R - largo));
    txt.setAttribute('text-anchor', 'start');
    txt.setAttribute('x', x0.toFixed(1));
  } catch {
    /* sin medida, queda donde estaba */
  }
}

// Se redibujan cuando el ancho cambia respecto del que se usó al dibujar
// (también al volver a la solapa o a la vista si se armaron ocultas).
// En el cuadro siguiente: redibujar dentro del aviso cambia el alto y el
// navegador lo marca como un bucle.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() =>
    requestAnimationFrame(() => {
      const w = Math.round(anaB.when.clientWidth);
      if (!anaShown || !w || w === anaWhenDrawnW) return;
      anaRenderWhen();
    })
  ).observe(anaB.when);
  new ResizeObserver(() =>
    requestAnimationFrame(() => {
      const w = Math.round(anaB.hist.clientWidth);
      if (!anaShown || !w || w === anaHistDrawnW) return;
      anaRenderHist();
    })
  ).observe(anaB.hist);
}

// ---------------------------------------------------------------- pedidos

function anaRenderAsks(v) {
  if (!v.pedidos) {
    anaB.asks.replaceChildren(anaNa('los pedidos se agrupan en los análisis nuevos'));
    return;
  }
  if (!v.pedidos.length) {
    anaB.asks.replaceChildren(anaEl('div', 'empty', 'No hubo pedidos ni preguntas concretas.'));
    return;
  }
  anaB.asks.replaceChildren(
    ...v.pedidos.map((p, i) => {
      const elegido = Boolean(anaCmtSel && anaCmtSel.tipo === 'pedido' && anaCmtSel.idx === i);
      const b = anaEl('button', `an-ask${p.delHecho ? ' hot' : ''}${elegido ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(elegido));
      b.style.animationDelay = `${i * 70}ms`;
      const izq = anaEl('div', '', p.texto);
      if (p.ejemplo) izq.append(anaEl('small', '', `«${p.ejemplo.length > 140 ? `${p.ejemplo.slice(0, 140)}…` : p.ejemplo}»`));
      const n = anaEl('div', 'n', formatCount(p.n));
      n.append(anaEl('small', '', anaPct(p.proporcion)));
      b.append(izq, n);
      b.setAttribute('aria-label', `${p.texto}: ${anaPlural(p.n, 'comentario', 'comentarios')}${p.delHecho ? ', del hecho dominante' : ''}. Un clic los muestra abajo.`);
      b.addEventListener('click', () => {
        anaCmtSel = elegido ? null : { tipo: 'pedido', idx: i, texto: p.texto, ids: new Set(p.ids) };
        anaSelCambio();
        // Al soltarlo, el foco queda en el mismo pedido (el botón se rehízo).
        if (!anaCmtSel && anaB.asks.children[i]) anaB.asks.children[i].focus();
      });
      return b;
    })
  );
}

// ---------------------------------------------------------------- los que más pegaron

function anaRenderTop(v) {
  const lista = v.top;
  const mx = Math.max(1, ...lista.map((c) => c.likes || 0));
  anaB.top.replaceChildren(
    ...lista.map((c, i) => {
      const tono = ANA_TONO[c.tono] || ANA_SIN_CLASIFICAR;
      const row = anaEl('div', 'an-topc');
      row.style.animationDelay = `${i * 70}ms`;
      const lk = anaEl('div', 'lk');
      lk.append(anaEl('b', '', c.likes === null ? '—' : formatCount(c.likes)), anaEl('small', '', 'likes'));
      const body = anaEl('div');
      const w = anaEl('div', 'w');
      w.append(anaEl('b', '', `@${c.usuario}`));
      if (c.verificada) w.append(anaVerificada());
      w.append(anaEl('span', tono.text, tono.label));
      const hh = anaHh(c.horas);
      if (hh) w.append(anaEl('span', '', hh));
      if (c.delHecho) w.append(anaEl('span', 'ev', 'del hecho'));
      const bar = anaEl('div', 'bar');
      bar.setAttribute('aria-hidden', 'true');
      const bi = anaEl('i', tono.bar);
      bi.dataset.w = `${((c.likes || 0) / mx) * 100}%`;
      bar.append(bi);
      body.append(w, anaEl('div', 'tx', c.texto), bar);
      row.append(lk, body);
      return row;
    })
  );
  anaGrow(anaB.top);
  const r = v.topResumen;
  if (!lista.length) anaB.topNote.textContent = '';
  else if (v.hecho) {
    anaB.topNote.textContent = `${formatCount(r.delHecho)} de los ${lista.length} más likeados hablan del hecho dominante, no del posteo. Los ${lista.length} suman ${anaPlural(r.likes, 'like', 'likes')}.`;
  } else {
    anaB.topNote.textContent = `Los ${lista.length} más likeados suman ${anaPlural(r.likes, 'like', 'likes')}; ${r.positivos === 1 ? '1 es positivo' : `${formatCount(r.positivos)} son positivos`}.`;
  }
}

// ---------------------------------------------------------------- reclamos

function anaRenderRecl(v) {
  const todos = Array.isArray(v.reclamos) ? v.reclamos : [];
  const ubicados = todos.filter((r) => r.enMapa && Number.isFinite(r.x) && Number.isFinite(r.y));
  const lons = ANA_CABA.map((q) => q[0]);
  const lats = ANA_CABA.map((q) => q[1]);
  const mnx = Math.min(...lons);
  const mxx = Math.max(...lons);
  const mny = Math.min(...lats);
  const mxy = Math.max(...lats);
  const W = 320;
  const H = 250;
  const pad = 16;
  const sc = Math.min((W - pad * 2) / (mxx - mnx), (H - pad * 2) / ((mxy - mny) * 1.2));
  const ox = (W - (mxx - mnx) * sc) / 2;
  const oy = (H - (mxy - mny) * sc * 1.2) / 2;
  const pr = (lo, la) => [ox + (lo - mnx) * sc, oy + (mxy - la) * sc * 1.2];
  const svg = anaB.map;
  svg.replaceChildren(anaSvg('polygon', { points: ANA_CABA.map((q) => pr(q[0], q[1]).map((n) => n.toFixed(1)).join(',')).join(' '), class: 'caba' }));
  for (const [lo, la] of ANA_COMUNAS) {
    const [cx, cy] = pr(lo, la);
    svg.append(anaSvg('circle', { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 1.5, class: 'com' }));
  }
  // Los que quedan a menos de 16 px se agrupan en un punto con su número.
  const grupos = [];
  for (const r of ubicados) {
    const [x, y] = pr(r.x, r.y);
    const g = grupos.find((k) => Math.hypot(k.x - x, k.y - y) < 16);
    if (g) {
      g.items.push(r);
      g.x = (g.x * (g.items.length - 1) + x) / g.items.length;
      g.y = (g.y * (g.items.length - 1) + y) / g.items.length;
    } else grupos.push({ x, y, items: [r] });
  }
  grupos.forEach((g, i) => {
    const color = temaColor(g.items[0].categoria);
    const n = g.items.length;
    const rad = n > 1 ? 9 + Math.min(6, n) : 6;
    const dot = anaSvg('g', { class: 'dot' });
    dot.style.animationDelay = `${0.2 + i * 0.12}s`;
    dot.dataset.tipTitle = n === 1 ? anaReclTitulo(g.items[0]) : `${n} reclamos`;
    dot.dataset.tip = g.items
      .slice(0, 4)
      .map((r) => (n === 1 ? `${r.direccion || 'sin dirección'}${r.autor ? ` · @${r.autor}` : ''}` : `${anaReclTitulo(r)} · ${r.direccion || 'sin dirección'}`))
      .concat(n > 4 ? ['…'] : [])
      .join('\n');
    const halo = anaSvg('circle', { class: 'halo', cx: g.x.toFixed(1), cy: g.y.toFixed(1), r: Math.min(rad, 7), fill: color, opacity: 0.35 });
    halo.style.animationDelay = `${i * 0.4}s`;
    dot.append(halo, anaSvg('circle', { class: 'p', cx: g.x.toFixed(1), cy: g.y.toFixed(1), r: rad, fill: color }));
    if (n > 1) {
      const t = anaSvg('text', { x: g.x.toFixed(1), y: (g.y + 3.5).toFixed(1), 'text-anchor': 'middle' });
      t.textContent = String(n);
      dot.append(t);
    }
    svg.append(dot);
  });
  // Sin ubicar: los pendientes se van a ubicar (USIG, después); los demás
  // (fuera de la Ciudad, dirección no encontrada…) ya no.
  const pendientes = todos.filter((r) => !ubicados.includes(r) && r.geoStatus === 'pendiente').length;
  const sinUbicacion = todos.length - ubicados.length - pendientes;
  if (!ubicados.length) {
    const t = anaSvg('text', { x: W / 2, y: H - 12, 'text-anchor': 'middle', class: 'vacio' });
    t.textContent = !todos.length ? 'Sin reclamos con dirección' : pendientes ? 'Todavía ninguno ubicado' : 'Ninguno se pudo ubicar';
    svg.append(t);
  }
  svg.setAttribute('aria-label', ubicados.length ? `${anaPlural(ubicados.length, 'reclamo ubicado', 'reclamos ubicados')} en la Ciudad` : 'Mapa de la Ciudad sin reclamos ubicados');

  anaB.reclHint.textContent = todos.length
    ? `${anaPlural(ubicados.length, 'ubicado', 'ubicados')}${ubicados.length ? ` en ${anaPlural(grupos.length, 'punto', 'puntos')}` : ''}${pendientes ? ` · ${formatCount(pendientes)} sin ubicar todavía` : ''}${sinUbicacion ? ` · ${formatCount(sinUbicacion)} sin ubicación` : ''}`
    : 'ninguno en esta publicación';
  const motivo = (r) => (r.geoStatus === 'pendiente' ? 'sin ubicar todavía' : r.geoStatus === 'fuera_caba' ? 'fuera de la Ciudad' : 'sin ubicación');
  const filas = [...ubicados, ...todos.filter((r) => !ubicados.includes(r))].slice(0, ANA_RECL_LISTA).map((r) => {
    const fila = anaEl('div');
    const punto = anaEl('i', ubicados.includes(r) ? '' : 'sin');
    if (ubicados.includes(r)) punto.style.background = temaColor(r.categoria);
    punto.setAttribute('aria-hidden', 'true');
    const texto = anaEl('span', '', `${anaReclTitulo(r)} · ${r.direccion || 'sin dirección'}`);
    if (!ubicados.includes(r)) texto.append(anaEl('span', 'sr', ` (${motivo(r)})`));
    fila.append(punto, texto, anaEl('small', '', r.autor ? `@${r.autor}` : ''));
    return fila;
  });
  const pie = anaEl('div');
  const vacio = anaEl('i');
  vacio.setAttribute('aria-hidden', 'true');
  const link = anaEl('a', '', todos.length > ANA_RECL_LISTA ? `+${formatCount(todos.length - ANA_RECL_LISTA)} más · ver en el Mapa` : 'Ver en el Mapa de reclamos →');
  link.href = '#tab-claims-map';
  link.addEventListener('click', (e) => {
    if (typeof openTab === 'function') {
      e.preventDefault();
      openTab('claims-map');
      window.scrollTo(0, 0);
    }
  });
  pie.append(vacio, link, anaEl('small'));
  anaB.recl.replaceChildren(...(todos.length ? [...filas, pie] : [anaEl('p', 'note', 'Ningún comentario dejó un reclamo con dirección.')]));
}

function anaReclTitulo(r) {
  return r.subcategoria || r.categoria || 'Reclamo';
}

// ---------------------------------------------------------------- etiquetas y emojis

function anaRenderTags(v) {
  const e = v.etiquetas;
  const mx = Math.max(1, ...e.cuentas.map((t) => t.n));
  anaB.tagRows.replaceChildren(
    ...(e.cuentas.length
      ? e.cuentas.map((t, i) => {
          const row = anaEl('div', 'an-row');
          row.style.animation = `rise 0.45s ${i * 60}ms both`;
          const lb = anaEl('span', 'lb', t.cuenta);
          if (t.verificadaQueComento) lb.append(' ', anaVerificada());
          const tr = anaEl('span', 'tr');
          tr.setAttribute('aria-hidden', 'true');
          const bar = anaEl('i');
          bar.style.background = 'var(--glow)';
          bar.dataset.w = `${(t.n / mx) * 100}%`;
          tr.append(bar);
          row.append(lb, tr, anaEl('span', 'n', formatCount(t.n)));
          return row;
        })
      : [anaEl('p', 'note', 'Nadie etiquetó a otra cuenta.')])
  );
  anaGrow(anaB.tagRows);
  anaB.tags.replaceChildren(
    ...(e.hashtags.length
      ? e.hashtags.map((h, i) => {
          const c = anaEl('span', 'chip h', h.tag);
          c.style.animationDelay = `${(e.cuentas.length + i) * 60}ms`;
          c.append(anaEl('span', 'n', formatCount(h.n)));
          return c;
        })
      : [anaEl('span', 'note', 'Sin hashtags.')])
  );
  if (e.comentarios > 0 && e.cuentas[0]) {
    const primera = e.cuentas[0];
    anaB.tagsNote.textContent = `${anaPlural(e.comentarios, 'comentario etiqueta', 'comentarios etiquetan')} a alguien. La cuenta más etiquetada es ${primera.cuenta}${primera.verificadaQueComento ? ', una verificada que también comentó acá' : ''}.`;
  } else anaB.tagsNote.textContent = '';
}

function anaRenderEmo(v) {
  const e = v.emojis;
  const mx = Math.max(1, ...e.lista.map((x) => x.n));
  anaB.emo.replaceChildren(
    ...(e.lista.length
      ? e.lista.map((x, i) => {
          const d = anaEl('div');
          d.style.setProperty('--sz', `${Math.round(18 + (26 * x.n) / mx)}px`);
          d.style.setProperty('--dl', `${(i * 0.4).toFixed(1)}s`);
          d.style.animationDelay = `${i * 80}ms`;
          d.dataset.tipTitle = x.emoji;
          d.dataset.tip = anaPlural(x.n, 'vez', 'veces');
          d.append(anaEl('b', '', x.emoji), anaEl('small', '', formatCount(x.n)));
          return d;
        })
      : [anaEl('p', 'note', 'Casi no hubo emojis.')])
  );
  const hay = e.proporcionApoyo !== null && e.proporcionApoyo !== undefined;
  const [a, b] = anaB.emoSplit.children;
  anaShow(anaB.emoSplit, hay);
  if (hay) {
    const pa = Math.round(e.proporcionApoyo * 100);
    const pb = 100 - pa;
    a.style.width = '0';
    b.style.width = '0';
    a.textContent = pa >= 18 ? `apoyo ${pa} %` : '';
    b.textContent = pb >= 18 ? `bronca ${pb} %` : '';
    requestAnimationFrame(() => {
      a.style.width = `${pa}%`;
      b.style.width = `${pb}%`;
    });
  }
  anaB.emoNote.textContent =
    !hay
      ? 'Ningún emoji de apoyo ni de bronca.'
      : e.bronca > e.apoyo
        ? `El enojo le gana al aplauso: ${anaPlural(e.bronca, 'emoji', 'emojis')} de bronca contra ${formatCount(e.apoyo)} de apoyo.`
        : e.apoyo > e.bronca
          ? `Dominan los emojis de apoyo: ${formatCount(e.apoyo)} contra ${formatCount(e.bronca)} de bronca.`
          : `Empatan: ${formatCount(e.apoyo)} de apoyo y ${formatCount(e.bronca)} de bronca.`;
}

// ---------------------------------------------------------------- comentarios

function anaRenderSeg() {
  const v2 = anaEsV2();
  anaB.cmtSeg.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.f === anaCmtFilter;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    // aria-disabled, no disabled: sigue con el foco y su tooltip dice por qué.
    if (b.dataset.f === 'q') {
      b.setAttribute('aria-disabled', String(!v2));
      if (v2) {
        delete b.dataset.tip;
        b.removeAttribute('aria-label');
      } else {
        b.dataset.tip = `${ANA_NA}: los pedidos se marcan en los análisis nuevos.`;
        b.setAttribute('aria-label', `Preguntas: ${ANA_NA.toLowerCase()}`);
      }
    }
  });
}

const anaPlegar = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Los comentarios con la selección (tema, pedido o persona), la búsqueda y el filtro. Sin "Destacados", la lista entera. */
function anaCmtsBase() {
  const v = anaVista();
  let list = v.comentarios;
  const sel = anaCmtSel;
  if (sel && sel.tipo === 'tema') {
    list = v.version === 2 ? list.filter((c) => c.temaId === sel.id) : list.filter((c) => (c.temasV1 || []).includes(sel.nombre));
  } else if (sel && sel.tipo === 'pedido') {
    list = list.filter((c) => sel.ids.has(c.n));
  } else if (sel && sel.tipo === 'persona') {
    list = list.filter((c) => String(c.usuario).toLowerCase() === sel.usuario);
  }
  if (anaCmtQ) {
    const q = anaPlegar(anaCmtQ);
    list = list.filter((c) => anaPlegar(`${c.texto} @${c.usuario}`).includes(q));
  }
  return list;
}

function anaFilteredCmts(base) {
  const porLikes = (p, q) => (q.likes ?? -1) - (p.likes ?? -1) || p.n - q.n;
  if (anaCmtFilter === 'top') return [...base].sort(porLikes).slice(0, ANA_TOP);
  let list = base;
  if (anaCmtFilter === 'q') list = list.filter((c) => c.pedido === true);
  else if (anaCmtFilter === 'ver') list = list.filter((c) => c.verificada);
  else if (anaCmtFilter !== 'all') list = list.filter((c) => c.tono === anaCmtFilter);
  return [...list].sort(porLikes);
}

function anaBuildCmt(c, i) {
  const tono = ANA_TONO[c.tono] || ANA_SIN_CLASIFICAR;
  const row = anaEl('div', 'cmt');
  if (i < 10) row.style.animationDelay = `${i * 60}ms`;
  const bar = anaEl('i', `sb ${tono.bar}`);
  bar.setAttribute('aria-hidden', 'true');
  const body = anaEl('div');
  const w = anaEl('div', 'w');
  w.append(anaEl('b', '', `@${c.usuario}`));
  if (c.verificada) w.append(anaVerificada());
  w.append(anaEl('span', '', c.likes === null ? '♥ —' : `♥ ${formatCount(c.likes)}`), anaEl('span', tono.text, tono.label));
  if (c.postura && ANA_POSTURA[c.postura]) w.append(anaEl('span', `ps ${c.postura}`, ANA_POSTURA[c.postura].label));
  const tema = c.tema || (c.temasV1 && c.temasV1.length ? c.temasV1.join(' · ') : null);
  if (tema) w.append(anaEl('span', 'tg', tema));
  if (c.pedido) w.append(anaEl('span', 'q', 'pregunta / pedido'));
  const hh = anaHh(c.horas);
  if (hh) w.append(anaEl('span', 'tm', hh));
  body.append(w, anaEl('p', '', c.texto));
  row.append(bar, body);
  return row;
}

function anaRenderCmts() {
  const v = anaVista();
  const base = anaCmtsBase();
  const list = anaFilteredCmts(base);
  // La línea de arriba: cuántos y la pastilla de lo elegido, con su ✕.
  const partes = [];
  partes.push(anaEl('span', '', `${anaCmtFilter === 'top' ? 'Los más likeados' : `${formatCount(list.length)} de ${formatCount(v.comentarios.length)}`}${anaCmtQ ? ` · «${anaCmtQ}»` : ''}`));
  const sel = anaCmtSel;
  if (sel) {
    const texto = sel.tipo === 'tema' ? `Tema: ${sel.nombre}` : sel.tipo === 'pedido' ? `Pedido: ${sel.texto}` : `@${sel.usuario}`;
    const chip = anaEl('span', 'chip on', texto);
    const x = anaEl('button', 'x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', `Sacar el filtro «${texto}»`);
    x.addEventListener('click', () => {
      anaCmtSel = null;
      anaSelCambio({ enfocar: false });
      anaB.cmtsTitle.focus();
    });
    chip.append(x);
    partes.push(chip);
  }
  if (anaCmtFilter === 'top' && !sel && !anaCmtQ) partes.push(anaEl('span', '', '· los demás filtros muestran la lista completa'));
  anaB.cmtN.replaceChildren(...partes);

  const visibles = anaCmtFilter === 'top' ? list : list.slice(0, anaCmtLimit);
  if (!visibles.length) {
    anaB.cmts.replaceChildren(anaEl('div', 'empty', 'No hay comentarios con ese filtro.'));
  } else {
    anaB.cmts.replaceChildren(...visibles.map(anaBuildCmt));
  }
  const resto = anaCmtFilter === 'top' ? 0 : list.length - visibles.length;
  anaShow(anaB.cmtsMore, resto > 0);
  if (resto > 0) anaB.cmtsMore.textContent = `Ver ${formatCount(Math.min(ANA_CMTS_PAGE, resto))} más · quedan ${formatCount(resto)}`;
}

/** Desde la tarjeta de verificados: los comentarios de esa persona. */
function anaFiltrarPersona(usuario) {
  const u = String(usuario).toLowerCase();
  const elegido = anaCmtSel && anaCmtSel.tipo === 'persona' && anaCmtSel.usuario === u;
  anaCmtSel = elegido ? null : { tipo: 'persona', usuario: u };
  anaSelCambio();
  if (anaCmtSel) anaB.cmtsTitle.closest('.card').scrollIntoView({ behavior: anaReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

anaB.cmtSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b || !anaShown || b.getAttribute('aria-disabled') === 'true') return;
  anaCmtFilter = b.dataset.f;
  anaCmtLimit = ANA_CMTS_PAGE;
  anaRenderSeg();
  anaRenderCmts();
});

anaB.cmtQ.addEventListener('input', () => {
  clearTimeout(anaCmtQTimer);
  anaCmtQTimer = setTimeout(() => {
    if (!anaShown) return;
    anaCmtQ = anaB.cmtQ.value.trim();
    anaCmtLimit = ANA_CMTS_PAGE;
    anaRenderCmts();
  }, 200);
});

anaB.cmtsMore.addEventListener('click', () => {
  const primera = anaCmtLimit;
  anaCmtLimit += ANA_CMTS_PAGE;
  anaRenderCmts();
  // El foco pasa al primero de los nuevos (si el botón se va, se perdería).
  const nuevo = anaB.cmts.children[primera];
  if (nuevo) {
    nuevo.tabIndex = -1;
    nuevo.focus();
  }
});

// ---------------------------------------------------------------- compartir

function anaReportText() {
  if (!anaShown) return '';
  // Un análisis v2 se comparte con el informe de 8 puntos, que ya trae los
  // temas (también los agregados a mano). Uno de la fase E, como entonces.
  if (anaEsV2() && typeof anaShown.informe === 'string') return anaShown.informe;
  const temas = anaTemasViejos();
  return window.TemasConversacion.assemble(anaShown.reporteAntes, temas, anaShown.reporteDespues);
}

function anaUsd(n) {
  return `US$ ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function anaRenderShare() {
  const a = anaShown;
  const v = a.vista;
  const text = anaReportText();
  anaB.waLen.textContent = `${anaEsV2() ? 'informe de 8 puntos' : 'informe'} · ${formatCount(text.length)} caracteres`;
  const largo = text.length > ANA_WA_CAP;
  anaB.waWarn.textContent = largo ? `Pasa los ${formatCount(ANA_WA_CAP)} caracteres: "Enviar por WhatsApp" lo corta ahí. Para mandarlo entero, usá "Copiar informe".` : '';
  anaShow(anaB.waWarn, largo);
  if (!anaB.waText.classList.contains('hidden')) anaB.waText.textContent = text;
  anaB.csvBtn.href = `/api/analisis/${a.id}/comentarios.csv?plataforma=${ANA_PLATAFORMA}`;
  anaB.csvBtn.dataset.tip = `${anaPlural(v.comentarios.length, 'comentario', 'comentarios')}, con tono${anaEsV2() ? ', postura, tema' : ''} y fecha en hora argentina`;
  const conReclamos = Boolean(a.reclamos > 0 && a.csv);
  anaShow(anaB.reclCsvBtn, conReclamos);
  if (conReclamos) {
    anaB.reclCsvBtn.href = `/api/analisis/${a.id}/reclamos.csv?plataforma=${ANA_PLATAFORMA}`;
    anaB.reclCsvBtn.dataset.tip = `${anaPlural(a.reclamos, 'reclamo', 'reclamos')} con ubicación`;
  }
  const c = v.costo;
  anaB.cost.textContent =
    c.total === null
      ? 'Costo del análisis: sin dato'
      : `Costo del análisis: ${anaUsd(c.total)}${c.apify !== null ? ` · Apify ${anaUsd(c.apify)}` : ''}${c.modelo !== null ? ` · modelo ${anaUsd(c.modelo)}` : ''}`;
}

anaB.waBtn.addEventListener('click', () => {
  const abrir = anaB.waText.classList.contains('hidden');
  if (abrir) anaB.waText.textContent = anaReportText();
  anaShow(anaB.waText, abrir);
  anaB.waBtn.setAttribute('aria-expanded', String(abrir));
  anaB.waBtn.textContent = abrir ? 'Ocultar el texto' : 'Ver texto para WhatsApp';
});

anaB.copyBtn.addEventListener('click', async () => {
  const texto = anaReportText();
  try {
    await navigator.clipboard.writeText(texto);
    anaToast(`Informe copiado · ${formatCount(texto.length)} caracteres`);
  } catch {
    anaToast('No se pudo copiar: usá "Ver texto para WhatsApp" y copialo de ahí');
  }
});

// WhatsApp Desktop/móvil con el esquema nativo. api.whatsapp.com/send sin
// teléfono muestra "Enlace incorrecto"; wa.me rompe los emojis al redirigir.
anaB.waShareBtn.addEventListener('click', () => {
  let text = anaReportText();
  if (!text.trim()) return;
  if (text.length > ANA_WA_CAP) {
    let cut = ANA_WA_CAP;
    if (/[\uD800-\uDBFF]$/.test(text.slice(0, cut))) cut -= 1;
    text = text.slice(0, cut);
  }
  const a = document.createElement('a');
  a.href = `whatsapp://send?text=${encodeURIComponent(text)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
