// --------------------------------------------------------------------
// Análisis de publicación de Instagram (diseño v4, fases E y F2): la
// solapa 3 de design/social-listening-v4.html. Prefijo ana / ANA_ (script
// clásico, ámbito global compartido). Lo carga solo instagram.html,
// después de postView.js (formatCount, accountColor, temaColor) y
// temasEditor.js (TemasConversacion.assemble); X tiene su propia solapa
// (x-analysis.js). Tres archivos:
//   analysis.js         el flujo: analizar, los pasos, los avisos, la tira
//                       de recientes, las dos vistas, la galería y el hash;
//   analysisBlocks.js   los bloques del resultado (anaRender);
//   analysisFiguras.js  verificados y figuras, y el diálogo de la lista.
//
// - "Analizar" pregunta primero si el link ya se analizó
//   (GET /api/analisis?url=): si hay uno terminado, lo avisa con su fecha
//   y ofrece verlo o analizar de nuevo, antes de gastar; si hay uno en
//   curso, lo sigue. Si no, POST /api/analyze responde el id y el análisis
//   corre en el servidor: la solapa consulta sus pasos cada segundo
//   (GET /api/analyze/progress) y dibuja el detalle y el porcentaje que
//   manda el trabajo. Ningún número ni frase se inventa acá.
// - Lo que se ve sale entero de la fila guardada (GET /api/analisis/:id):
//   `vista` (analysisMetrics) trae todo lo contado.
// - Vistas: "Analizar" y "Publicaciones analizadas" (la galería, con
//   búsqueda, filtro y orden del servidor). #analisis-<id> abre ese
//   análisis; #analisis-galeria, la galería. anaPreload(url), desde
//   "Analizar comentarios" del pop-up del Monitoreo, deja el link en el
//   campo sin analizar y saca de la vista el análisis de otra publicación.
// - Al terminar el análisis que se sigue, se muestra solo si la persona no
//   eligió otra cosa mientras tanto (otro link en el campo, otro análisis a
//   la vista); si no, un aviso "Terminó el análisis de @cuenta · Ver". Al
//   cargar la página se siguen solo los análisis en curso propios.
//
// Todo dato entra por textContent o atributos; el SVG, con createElementNS.
// --------------------------------------------------------------------

const ANA_PLATAFORMA = 'instagram';
const ANA_POLL_MS = 1000;
const ANA_POLL_RETRY_MS = 3000;
const ANA_POLL_MAX_FAILS = 60; // unos 3 minutos sin respuesta
const ANA_STRIP = 10; // los recientes de la tira
const ANA_GAL_LIMIT = 100;
const ANA_TZ = 'America/Argentina/Buenos_Aires';
const ANA_SVG = 'http://www.w3.org/2000/svg';
const ANA_HASH = /^#analisis-(\d+)$/;
const ANA_HASH_GALERIA = '#analisis-galeria';

const anaEls = {
  url: document.getElementById('url'),
  btn: document.getElementById('analyzeBtn'),
  notice: document.getElementById('anaNotice'),
  noticeText: document.getElementById('anaNoticeText'),
  noticeView: document.getElementById('anaNoticeView'),
  noticeRun: document.getElementById('anaNoticeRun'),
  error: document.getElementById('anaError'),
  run: document.getElementById('anaRun'),
  phase: document.getElementById('anaPhase'),
  pct: document.getElementById('anaPct'),
  bar: document.getElementById('anaBar'),
  barWrap: document.getElementById('anaBarWrap'),
  steps: document.getElementById('anaSteps'),
  posts: document.getElementById('anaPosts'),
  empty: document.getElementById('anaEmpty'),
  result: document.getElementById('anaResult'),
  viewSeg: document.getElementById('anaView'),
  count: document.getElementById('anaCount'),
  v1: document.getElementById('anaV1'),
  v2: document.getElementById('anaV2'),
  galTitle: document.getElementById('galTitle'),
  galQ: document.getElementById('galQ'),
  galSeg: document.getElementById('galSeg'),
  galOrd: document.getElementById('galOrd'),
  galN: document.getElementById('galN'),
  gal: document.getElementById('anaGal'),
  toast: document.getElementById('anaToast'),
};

let anaRecientes = [];
let anaTotal = 0; // los análisis terminados (todos, no solo los de la tira)
let anaRecientesReady = Promise.resolve(null);
let anaShown = null; // el análisis a la vista (GET /api/analisis/:id)
let anaRunningId = null; // el que se está siguiendo
let anaRunningUrl = null; // su link
let anaFollowSwitch = true; // al terminar, ¿se lo muestra? (false si la persona eligió otra cosa)
let anaPollFails = 0; // consultas del progreso seguidas sin respuesta
let anaStepsSig = ''; // los pasos dibujados (para no redibujar lo mismo)
let anaBusy = false; // entre el clic y la respuesta de POST /api/analyze
let anaPollTimer = null;
let anaRunHideTimer = null;
let anaLoadSeq = 0; // descarta respuestas de un análisis que ya no se pidió
let anaNoticeFor = null; // el análisis ya terminado que avisa anaNotice
let anaOpened = false;
let anaSkipAutoShow = false;
let anaView = 1;
let anaGal = { q: '', f: 'all', ord: 'recent' };
let anaGalSeq = 0;
let anaGalTimer = null;
let anaToastTimer = null;

const ANA_DATE = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ANA_TZ });
const ANA_TIME = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ANA_TZ });
// Día y mes "dd/mm" armados a mano (con Intl es-AR, Chrome da "25/9").
const ANA_PARTS = new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ANA_TZ });

function anaReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function anaShow(el, on) {
  el.classList.toggle('hidden', !on);
}

function anaDateParts(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(ANA_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return { fecha: ANA_DATE.format(d), hora: ANA_TIME.format(d), corta: `${p.day}/${p.month}`, anio: p.year };
}

function anaPlural(n, uno, varios) {
  return `${formatCount(n)} ${n === 1 ? uno : varios}`;
}

/** Un elemento con clase y texto (por textContent). */
function anaEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function anaSvg(tag, attrs = {}) {
  const el = document.createElementNS(ANA_SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Las iniciales para el avatar: dos palabras del nombre o del usuario. */
function anaInitials(texto) {
  const partes = String(texto || '?')
    .replace(/^@+/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letras = partes.length >= 2 ? partes[0][0] + partes[1][0] : (partes[0] || '?').slice(0, 2);
  return letras.toUpperCase();
}

function anaToast(msg) {
  clearTimeout(anaToastTimer);
  anaEls.toast.textContent = msg;
  anaEls.toast.classList.add('on');
  anaToastTimer = setTimeout(() => anaEls.toast.classList.remove('on'), 2600);
}

async function anaApi(path, options = {}) {
  let resp;
  try {
    resp = await fetch(path, { credentials: 'same-origin', ...options });
  } catch {
    const err = new Error('No hay conexión con el servidor. Intentá de nuevo.');
    err.status = 0;
    throw err;
  }
  let data = null;
  if (resp.status !== 204) {
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
  }
  if (!resp.ok) {
    const err = new Error((data && data.error) || 'No se pudo completar el pedido. Intentá de nuevo.');
    err.status = resp.status;
    throw err;
  }
  return data;
}

// El código de la publicación de un link (/p/, /reel/, /reels/, /tv/).
function anaPostCode(url) {
  const m = /\/(?:p|reel|reels|tv)\/([^/?#]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * "Esta sección solo analiza publicaciones de Instagram." si el link es de
 * otro dominio (con el consejo de la solapa de X si es x.com/twitter.com);
 * '' si es de instagram.com o no es una url (eso lo responde el server).
 */
function anaLinkDeOtraRed(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  const esDe = (dominios) => dominios.some((d) => host === d || host.endsWith(`.${d}`));
  if (esDe(['instagram.com'])) return '';
  return `Esta sección solo analiza publicaciones de Instagram.${esDe(['x.com', 'twitter.com']) ? ' Usá la solapa de X.' : ''}`;
}

function anaSetError(text) {
  anaEls.error.textContent = text || '';
  anaShow(anaEls.error, Boolean(text));
}

function anaHideNotice() {
  anaNoticeFor = null;
  anaShow(anaEls.notice, false);
}

// ---------------------------------------------------------------- pasos

const ANA_STEP_CLASS = { 'en curso': 'run', ok: 'ok', error: 'err', omitido: 'skip' };

// La lista es una región viva (aria-live): se toca solo lo que cambió, así
// el lector de pantalla anuncia el paso que avanzó y no la lista entera en
// cada consulta.
function anaSetText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function anaRenderSteps(pasos) {
  const sig = JSON.stringify(pasos);
  if (sig === anaStepsSig) return;
  anaStepsSig = sig;
  const box = anaEls.steps;
  while (box.children.length > pasos.length) box.lastElementChild.remove();
  pasos.forEach((paso, i) => {
    let row = box.children[i];
    if (!row || row.dataset.key !== paso.key) {
      const nuevo = document.createElement('div');
      nuevo.dataset.key = paso.key;
      // Al cambiar algo de la fila, el lector la lee entera ("Traer los
      // comentarios (ok) 287 comentarios"), no el estado suelto.
      nuevo.setAttribute('aria-atomic', 'true');
      const mark = document.createElement('i');
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      const estado = document.createElement('span');
      estado.className = 'sr';
      const n = document.createElement('span');
      n.className = 'n';
      nuevo.append(mark, label, estado, n);
      if (row) row.replaceWith(nuevo);
      else box.append(nuevo);
      row = nuevo;
    }
    const [mark, label, estado, n] = row.children;
    const clase = `step ${ANA_STEP_CLASS[paso.estado] || ''}`.trim();
    if (row.className !== clase) row.className = clase;
    anaSetText(mark, paso.estado === 'ok' ? '✓' : paso.estado === 'error' ? '!' : paso.estado === 'omitido' ? '–' : String(i + 1));
    anaSetText(label, paso.label);
    anaSetText(estado, ` (${paso.estado})`);
    anaSetText(n, paso.detalle || '');
    anaShow(n, Boolean(paso.detalle));
  });
}

// La barra: el paso en curso y el porcentaje que manda el servidor.
function anaRenderProgress(view) {
  const enCurso = (view.pasos || []).find((p) => p.estado === 'en curso');
  anaSetText(anaEls.phase, view.estado === 'en curso' ? (enCurso ? `${enCurso.label}…` : 'Analizando…') : view.estado === 'ok' ? 'Listo' : 'No terminó');
  // Sin porcentaje (la fila de un análisis que ya no está en memoria) la
  // barra queda donde estaba: no vuelve a 0.
  const n = Number(view.porcentaje);
  if (view.porcentaje === null || view.porcentaje === undefined || !Number.isFinite(n)) return;
  const pct = Math.max(0, Math.min(100, Math.round(n)));
  anaSetText(anaEls.pct, `${pct} %`);
  anaEls.bar.style.width = `${pct}%`;
  anaEls.barWrap.setAttribute('aria-valuenow', String(pct));
}

// El análisis terminó sin pasos en memoria (el servidor se reinició): lo
// que seguía en curso no va a terminar.
function anaFailRunningSteps() {
  anaEls.steps.querySelectorAll('.step.run').forEach((row) => {
    row.className = 'step err';
    anaSetText(row.children[0], '!');
    anaSetText(row.children[2], ' (error)');
  });
  anaStepsSig = '';
}

function anaSetRunning(running) {
  anaEls.btn.disabled = running || anaBusy;
  anaEls.btn.setAttribute('aria-busy', String(running));
  anaEls.btn.textContent = running ? 'Analizando…' : 'Analizar';
}

// switchView: al terminar, mostrar ese análisis. Es false si la persona ya
// está mirando otra cosa que eligió (por ejemplo, entró por #analisis-<id>).
function anaFollow(id, { url = null, switchView = true } = {}) {
  clearTimeout(anaRunHideTimer);
  anaRunningId = Number(id);
  anaRunningUrl = url;
  anaFollowSwitch = switchView;
  anaPollFails = 0;
  anaSetError('');
  anaHideNotice();
  anaStepsSig = '';
  anaEls.steps.replaceChildren();
  anaRenderProgress({ estado: 'en curso', porcentaje: 0, pasos: [] });
  anaEls.run.classList.add('on');
  anaSetRunning(true);
  anaPoll();
}

function anaStopFollow() {
  clearTimeout(anaPollTimer);
  anaRunningId = null;
  anaRunningUrl = null;
  anaSetRunning(false);
}

// La persona eligió qué mirar mientras corre un análisis: al terminar, no
// se le cambia la vista.
function anaUserChose() {
  anaSkipAutoShow = true;
  anaFollowSwitch = false;
}

async function anaPoll() {
  clearTimeout(anaPollTimer);
  const id = anaRunningId;
  if (id === null) return;
  let view;
  try {
    view = await anaApi(`/api/analyze/progress?plataforma=${ANA_PLATAFORMA}&id=${id}`);
  } catch (err) {
    if (id !== anaRunningId) return;
    if (err.status === 404) {
      anaStopFollow();
      anaSetError('Ese análisis ya no existe.');
      return;
    }
    if (err.status === 401) {
      anaStopFollow();
      anaSetError('Se cerró la sesión. Volvé a entrar para ver cómo terminó el análisis.');
      return;
    }
    // Un corte de red o un error del servidor: se vuelve a preguntar, más
    // despacio, con un tope.
    anaPollFails += 1;
    if (anaPollFails >= ANA_POLL_MAX_FAILS) {
      anaStopFollow();
      anaSetError('Se perdió la conexión con el servidor. Recargá la página más tarde: si el análisis terminó bien, va a estar en Recientes.');
      return;
    }
    // Una sola vez: #anaError es role="alert" y reescribirlo cada 3 s lo
    // haría leer de nuevo.
    if (anaPollFails === 1) anaSetError('Sin respuesta del servidor; se vuelve a intentar…');
    anaPollTimer = setTimeout(anaPoll, ANA_POLL_RETRY_MS);
    return;
  }
  if (id !== anaRunningId) return;
  if (anaPollFails > 0) {
    anaPollFails = 0;
    anaSetError('');
  }
  if (view.pasos) {
    anaRenderSteps(view.pasos);
    anaRenderProgress(view);
  }
  if (view.estado === 'en curso') {
    anaPollTimer = setTimeout(anaPoll, ANA_POLL_MS);
    return;
  }
  const seguido = { url: anaRunningUrl, mostrar: anaFollowSwitch };
  anaStopFollow();
  if (!view.pasos && view.estado !== 'ok') anaFailRunningSteps();
  if (view.estado === 'ok') {
    anaRenderProgress({ ...view, estado: 'ok', porcentaje: 100 });
    // El campo se vacía solo si sigue con el link de este análisis (o
    // vacío): un link que la persona puso mientras tanto se queda.
    const campo = anaEls.url.value.trim();
    const mismoLink = !campo || (seguido.url && anaPostCode(campo) === anaPostCode(seguido.url));
    if (mismoLink && campo) anaEls.url.value = '';
    anaSkipAutoShow = true;
    await anaLoadRecientes();
    if (anaView === 2) anaLoadGaleria();
    if (mismoLink && seguido.mostrar && anaView === 1) await anaShowAnalysis(id);
    else anaShowDoneNotice(id);
    anaRunHideTimer = setTimeout(() => anaEls.run.classList.remove('on'), anaReducedMotion() ? 0 : 1200);
  } else {
    anaRenderProgress(view);
    anaSetError(view.error || 'El análisis no terminó.');
    anaLoadRecientes();
  }
}

// ---------------------------------------------------------------- analizar

async function anaAnalyze({ force = false } = {}) {
  // Enter con un análisis en curso (o esperando la respuesta) no dispara otro.
  if (anaRunningId !== null || anaBusy) return;
  const url = anaEls.url.value.trim();
  anaSetError('');
  anaHideNotice();
  if (!url) {
    anaSetError('Pegá primero el link de la publicación.');
    anaEls.url.focus();
    return;
  }
  // Mismo criterio que el backend (checkAnalyzeUrl), acá solo por el
  // dominio: un link de otra red se avisa al instante, sin pedido.
  const otraRed = anaLinkDeOtraRed(url);
  if (otraRed) {
    anaSetError(otraRed);
    return;
  }
  anaBusy = true;
  anaEls.btn.disabled = true;
  try {
    if (!force) {
      let ya = null;
      try {
        ya = await anaApi(`/api/analisis?plataforma=${ANA_PLATAFORMA}&url=${encodeURIComponent(url)}`);
      } catch (err) {
        // Un link que no es de una publicación: lo explica POST /api/analyze.
        if (err.status !== 400) throw err;
      }
      if (ya && ya.enCurso) {
        anaBusy = false;
        anaFollow(ya.enCurso, { url });
        return;
      }
      if (ya && ya.ultimo) {
        anaShowNotice(ya.ultimo);
        return;
      }
    }
    const started = await anaApi('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    anaBusy = false;
    anaFollow(started.id, { url });
  } catch (err) {
    anaSetError(err.message);
  } finally {
    anaBusy = false;
    if (anaRunningId === null) anaSetRunning(false);
  }
}

function anaShowNotice(ultimo) {
  anaNoticeFor = ultimo;
  anaShow(anaEls.noticeRun, true);
  const cuando = anaDateParts(ultimo.finishedAt);
  const n = Number.isFinite(ultimo.analizados) ? `, ${anaPlural(ultimo.analizados, 'comentario analizado', 'comentarios analizados')}` : '';
  anaEls.noticeText.textContent = cuando
    ? `Esta publicación ya se analizó el ${cuando.fecha} a las ${cuando.hora}${n}.`
    : `Esta publicación ya se analizó${n}.`;
  anaShow(anaEls.notice, true);
}

// Terminó el análisis que se seguía, pero la persona está mirando otra cosa
// o puso otro link: se avisa, sin cambiarle la vista ni el campo.
function anaShowDoneNotice(id) {
  const a = anaRecientes.find((r) => r.id === Number(id));
  anaNoticeFor = { id: Number(id), conservarCampo: true };
  anaShow(anaEls.noticeRun, false);
  anaEls.noticeText.textContent = a && a.cuenta ? `Terminó el análisis de @${a.cuenta}.` : 'Terminó el análisis.';
  anaShow(anaEls.notice, true);
}

// Lo llama "Analizar comentarios" del pop-up del Monitoreo: el link queda en
// el campo, sin gastar nada. Si a la vista había el análisis de otra
// publicación, deja de mostrarse; si ese link ya se analizó, se avisa.
function anaPreload(url) {
  // Precargar el mismo link que está corriendo es esperarlo: al terminar, se
  // muestra. Otro link es elegir otra cosa.
  const elMismo = anaRunningId !== null && anaRunningUrl && anaPostCode(url) === anaPostCode(anaRunningUrl);
  anaUserChose();
  if (elMismo) anaFollowSwitch = true;
  anaLoadSeq += 1;
  anaSetView(1, { updateHash: false });
  anaEls.url.value = url || '';
  anaSetError('');
  anaHideNotice();
  if (anaShown && anaPostCode(anaShown.url) !== anaPostCode(url)) anaClearShown();
  // El hash, el de lo que queda a la vista (podía ser el de la galería).
  if (anaPanelVisible() && location.hash !== anaHashActual()) history.replaceState(null, '', anaHashActual());
  if (anaRunningId !== null || !anaPostCode(url)) return;
  const seq = anaLoadSeq;
  anaApi(`/api/analisis?plataforma=${ANA_PLATAFORMA}&url=${encodeURIComponent(url)}`)
    .then((ya) => {
      if (seq !== anaLoadSeq || anaEls.url.value !== url) return;
      if (ya.enCurso) anaFollow(ya.enCurso, { url });
      else if (ya.ultimo && !(anaShown && anaShown.id === ya.ultimo.id)) anaShowNotice(ya.ultimo);
    })
    .catch(() => {});
}
window.anaPreload = anaPreload;

// ---------------------------------------------------------------- recientes

async function anaLoadRecientes() {
  try {
    const data = await anaApi(`/api/analisis?plataforma=${ANA_PLATAFORMA}&limit=${ANA_STRIP + 2}`);
    anaRecientes = data.recientes || [];
    anaTotal = Number.isFinite(data.total) ? data.total : anaRecientes.length;
    anaEls.count.textContent = formatCount(anaTotal);
    anaRenderStrip();
    return data;
  } catch {
    return null;
  }
}

function anaRenderStrip() {
  const strip = anaEls.posts;
  // Si el foco estaba en un botón de la tira, vuelve al mismo (por su id).
  const conFoco = strip.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  strip.replaceChildren();
  anaShow(strip, anaRecientes.length > 0);
  anaShow(anaEls.empty, anaRecientes.length === 0 && anaShown === null);
  if (anaRecientes.length === 0) return;
  strip.append(anaEl('span', 'lbl', 'Recientes'));
  for (const a of anaRecientes.slice(0, ANA_STRIP)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = String(a.id);
    const on = Boolean(anaShown && anaShown.id === a.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const fecha = anaDateParts(a.postedAt || a.finishedAt);
    const cuenta = a.cuenta ? `@${a.cuenta}` : 'Publicación';
    b.setAttribute('aria-label', `Análisis de ${cuenta}${fecha ? ` del ${fecha.fecha}` : ''}${a.tieneHecho ? ', con un hecho dominante' : ''}`);
    b.dataset.tipTitle = `${cuenta}${fecha ? ` · ${fecha.fecha}` : ''}`;
    const caption = (a.caption || '').replace(/\s+/g, ' ').trim();
    const lineas = [caption.length > 70 ? `${caption.slice(0, 70)}…` : caption];
    if (Number.isFinite(a.analizados)) lineas.push(anaPlural(a.analizados, 'comentario analizado', 'comentarios analizados'));
    if (a.tieneHecho) lineas.push('⚡ hecho dominante');
    b.dataset.tip = lineas.filter(Boolean).join('\n');
    b.style.setProperty('--a', accountColor(a.cuenta));
    const fondo = document.createElement('i');
    fondo.setAttribute('aria-hidden', 'true');
    b.append(fondo);
    if (a.imagen && a.imagen.thumbUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = a.imagen.thumbUrl;
      img.addEventListener('error', () => img.remove());
      b.append(img);
    }
    if (a.tieneHecho) {
      const em = document.createElement('em');
      em.setAttribute('aria-hidden', 'true');
      b.append(em);
    }
    b.append(anaEl('small', '', fecha ? fecha.corta : '—'));
    b.addEventListener('click', () => {
      anaUserChose();
      anaHideNotice();
      anaSetError('');
      anaShowAnalysis(a.id);
    });
    strip.append(b);
  }
  if (anaTotal > ANA_STRIP) {
    const mas = anaEl('button', 'btn sm ghost more', `+${formatCount(anaTotal - ANA_STRIP)} · ver todas`);
    mas.type = 'button';
    mas.addEventListener('click', () => anaSetView(2, { focus: true }));
    strip.append(mas);
  }
  if (conFoco) {
    const mismo = strip.querySelector(`button[data-id="${conFoco}"]`) || strip.querySelector('button');
    if (mismo) mismo.focus();
  }
}

// ---------------------------------------------------------------- vistas

function anaHashActual() {
  if (anaView === 2) return ANA_HASH_GALERIA;
  return anaShown ? `#analisis-${anaShown.id}` : '#tab-analysis';
}

function anaPanelVisible() {
  return !document.getElementById('tab-analysis').classList.contains('hidden');
}

function anaSetView(n, { updateHash = true, focus = false } = {}) {
  anaView = n === 2 ? 2 : 1;
  anaEls.viewSeg.querySelectorAll('button[data-v]').forEach((b) => {
    const on = Number(b.dataset.v) === anaView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  anaEls.v1.classList.toggle('on', anaView === 1);
  anaEls.v2.classList.toggle('on', anaView === 2);
  if (anaView === 2) anaLoadGaleria();
  if (updateHash && anaPanelVisible() && location.hash !== anaHashActual()) history.replaceState(null, '', anaHashActual());
  if (focus && anaView === 2) anaEls.galTitle.focus();
  // "Cuándo comentaron" y la serie se dibujan al ancho real: con la vista
  // oculta no lo tienen (el ResizeObserver de analysisBlocks.js los rehace).
}

anaEls.viewSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  if (Number(b.dataset.v) === 2) anaUserChose();
  anaSetView(Number(b.dataset.v));
});

// ---------------------------------------------------------------- galería

function anaLoadGaleria() {
  const seq = ++anaGalSeq;
  const qs = new URLSearchParams({ plataforma: ANA_PLATAFORMA, limit: String(ANA_GAL_LIMIT), f: anaGal.f, ord: anaGal.ord });
  if (anaGal.q) qs.set('q', anaGal.q);
  anaEls.gal.classList.add('loading');
  anaApi(`/api/analisis?${qs}`)
    .then((data) => {
      if (seq !== anaGalSeq) return;
      anaTotal = Number.isFinite(data.total) ? data.total : anaTotal;
      anaEls.count.textContent = formatCount(anaTotal);
      anaRenderGaleria(data.recientes || [], data.desde, data.coinciden);
    })
    .catch((err) => {
      if (seq !== anaGalSeq) return;
      anaEls.gal.replaceChildren(anaEl('div', 'empty', err.message));
      anaEls.galN.textContent = '';
    })
    .finally(() => {
      if (seq === anaGalSeq) anaEls.gal.classList.remove('loading');
    });
}

function anaRenderGaleria(lista, desde, coinciden) {
  const d = anaDateParts(desde);
  const filtrado = Boolean(anaGal.q || anaGal.f !== 'all');
  // coinciden: los que pasan la búsqueda y el filtro antes del tope de 100.
  const n = Number.isFinite(coinciden) ? coinciden : lista.length;
  const cortada = n > lista.length ? ` · se muestran ${formatCount(lista.length)}: buscá para ver otras` : '';
  anaEls.galN.textContent =
    anaTotal === 0
      ? 'Todavía no hay análisis.'
      : `${filtrado ? `${formatCount(n)} de ` : ''}${anaPlural(anaTotal, 'publicación analizada', 'publicaciones analizadas')}${d ? ` · desde el ${d.corta}` : ''}${cortada}`;
  if (!lista.length) {
    anaEls.gal.replaceChildren(anaEl('div', 'empty', anaTotal ? 'Ninguna publicación coincide con esa búsqueda o filtro.' : 'Todavía no hay análisis guardados.'));
    return;
  }
  anaEls.gal.replaceChildren(...lista.map(anaGalCard));
  requestAnimationFrame(() => anaEls.gal.querySelectorAll('.stack i').forEach((i) => (i.style.width = i.dataset.w)));
}

function anaGalCard(a, k) {
  const card = anaEl('button', 'card an-gc');
  card.type = 'button';
  card.style.setProperty('--a', accountColor(a.cuenta));
  if (k < 12) card.style.animationDelay = `${k * 50}ms`;
  const fecha = anaDateParts(a.postedAt || a.finishedAt);
  const cuenta = a.cuenta ? `@${a.cuenta}` : 'Publicación';
  const ph = anaEl('div', 'ph');
  if (a.imagen && a.imagen.thumbUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = a.imagen.thumbUrl;
    img.addEventListener('error', () => img.remove());
    ph.append(img);
  }
  if (a.tieneHecho) {
    const ev = anaEl('span', 'ev');
    const punto = document.createElement('i');
    punto.setAttribute('aria-hidden', 'true');
    ev.append(punto, 'hecho dominante');
    ph.append(ev);
  }
  if (fecha) ph.append(anaEl('span', 'dt', fecha.anio === anaDateParts(new Date().toISOString()).anio ? fecha.corta : `${fecha.corta}/${fecha.anio.slice(2)}`));
  const who = anaEl('span', 'who');
  const av = anaEl('span', 'av', anaInitials(a.cuentaNombre || a.cuenta));
  av.style.background = accountColor(a.cuenta);
  av.setAttribute('aria-hidden', 'true');
  who.append(av, anaEl('b', '', cuenta));
  ph.append(who);

  const bd = anaEl('div', 'bd');
  const caption = (a.caption || '').replace(/\s+/g, ' ').trim();
  bd.append(anaEl('h3', '', caption || 'Sin texto.'));
  const t = a.tonos || {};
  const base = (t.positivos || 0) + (t.neutrales || 0) + (t.negativos || 0);
  const stack = anaEl('div', 'stack');
  stack.setAttribute('aria-hidden', 'true');
  for (const [cls, n] of [['bg-pos', t.positivos], ['bg-neu', t.neutrales], ['bg-neg', t.negativos]]) {
    const i = anaEl('i', cls);
    i.dataset.w = `${base ? ((n || 0) / base) * 100 : 0}%`;
    stack.append(i);
  }
  bd.append(stack);
  if (a.temaEstrella) {
    const star = anaEl('div', 'star');
    const i = document.createElement('i');
    i.setAttribute('aria-hidden', 'true');
    star.append(i, anaEl('span', '', a.temaEstrella));
    bd.append(star);
  }
  const ft = anaEl('div', 'ft');
  const coms = anaEl('span', '', '💬 ');
  coms.append(anaEl('b', '', formatCount(a.analizados)));
  if (Number.isFinite(a.comentariosTotal) && a.comentariosTotal > a.analizados) coms.append(` de ${formatCount(a.comentariosTotal)}`);
  const neg = anaEl('span', a.pctNeg !== null && a.pctNeg >= 40 ? 'neg' : '', a.pctNeg === null ? '— neg.' : `${Math.round(a.pctNeg)} % neg.`);
  const ver = anaEl('span', '', '✓ ');
  ver.append(anaEl('b', '', formatCount(a.nVerificados || 0)));
  const rec = anaEl('span', '', '📍 ');
  rec.append(anaEl('b', '', formatCount(a.nReclamos || 0)));
  ft.append(coms, neg, ver, rec);
  bd.append(ft);
  card.append(ph, bd);

  card.setAttribute(
    'aria-label',
    `Abrir el análisis de ${cuenta}${fecha ? ` del ${fecha.fecha}` : ''}: ${a.pctNeg === null ? 'sin tono' : `${Math.round(a.pctNeg)} % negativo`}, ${anaPlural(a.analizados || 0, 'comentario analizado', 'comentarios analizados')}${a.tieneHecho ? ', con un hecho dominante' : ''}`
  );
  card.addEventListener('click', () => {
    anaUserChose();
    anaSetError('');
    anaHideNotice();
    anaSetView(1);
    anaShowAnalysis(a.id).then(() => {
      // La tarjeta se ocultó con la galería: el foco pasa a la publicación abierta.
      if (anaShown && anaShown.id === a.id) {
        const post = document.getElementById('anaPost');
        post.focus({ preventScroll: true });
      }
      window.scrollTo({ top: 0, behavior: anaReducedMotion() ? 'auto' : 'smooth' });
    });
  });
  return card;
}

anaEls.galQ.addEventListener('input', () => {
  clearTimeout(anaGalTimer);
  anaGalTimer = setTimeout(() => {
    anaGal.q = anaEls.galQ.value.trim().slice(0, 100);
    anaLoadGaleria();
  }, 250);
});
anaEls.galSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  anaGal.f = b.dataset.f;
  anaEls.galSeg.querySelectorAll('button[data-f]').forEach((x) => {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-pressed', String(x === b));
  });
  anaLoadGaleria();
});
anaEls.galOrd.addEventListener('change', () => {
  anaGal.ord = anaEls.galOrd.value;
  anaLoadGaleria();
});

// ---------------------------------------------------------------- un análisis

function anaClearShown() {
  anaShown = null;
  if (typeof anaStopTyping === 'function') anaStopTyping();
  anaShow(anaEls.result, false);
  if (typeof anaCloseTemaForm === 'function') anaCloseTemaForm({ restoreFocus: false });
  anaRenderStrip();
  if (ANA_HASH.test(location.hash)) history.replaceState(null, '', '#tab-analysis');
}

// Los bloques (anaRender) están en analysisBlocks.js, que se carga después:
// nada se dibuja antes de que esté la página entera.
const anaDomListo = new Promise((resolve) => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resolve, { once: true });
  else resolve();
});

async function anaShowAnalysis(id, { updateHash = true } = {}) {
  const seq = ++anaLoadSeq;
  anaEls.result.classList.add('loading');
  try {
    const a = await anaApi(`/api/analisis/${encodeURIComponent(id)}?plataforma=${ANA_PLATAFORMA}`);
    await anaDomListo;
    if (seq !== anaLoadSeq) return;
    if (a.estado !== 'ok' || !a.vista) {
      anaSetError(a.error ? `Ese análisis no terminó: ${a.error}` : 'Ese análisis no terminó.');
      return;
    }
    anaShown = a;
    anaRender(a);
    anaRenderStrip();
    if (updateHash && anaPanelVisible() && anaView === 1) history.replaceState(null, '', `#analisis-${a.id}`);
  } catch (err) {
    if (seq !== anaLoadSeq) return;
    anaSetError(err.status === 404 ? 'Ese análisis no existe.' : err.message);
  } finally {
    if (seq === anaLoadSeq) anaEls.result.classList.remove('loading');
  }
}

/** Vuelve a leer el análisis a la vista (después de editar figuras o temas de un v1), sin moverle nada. */
async function anaReloadShown() {
  if (!anaShown) return null;
  const id = anaShown.id;
  const a = await anaApi(`/api/analisis/${id}?plataforma=${ANA_PLATAFORMA}`);
  if (!anaShown || anaShown.id !== id || a.estado !== 'ok') return null;
  anaShown = a;
  return a;
}

// ---------------------------------------------------------------- arranque

anaEls.btn.addEventListener('click', () => anaAnalyze());
anaEls.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    anaAnalyze();
  }
});
// Otro link en el campo: el aviso de "ya se analizó" era del anterior.
anaEls.url.addEventListener('input', () => {
  if (anaNoticeFor) anaHideNotice();
});
anaEls.noticeView.addEventListener('click', () => {
  const ultimo = anaNoticeFor;
  if (!ultimo) return;
  anaHideNotice();
  if (!ultimo.conservarCampo) anaEls.url.value = '';
  anaUserChose();
  // El botón se oculta con el aviso: el foco pasa al análisis en la tira (o
  // al campo), no a <body>.
  anaEls.url.focus();
  anaSetView(1, { updateHash: false });
  anaShowAnalysis(ultimo.id).then(() => {
    const enLaTira = anaEls.posts.querySelector(`button[data-id="${ultimo.id}"]`);
    if (enLaTira && anaShown && anaShown.id === ultimo.id) enLaTira.focus();
  });
});
anaEls.noticeRun.addEventListener('click', () => {
  anaEls.url.focus();
  anaAnalyze({ force: true });
});

// Al abrir la solapa (main.js, openTab): la primera vez, el más reciente a
// la vista, salvo que haya un link en el campo o ya se esté viendo otro.
// El hash es el de lo que se ve (#analisis-<id>, #analisis-galeria).
window.openAnalysis = function openAnalysis() {
  // Al volver a la solapa (#tab-analysis), el hash pasa a ser el de lo que se
  // ve. Uno que ya nombra un análisis o la galería es un pedido (un link
  // pegado, Atrás): lo atiende anaOpenFromHash, no se pisa con lo anterior.
  const pedido = ANA_HASH.test(location.hash) || location.hash === ANA_HASH_GALERIA;
  if (!pedido && location.hash !== anaHashActual() && (anaShown || anaView === 2)) history.replaceState(null, '', anaHashActual());
  if (anaOpened) return;
  anaOpened = true;
  anaRecientesReady.then(() => {
    if (anaSkipAutoShow || anaShown || anaRunningId !== null || anaView !== 1 || anaEls.url.value.trim()) return;
    if (anaRecientes[0]) anaShowAnalysis(anaRecientes[0].id);
  });
};

function anaOpenFromHash() {
  const galeria = location.hash === ANA_HASH_GALERIA;
  const m = ANA_HASH.exec(location.hash);
  if (!m && !galeria) return false;
  anaUserChose();
  if (typeof openTab === 'function') openTab('analysis', { updateHash: false });
  window.scrollTo(0, 0);
  if (galeria) {
    anaSetView(2, { updateHash: false });
    return true;
  }
  anaSetView(1, { updateHash: false });
  anaShowAnalysis(Number(m[1]), { updateHash: false });
  return true;
}

window.addEventListener('hashchange', anaOpenFromHash);

// Los recientes y, si quedó uno en curso de esta persona (otra pestaña, una
// recarga), se lo sigue: el análisis corre en el servidor. El de otra
// persona no se sigue (le bloquearía "Analizar"). Si entró por
// #analisis-<id>, al terminar no se le cambia la vista.
anaRecientesReady = anaLoadRecientes().then((data) => {
  const propio = ((data && data.enCurso) || []).find((a) => a.propio);
  if (propio && anaRunningId === null) anaFollow(propio.id, { url: propio.url, switchView: !anaSkipAutoShow });
  return data;
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', anaOpenFromHash);
else anaOpenFromHash();
