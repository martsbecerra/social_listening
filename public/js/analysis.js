// --------------------------------------------------------------------
// Análisis de publicación de Instagram (diseño v4, fase E): la solapa de
// design/social-listening-v4.html. Prefijo ana / ANA_ (script clásico,
// ámbito global compartido). Lo carga solo instagram.html, después de
// postView.js (formatCount, accountColor) y temasEditor.js
// (TemasConversacion.assemble); X tiene su propia solapa (x-analysis.js).
//
// - "Analizar" pregunta primero si el link ya se analizó
//   (GET /api/analisis?url=): si hay uno terminado, lo avisa con su fecha
//   y ofrece verlo o analizar de nuevo, antes de gastar; si hay uno en
//   curso, lo sigue. Si no, POST /api/analyze responde el id y el análisis
//   corre en el servidor: la solapa consulta sus pasos cada segundo
//   (GET /api/analyze/progress) y los dibuja con el detalle que manda el
//   trabajo. Ningún número ni frase se inventa acá.
// - Lo que se ve sale entero de la fila guardada (GET /api/analisis/:id):
//   la publicación, el resumen (la lectura estratégica), el tono en
//   cantidades (el ruido aparte; el porcentaje ponderado del informe,
//   rotulado), los temas con su conteo (un clic filtra los comentarios, ✎
//   los edita y se guardan con PATCH), "Cuándo comentaron" (solo si el
//   backend lo armó), los comentarios y compartir (el informe con los temas
//   editados, Copiar, WhatsApp y el CSV de reclamos).
// - #analisis-<id> abre ese análisis (los "Análisis recientes" del
//   inicio). anaPreload(url), desde "Analizar comentarios" del pop-up del
//   Monitoreo, deja el link en el campo sin analizar y saca de la vista el
//   análisis de otra publicación.
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
const ANA_WA_CAP = 4000;
const ANA_CMTS_PAGE = 50;
const ANA_TOP = 5;
const ANA_TZ = 'America/Argentina/Buenos_Aires';
const ANA_SVG = 'http://www.w3.org/2000/svg';
const ANA_HASH = /^#analisis-(\d+)$/;

const anaEls = {
  url: document.getElementById('url'),
  btn: document.getElementById('analyzeBtn'),
  notice: document.getElementById('anaNotice'),
  noticeText: document.getElementById('anaNoticeText'),
  noticeView: document.getElementById('anaNoticeView'),
  noticeRun: document.getElementById('anaNoticeRun'),
  error: document.getElementById('anaError'),
  run: document.getElementById('anaRun'),
  steps: document.getElementById('anaSteps'),
  posts: document.getElementById('anaPosts'),
  empty: document.getElementById('anaEmpty'),
  result: document.getElementById('anaResult'),
  img: document.getElementById('anaImg'),
  av: document.getElementById('anaAv'),
  acc: document.getElementById('anaAcc'),
  date: document.getElementById('anaDate'),
  caption: document.getElementById('anaCaption'),
  likes: document.getElementById('anaLikes'),
  coms: document.getElementById('anaComs'),
  analizados: document.getElementById('anaAnalizados'),
  link: document.getElementById('anaLink'),
  ai: document.getElementById('aiText'),
  waBtn: document.getElementById('waBtn'),
  copyBtn: document.getElementById('copyBtn'),
  waShareBtn: document.getElementById('waShareBtn'),
  csvBtn: document.getElementById('csvBtn'),
  waLen: document.getElementById('waLen'),
  waWarn: document.getElementById('waWarn'),
  waText: document.getElementById('waText'),
  n: document.getElementById('anaN'),
  stack: document.getElementById('anaStack'),
  stackLbl: document.getElementById('anaStackLbl'),
  toneNote: document.getElementById('anaToneNote'),
  themes: document.getElementById('anaThemes'),
  temaForm: document.getElementById('anaTemaForm'),
  temaTitulo: document.getElementById('anaTemaTitulo'),
  temaTexto: document.getElementById('anaTemaTexto'),
  temaMsg: document.getElementById('anaTemaMsg'),
  temaSave: document.getElementById('anaTemaSave'),
  temaDel: document.getElementById('anaTemaDel'),
  temaCancel: document.getElementById('anaTemaCancel'),
  whenCard: document.getElementById('anaWhenCard'),
  whenHint: document.getElementById('anaWhenHint'),
  when: document.getElementById('anaWhen'),
  whenNote: document.getElementById('anaWhenNote'),
  cmtsTitle: document.getElementById('anaCmtsTitle'),
  cmtSeg: document.getElementById('cmtSeg'),
  cmtTema: document.getElementById('anaCmtTema'),
  cmts: document.getElementById('anaCmts'),
  cmtsMore: document.getElementById('anaCmtsMore'),
};

let anaRecientes = [];
let anaRecientesReady = Promise.resolve(null);
let anaShown = null; // el análisis a la vista (GET /api/analisis/:id)
let anaRunningId = null; // el que se está siguiendo
let anaRunningUrl = null; // su link
let anaFollowSwitch = true; // al terminar, ¿se lo muestra? (false si la persona eligió otra cosa)
let anaPollFails = 0; // consultas del progreso seguidas sin respuesta
let anaStepsSig = ''; // los pasos dibujados (para no redibujar lo mismo)
let anaWhenDrawnW = 0; // el ancho al que se dibujó "Cuándo comentaron"
let anaBusy = false; // entre el clic y la respuesta de POST /api/analyze
let anaPollTimer = null;
let anaTypeTimer = null;
let anaRunHideTimer = null;
let anaLoadSeq = 0; // descarta respuestas de un análisis que ya no se pidió
let anaNoticeFor = null; // el análisis ya terminado que avisa anaNotice
let anaOpened = false;
let anaSkipAutoShow = false;
let anaCmtFilter = 'top';
let anaCmtTema = null; // índice del tema que filtra los comentarios
let anaCmtLimit = ANA_CMTS_PAGE;
let anaTemaEditing = null; // índice del tema en edición, o 'nuevo'
let anaCopyTimer = null;

const ANA_DATE = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: ANA_TZ });
const ANA_TIME = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ANA_TZ });
const ANA_SHORT = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'short', timeZone: ANA_TZ });
// AAAA-MM-DD en hora de Argentina (para el nombre del CSV).
const ANA_ISO_DAY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: ANA_TZ });

const ANA_TONES = {
  positivo: { bar: 'bg-pos', text: 'sent-pos', label: 'Positivo' },
  neutral: { bar: 'bg-neu', text: 'sent-neu', label: 'Neutral' },
  negativo: { bar: 'bg-neg', text: 'sent-neg', label: 'Negativo' },
  ruido: { bar: 'bg-none', text: '', label: 'Ruido' },
};
const ANA_SIN_CLASIFICAR = { bar: 'bg-none', text: '', label: 'Sin clasificar' };

function anaReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function anaShow(el, on) {
  el.classList.toggle('hidden', !on);
}

function anaDateParts(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return { fecha: ANA_DATE.format(d), hora: ANA_TIME.format(d), corta: ANA_SHORT.format(d).replace('.', '') };
}

function anaPlural(n, uno, varios) {
  return `${formatCount(n)} ${n === 1 ? uno : varios}`;
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
  try {
    data = await resp.json();
  } catch {
    data = null;
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
  if (view.pasos) anaRenderSteps(view.pasos);
  if (view.estado === 'en curso') {
    anaPollTimer = setTimeout(anaPoll, ANA_POLL_MS);
    return;
  }
  const seguido = { url: anaRunningUrl, mostrar: anaFollowSwitch };
  anaStopFollow();
  if (!view.pasos && view.estado !== 'ok') anaFailRunningSteps();
  if (view.estado === 'ok') {
    // El campo se vacía solo si sigue con el link de este análisis (o
    // vacío): un link que la persona puso mientras tanto se queda.
    const campo = anaEls.url.value.trim();
    const mismoLink = !campo || (seguido.url && anaPostCode(campo) === anaPostCode(seguido.url));
    if (mismoLink && campo) anaEls.url.value = '';
    anaSkipAutoShow = true;
    await anaLoadRecientes();
    if (mismoLink && seguido.mostrar) await anaShowAnalysis(id);
    else anaShowDoneNotice(id);
    anaRunHideTimer = setTimeout(() => anaEls.run.classList.remove('on'), anaReducedMotion() ? 0 : 1200);
  } else {
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
  anaEls.url.value = url || '';
  anaSetError('');
  anaHideNotice();
  if (anaShown && anaPostCode(anaShown.url) !== anaPostCode(url)) anaClearShown();
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
    const data = await anaApi(`/api/analisis?plataforma=${ANA_PLATAFORMA}&limit=12`);
    anaRecientes = data.recientes || [];
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
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = 'Recientes';
  strip.append(lbl);
  for (const a of anaRecientes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = String(a.id);
    const on = Boolean(anaShown && anaShown.id === a.id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    const fecha = anaDateParts(a.postedAt || a.finishedAt);
    const cuenta = a.cuenta ? `@${a.cuenta}` : 'Publicación';
    b.setAttribute('aria-label', `Análisis de ${cuenta}${fecha ? ` del ${fecha.fecha}` : ''}`);
    b.dataset.tipTitle = `${cuenta}${fecha ? ` · ${fecha.fecha}` : ''}`;
    const caption = (a.caption || '').replace(/\s+/g, ' ').trim();
    const lineas = [caption.length > 70 ? `${caption.slice(0, 70)}…` : caption];
    if (Number.isFinite(a.analizados)) lineas.push(anaPlural(a.analizados, 'comentario analizado', 'comentarios analizados'));
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
    const small = document.createElement('small');
    small.textContent = fecha ? fecha.corta : '—';
    b.append(small);
    b.addEventListener('click', () => {
      anaUserChose();
      anaHideNotice();
      anaSetError('');
      anaShowAnalysis(a.id);
    });
    strip.append(b);
  }
  if (conFoco) {
    const mismo = strip.querySelector(`button[data-id="${conFoco}"]`) || strip.querySelector('button');
    if (mismo) mismo.focus();
  }
}

// ---------------------------------------------------------------- un análisis

function anaClearShown() {
  anaShown = null;
  clearInterval(anaTypeTimer);
  anaShow(anaEls.result, false);
  anaCloseTemaForm({ restoreFocus: false });
  anaRenderStrip();
  if (ANA_HASH.test(location.hash)) history.replaceState(null, '', '#tab-analysis');
}

async function anaShowAnalysis(id, { updateHash = true } = {}) {
  const seq = ++anaLoadSeq;
  anaEls.result.classList.add('loading');
  try {
    const a = await anaApi(`/api/analisis/${encodeURIComponent(id)}?plataforma=${ANA_PLATAFORMA}`);
    if (seq !== anaLoadSeq) return;
    if (a.estado !== 'ok') {
      anaSetError(a.error ? `Ese análisis no terminó: ${a.error}` : 'Ese análisis no terminó.');
      return;
    }
    anaShown = a;
    anaRender(a);
    const panelVisible = !document.getElementById('tab-analysis').classList.contains('hidden');
    if (updateHash && panelVisible) history.replaceState(null, '', `#analisis-${a.id}`);
  } catch (err) {
    if (seq !== anaLoadSeq) return;
    anaSetError(err.status === 404 ? 'Ese análisis no existe.' : err.message);
  } finally {
    if (seq === anaLoadSeq) anaEls.result.classList.remove('loading');
  }
}

function anaRender(a) {
  anaShow(anaEls.result, true);
  anaShow(anaEls.empty, false);
  anaCloseTemaForm({ restoreFocus: false });
  anaCmtFilter = 'top';
  anaCmtTema = null;
  anaCmtLimit = ANA_CMTS_PAGE;
  anaShow(anaEls.waText, false);
  anaEls.waBtn.setAttribute('aria-expanded', 'false');
  anaRenderPost(a);
  anaRenderAi(a);
  anaRenderTone(a);
  anaRenderThemes();
  anaRenderWhen();
  anaRenderSeg();
  anaRenderCmts();
  anaRenderShare();
  anaRenderStrip();
}

function anaRenderPost(a) {
  // La foto (la del Monitoreo o la copia del análisis), entera sobre negro.
  anaEls.img.style.setProperty('--a', accountColor(a.cuenta));
  const placa = (texto) => {
    anaEls.img.classList.add('none');
    const span = document.createElement('span');
    span.textContent = texto;
    anaEls.img.replaceChildren(span);
  };
  anaEls.img.classList.remove('none');
  anaEls.img.replaceChildren();
  if (a.imagen && a.imagen.fullUrl) {
    const img = document.createElement('img');
    img.alt = a.cuenta ? `Foto de la publicación de @${a.cuenta}` : 'Foto de la publicación';
    img.src = a.imagen.fullUrl;
    img.addEventListener('error', () => placa('Imagen no disponible'));
    anaEls.img.append(img);
  } else {
    placa(a.imagenEstado === 'vencido' || a.imagenEstado === 'error' ? 'Imagen no disponible' : 'Sin foto');
  }

  anaEls.av.style.background = accountColor(a.cuenta);
  anaEls.av.textContent = (a.cuenta || '?').charAt(0).toUpperCase();
  anaEls.acc.textContent = a.cuenta ? `@${a.cuenta}` : 'Cuenta sin dato';
  const fecha = anaDateParts(a.postedAt);
  anaEls.date.textContent = fecha ? `${fecha.fecha} · ${fecha.hora}` : 'fecha sin dato';
  anaEls.caption.textContent = a.caption || 'Sin texto.';
  anaEls.likes.textContent = a.likes === null ? '♥ ocultos' : `♥ ${formatCount(a.likes)}`;
  anaEls.likes.title = a.likes === null ? 'La cuenta ocultó los me gusta' : 'Me gusta';
  anaEls.coms.textContent = `💬 ${formatCount(a.comentariosTotal)}`;
  anaEls.coms.title = 'Comentarios que informa Instagram';
  anaEls.analizados.textContent = anaAnalizadosText(a);
  anaEls.link.href = a.url;
}

// "analizados N de M": N, los que el modelo clasificó de verdad; M, el total
// que informa Instagram. Si Instagram no lo informó, "de M traídos" (lo que
// trajo Apify, que no es el total de la publicación).
function anaAnalizadosText(a) {
  if (Number.isFinite(a.comentariosTotal) && a.analizados < a.comentariosTotal) {
    return `analizados ${formatCount(a.analizados)} de ${formatCount(a.comentariosTotal)}`;
  }
  if (!Number.isFinite(a.comentariosTotal) && Number.isFinite(a.traidos) && a.analizados < a.traidos) {
    return `analizados ${formatCount(a.analizados)} de ${formatCount(a.traidos)} traídos`;
  }
  return `analizados ${formatCount(a.analizados)}`;
}

function anaRenderAi(a) {
  clearInterval(anaTypeTimer);
  const r = a.resultado || {};
  const texto = [r.lecturaEstrategica, r.posteoSobre].find((t) => t && t !== 'N/D') || 'Sin resumen.';
  const p = anaEls.ai;
  // El texto entero para un lector de pantalla; el que se escribe, oculto.
  const completo = document.createElement('span');
  completo.className = 'sr';
  completo.textContent = texto;
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

function anaRenderTone(a) {
  const t = a.tonos || {};
  const pos = t.positivos || 0;
  const neu = t.neutrales || 0;
  const neg = t.negativos || 0;
  const base = pos + neu + neg;
  const pct = (n) => (base ? Math.round((n / base) * 100) : 0);
  anaEls.n.textContent = anaAnalizadosText(a);
  const bars = anaEls.stack.querySelectorAll('i');
  bars.forEach((b) => (b.style.width = '0'));
  const widths = [pos, neu, neg].map((n) => (base ? (n / base) * 100 : 0));
  setTimeout(() => bars.forEach((b, i) => (b.style.width = `${widths[i]}%`)), anaReducedMotion() ? 0 : 60);

  anaEls.stackLbl.replaceChildren(
    ...[
      ['sent-pos', pos, 'positivo'],
      ['sent-neu', neu, 'neutral'],
      ['sent-neg', neg, 'negativo'],
    ].map(([cls, n, label]) => {
      const span = document.createElement('span');
      span.className = cls;
      const b = document.createElement('b');
      b.textContent = `${pct(n)} %`;
      span.append(b, ` ${label} · ${formatCount(n)}`);
      return span;
    })
  );

  const partes = [];
  if (t.ruido > 0) partes.push(`${anaPlural(t.ruido, 'comentario', 'comentarios')} de ruido (bots, spam o repetidos), aparte.`);
  const sinClasificar = Number.isFinite(a.enviados) ? a.enviados - a.analizados : 0;
  if (sinClasificar > 0) partes.push(`${anaPlural(sinClasificar, 'comentario quedó', 'comentarios quedaron')} sin clasificar.`);
  if (Number.isFinite(a.positivoPct) && Number.isFinite(a.negativoPct)) {
    partes.push(`En el informe: ${a.positivoPct} % positivo · ${a.negativoPct} % negativo, ponderado por tipo de cuenta.`);
  }
  anaEls.toneNote.textContent = partes.join(' ');
}

// ---------------------------------------------------------------- temas

function anaTemas() {
  return (anaShown && Array.isArray(anaShown.temas) ? anaShown.temas : []).map((t) => ({
    titulo: t.titulo || '',
    texto: t.texto || '',
    comentarios: Array.isArray(t.comentarios) ? t.comentarios : [],
  }));
}

function anaRenderThemes() {
  const temas = anaTemas();
  const box = anaEls.themes;
  box.replaceChildren();
  const max = Math.max(1, ...temas.map((t) => t.comentarios.length));
  temas.forEach((t, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'theme';
    if (i === 0) wrap.classList.add('first');
    if (anaCmtTema === i) wrap.classList.add('on');
    wrap.style.animationDelay = `${i * 70}ms`;
    wrap.style.fontSize = `${12 + 8 * (t.comentarios.length / max)}px`;
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'theme-name';
    name.dataset.i = String(i);
    name.setAttribute('aria-pressed', String(anaCmtTema === i));
    name.dataset.tipTitle = t.titulo;
    name.dataset.tip = `${anaPlural(t.comentarios.length, 'comentario', 'comentarios')} de los analizados · clic para verlos`;
    name.append(t.titulo);
    const count = document.createElement('small');
    count.textContent = formatCount(t.comentarios.length);
    name.append(count);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'theme-edit';
    edit.dataset.edit = String(i);
    edit.setAttribute('aria-label', `Editar el tema «${t.titulo}»`);
    edit.dataset.tip = 'Cambiar el nombre o el texto, o quitarlo';
    edit.textContent = '✎';
    wrap.append(name, edit);
    box.append(wrap);
  });
  if (temas.length === 0) {
    const nada = document.createElement('span');
    nada.className = 'note';
    nada.textContent = 'El modelo no encontró temas que se repitan.';
    box.append(nada);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'theme add';
  add.id = 'anaTemaAdd';
  add.textContent = '+ tema';
  const lleno = temas.length >= window.TemasConversacion.MAX;
  add.disabled = lleno;
  add.dataset.tipTitle = 'Agregar un tema';
  add.dataset.tip = lleno ? `Ya hay ${window.TemasConversacion.MAX}, el máximo.` : 'Se guarda con el análisis y entra en el informe';
  box.append(add);
}

function anaOpenTemaForm(index) {
  const temas = anaTemas();
  anaTemaEditing = index;
  const tema = index === 'nuevo' ? { titulo: '', texto: '' } : temas[index];
  anaEls.temaTitulo.value = tema.titulo;
  anaEls.temaTexto.value = tema.texto;
  anaEls.temaMsg.textContent = 'Sin texto, el tema no entra en el informe.';
  anaShow(anaEls.temaDel, index !== 'nuevo');
  anaShow(anaEls.temaForm, true);
  anaEls.temaTitulo.focus();
}

function anaCloseTemaForm({ restoreFocus = true } = {}) {
  const editing = anaTemaEditing;
  anaTemaEditing = null;
  anaShow(anaEls.temaForm, false);
  if (!restoreFocus || editing === null) return;
  const target =
    (editing !== 'nuevo' && anaEls.themes.querySelector(`[data-edit="${editing}"]`)) || document.getElementById('anaTemaAdd');
  if (target) target.focus();
}

// cmtTema: el índice del tema que filtra los comentarios después de
// guardar (al quitar uno se corre); se aplica recién si el PATCH salió bien.
async function anaSaveTemas(temas, { focusAfter, cmtTema } = {}) {
  const a = anaShown;
  const botones = [anaEls.temaSave, anaEls.temaDel, anaEls.temaCancel];
  botones.forEach((b) => (b.disabled = true));
  try {
    const data = await anaApi(`/api/analisis/${a.id}/temas?plataforma=${ANA_PLATAFORMA}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temas }),
    });
    if (anaShown !== a) return;
    a.temas = data.temas;
    anaTemaEditing = null;
    anaShow(anaEls.temaForm, false);
    if (cmtTema !== undefined) anaCmtTema = cmtTema;
    if (anaCmtTema !== null && anaCmtTema >= a.temas.length) anaCmtTema = null;
    anaRenderThemes();
    anaRenderCmts();
    anaRenderShare();
    const target = focusAfter === 'add' ? null : anaEls.themes.querySelector(`[data-edit="${focusAfter}"]`);
    (target || document.getElementById('anaTemaAdd')).focus();
  } catch (err) {
    anaEls.temaMsg.textContent = err.message;
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

anaEls.themes.addEventListener('click', (e) => {
  if (!anaShown) return;
  const name = e.target.closest('.theme-name');
  if (name) {
    const i = Number(name.dataset.i);
    anaCmtTema = anaCmtTema === i ? null : i;
    if (anaCmtTema !== null) anaCmtFilter = 'all';
    anaCmtLimit = ANA_CMTS_PAGE;
    anaRenderThemes();
    anaRenderSeg();
    anaRenderCmts();
    if (anaCmtTema !== null) anaEls.cmtsTitle.focus();
    else anaEls.themes.querySelector(`[data-i="${i}"]`).focus();
    return;
  }
  const edit = e.target.closest('.theme-edit');
  if (edit) {
    anaOpenTemaForm(Number(edit.dataset.edit));
    return;
  }
  if (e.target.closest('#anaTemaAdd')) anaOpenTemaForm('nuevo');
});

anaEls.temaForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!anaShown || anaTemaEditing === null) return;
  const titulo = anaEls.temaTitulo.value.trim();
  const texto = anaEls.temaTexto.value.trim();
  if (!titulo) {
    anaEls.temaMsg.textContent = 'Poné un título.';
    anaEls.temaTitulo.focus();
    return;
  }
  const temas = anaTemas();
  let focusAfter;
  if (anaTemaEditing === 'nuevo') {
    temas.push({ titulo, texto, comentarios: [] });
    focusAfter = temas.length - 1;
  } else {
    temas[anaTemaEditing] = { ...temas[anaTemaEditing], titulo, texto };
    focusAfter = anaTemaEditing;
  }
  anaSaveTemas(temas, { focusAfter });
});

anaEls.temaDel.addEventListener('click', () => {
  if (!anaShown || typeof anaTemaEditing !== 'number') return;
  const temas = anaTemas();
  temas.splice(anaTemaEditing, 1);
  let cmtTema = anaCmtTema;
  if (cmtTema === anaTemaEditing) cmtTema = null;
  else if (cmtTema !== null && cmtTema > anaTemaEditing) cmtTema -= 1;
  anaSaveTemas(temas, { focusAfter: 'add', cmtTema });
});

anaEls.temaCancel.addEventListener('click', () => anaCloseTemaForm());
anaEls.temaForm.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    anaCloseTemaForm();
  }
});

// ---------------------------------------------------------------- cuándo comentaron

function anaHourLabel(h) {
  if (h === 0) return 'publicación';
  if (h >= 48 && h % 24 === 0) return `+${h / 24} d`;
  return `+${h} h`;
}

// El tramo del pico, para leer: "en la primera hora", "a las +5 h"…
function anaPeakLabel(h, unidadHoras) {
  if (h === 0) return unidadHoras === 24 ? 'el primer día' : unidadHoras === 6 ? 'las primeras 6 h' : 'la primera hora';
  return anaHourLabel(h);
}

function anaSvg(tag, attrs = {}) {
  const el = document.createElementNS(ANA_SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function anaRenderWhen() {
  const c = anaShown && anaShown.cuando;
  const hay = Boolean(c && Array.isArray(c.tramos) && c.tramos.length);
  anaShow(anaEls.whenCard, hay);
  if (!hay) return;
  const unidad = { 1: 'por hora', 6: 'cada 6 horas', 24: 'por día' }[c.unidadHoras] || 'por tramo';
  anaEls.whenHint.textContent = `comentarios ${unidad} desde la publicación`;
  anaEls.whenNote.textContent = `${formatCount(c.conFecha)} de ${formatCount(c.total)} comentarios traídos tienen fecha.`;

  // Al ancho real de la tarjeta: el texto no se estira. Con la solapa
  // oculta no hay ancho: se dibuja cuando aparece (el ResizeObserver).
  const visible = Math.round(anaEls.when.clientWidth);
  if (!visible) {
    anaWhenDrawnW = 0;
    anaEls.when.replaceChildren();
    return;
  }
  const W = Math.max(280, visible);
  anaWhenDrawnW = visible;
  const H = 190;
  const L = 30;
  const R = 12;
  const T = 26;
  const B = 24;
  const data = c.tramos.map((t) => t.n);
  const n = data.length;
  const mx = Math.max(1, ...data) * 1.12;
  const x = (i) => (n === 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const y = (v) => H - B - (v / mx) * (H - T - B);
  const pico = c.pico || { indice: 0, h: 0, n: data[0] };

  const svg = anaSvg('svg', { class: 'tl', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  svg.setAttribute(
    'aria-label',
    `Comentarios ${unidad} desde la publicación. Pico: ${anaPeakLabel(pico.h, c.unidadHoras)}, ${anaPlural(pico.n, 'comentario', 'comentarios')}.`
  );
  const defs = anaSvg('defs');
  const grad = anaSvg('linearGradient', { id: 'anaTlGrad', x1: 0, x2: 0, y1: 0, y2: 1 });
  grad.append(
    anaSvg('stop', { offset: 0, 'stop-color': 'var(--accent)', 'stop-opacity': 0.45 }),
    anaSvg('stop', { offset: 1, 'stop-color': 'var(--accent)', 'stop-opacity': 0 })
  );
  defs.append(grad);
  svg.append(defs);

  for (const k of [0, 0.5, 1]) {
    const gy = H - B - k * (H - T - B);
    svg.append(anaSvg('line', { x1: L, x2: W - R, y1: gy, y2: gy, class: 'tl-grid' }));
    const label = anaSvg('text', { x: L - 4, y: gy + 3, 'text-anchor': 'end', class: 'tl-txt' });
    label.textContent = formatCount(Math.round((mx * k) / 1.12));
    svg.append(label);
  }

  const line = `M${data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}`;
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

  const px = x(pico.indice);
  const marca = anaSvg('g', { class: 'tl-peak' });
  marca.append(anaSvg('line', { x1: px, x2: px, y1: T - 6, y2: H - B }));
  marca.append(anaSvg('circle', { cx: px, cy: y(data[pico.indice]), r: 4 }));
  const cerca = px > W - 170;
  const txt = anaSvg('text', { x: cerca ? px - 6 : px + 6, y: T - 10, 'text-anchor': cerca ? 'end' : 'start', class: 'tl-peak-txt' });
  txt.textContent = `pico: ${anaPeakLabel(pico.h, c.unidadHoras)} · ${anaPlural(pico.n, 'comentario', 'comentarios')}`;
  marca.append(txt);
  svg.append(marca);
  const acomodarPico = () => {
    // El rótulo entero adentro del gráfico (en celular puede medir casi todo el ancho).
    try {
      const largo = txt.getComputedTextLength();
      const x0 = Math.min(Math.max(cerca ? px - 6 - largo : px + 6, L), Math.max(L, W - R - largo));
      txt.setAttribute('text-anchor', 'start');
      txt.setAttribute('x', x0.toFixed(1));
    } catch {
      /* sin medida, queda donde estaba */
    }
  };

  // Una franja por tramo con su número (tip.js).
  const ancho = n === 1 ? W - L - R : (W - L - R) / (n - 1);
  data.forEach((v, i) => {
    const x0 = Math.max(L, x(i) - ancho / 2);
    const x1 = Math.min(W - R, x(i) + ancho / 2);
    const r = anaSvg('rect', { x: x0, y: T, width: Math.max(1, x1 - x0), height: H - T - B, class: 'tl-hit' });
    r.dataset.tipTitle = c.unidadHoras === 1 && c.tramos[i].h === 0 ? 'Primera hora' : anaHourLabel(c.tramos[i].h);
    r.dataset.tip = anaPlural(v, 'comentario', 'comentarios');
    svg.append(r);
  });
  anaEls.when.replaceChildren(svg);
  acomodarPico();
}

// Se redibuja cuando el ancho cambia respecto del que se usó al dibujar
// (también al volver a la solapa si se armó con ella oculta).
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    const w = Math.round(anaEls.when.clientWidth);
    if (!anaShown || !w || w === anaWhenDrawnW) return;
    anaRenderWhen();
  }).observe(anaEls.when);
}

// ---------------------------------------------------------------- comentarios

function anaRenderSeg() {
  anaEls.cmtSeg.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.f === anaCmtFilter;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function anaFilteredCmts() {
  let list = (anaShown && anaShown.comentarios) || [];
  const temas = anaTemas();
  if (anaCmtTema !== null && temas[anaCmtTema]) {
    const set = new Set(temas[anaCmtTema].comentarios);
    list = list.filter((c) => set.has(c.n));
  }
  if (anaCmtFilter === 'top') {
    return [...list].sort((p, q) => (q.likes ?? -1) - (p.likes ?? -1) || p.n - q.n).slice(0, ANA_TOP);
  }
  if (anaCmtFilter !== 'all') list = list.filter((c) => c.tono === anaCmtFilter);
  return list;
}

function anaSinceLabel(fecha) {
  const desde = anaShown && anaShown.postedAt ? Date.parse(anaShown.postedAt) : NaN;
  const ms = fecha ? Date.parse(fecha) : NaN;
  if (!Number.isFinite(desde) || !Number.isFinite(ms)) return '';
  const h = Math.max(0, Math.floor((ms - desde) / 3600e3));
  return h >= 48 ? `+${Math.floor(h / 24)} d` : `+${h} h`;
}

function anaBuildCmt(c, i) {
  const tono = ANA_TONES[c.tono] || ANA_SIN_CLASIFICAR;
  const row = document.createElement('div');
  row.className = 'cmt';
  if (i < 8) row.style.animationDelay = `${i * 60}ms`;
  const bar = document.createElement('i');
  bar.className = tono.bar;
  bar.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div');
  const w = document.createElement('div');
  w.className = 'w';
  const user = document.createElement('b');
  user.textContent = `@${c.usuario}`;
  w.append(user);
  if (c.verificada) {
    const v = document.createElement('span');
    v.textContent = '✓ verificada';
    w.append(v);
  }
  const likes = document.createElement('span');
  likes.textContent = `♥ ${formatCount(c.likes)}`;
  const t = document.createElement('span');
  if (tono.text) t.className = tono.text;
  t.textContent = tono.label;
  w.append(likes, t);
  const since = anaSinceLabel(c.fecha);
  if (since) {
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = since;
    w.append(tm);
  }
  const texto = document.createElement('p');
  texto.textContent = c.texto;
  body.append(w, texto);
  row.append(bar, body);
  return row;
}

function anaRenderCmts() {
  const temas = anaTemas();
  // La pastilla del tema que filtra, con su ✕.
  const tema = anaCmtTema !== null ? temas[anaCmtTema] : null;
  anaEls.cmtTema.replaceChildren();
  anaShow(anaEls.cmtTema, Boolean(tema));
  if (tema) {
    const chip = document.createElement('span');
    chip.className = 'chip on';
    chip.append(`Tema «${tema.titulo}» · ${anaPlural(tema.comentarios.length, 'comentario', 'comentarios')}`);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.setAttribute('aria-label', `Sacar el filtro del tema «${tema.titulo}»`);
    x.textContent = '✕';
    x.addEventListener('click', () => {
      anaCmtTema = null;
      anaCmtLimit = ANA_CMTS_PAGE;
      anaRenderThemes();
      anaRenderCmts();
      anaEls.cmtsTitle.focus();
    });
    chip.append(x);
    anaEls.cmtTema.append(chip);
  }

  const list = anaFilteredCmts();
  const visibles = anaCmtFilter === 'top' ? list : list.slice(0, anaCmtLimit);
  if (visibles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tema ? 'Ningún comentario de este tema con ese tono.' : 'No hay comentarios con ese tono.';
    anaEls.cmts.replaceChildren(empty);
  } else {
    anaEls.cmts.replaceChildren(...visibles.map(anaBuildCmt));
  }
  const resto = anaCmtFilter === 'top' ? 0 : list.length - visibles.length;
  anaShow(anaEls.cmtsMore, resto > 0);
  if (resto > 0) anaEls.cmtsMore.textContent = `Ver ${formatCount(Math.min(ANA_CMTS_PAGE, resto))} más · quedan ${formatCount(resto)}`;
}

anaEls.cmtSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b || !anaShown) return;
  anaCmtFilter = b.dataset.f;
  anaCmtLimit = ANA_CMTS_PAGE;
  anaRenderSeg();
  anaRenderCmts();
});

anaEls.cmtsMore.addEventListener('click', () => {
  const primera = anaCmtLimit;
  anaCmtLimit += ANA_CMTS_PAGE;
  anaRenderCmts();
  // El foco pasa al primero de los nuevos (si el botón se va, se perdería).
  const nuevo = anaEls.cmts.children[primera];
  if (nuevo) {
    nuevo.tabIndex = -1;
    nuevo.focus();
  }
});

// ---------------------------------------------------------------- compartir

function anaReportText() {
  if (!anaShown) return '';
  return window.TemasConversacion.assemble(anaShown.reporteAntes, anaTemas(), anaShown.reporteDespues);
}

function anaRenderShare() {
  const text = anaReportText();
  anaEls.waLen.textContent = `${formatCount(text.length)} caracteres`;
  const largo = text.length > ANA_WA_CAP;
  anaEls.waWarn.textContent = largo
    ? `Pasa los ${formatCount(ANA_WA_CAP)} caracteres: "Enviar por WhatsApp" lo corta ahí. Para mandarlo entero, usá "Copiar".`
    : '';
  anaShow(anaEls.waWarn, largo);
  if (!anaEls.waText.classList.contains('hidden')) anaEls.waText.textContent = text;
  const conReclamos = Boolean(anaShown && anaShown.reclamos > 0 && anaShown.csv);
  anaEls.csvBtn.disabled = !conReclamos;
  anaEls.csvBtn.dataset.tip = conReclamos
    ? `${anaPlural(anaShown.reclamos, 'reclamo', 'reclamos')} con ubicación`
    : 'Este análisis no encontró reclamos con ubicación.';
}

anaEls.waBtn.addEventListener('click', () => {
  const abrir = anaEls.waText.classList.contains('hidden');
  if (abrir) anaEls.waText.textContent = anaReportText();
  anaShow(anaEls.waText, abrir);
  anaEls.waBtn.setAttribute('aria-expanded', String(abrir));
});

anaEls.copyBtn.addEventListener('click', async () => {
  clearTimeout(anaCopyTimer);
  try {
    await navigator.clipboard.writeText(anaReportText());
    anaEls.copyBtn.textContent = '¡Copiado!';
  } catch {
    anaEls.copyBtn.textContent = 'No se pudo copiar';
  }
  anaCopyTimer = setTimeout(() => (anaEls.copyBtn.textContent = 'Copiar'), 1500);
});

// WhatsApp Desktop/móvil con el esquema nativo. api.whatsapp.com/send sin
// teléfono muestra "Enlace incorrecto"; wa.me rompe los emojis al redirigir.
anaEls.waShareBtn.addEventListener('click', () => {
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

// El CSV de reclamos, con la fecha del análisis en hora de Argentina.
anaEls.csvBtn.addEventListener('click', () => {
  if (!anaShown || !anaShown.csv) return;
  // El BOM hace que Excel en Windows abra bien los acentos y la "ñ".
  const blob = new Blob(['﻿' + anaShown.csv], { type: 'text/csv;charset=utf-8;' });
  const href = URL.createObjectURL(blob);
  const d = new Date(anaShown.finishedAt || Date.now());
  const fecha = ANA_ISO_DAY.format(Number.isNaN(d.getTime()) ? new Date() : d);
  const cuenta = String(anaShown.cuenta || 'publicacion').replace(/[^A-Za-z0-9._-]/g, '-');
  const a = document.createElement('a');
  a.href = href;
  a.download = `reclamos-${cuenta}-${fecha}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
});

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
// Con un análisis a la vista, el hash es el suyo.
window.openAnalysis = function openAnalysis() {
  if (anaShown && !ANA_HASH.test(location.hash)) history.replaceState(null, '', `#analisis-${anaShown.id}`);
  if (anaOpened) return;
  anaOpened = true;
  anaRecientesReady.then(() => {
    if (anaSkipAutoShow || anaShown || anaRunningId !== null || anaEls.url.value.trim()) return;
    if (anaRecientes[0]) anaShowAnalysis(anaRecientes[0].id);
  });
};

function anaOpenFromHash() {
  const m = ANA_HASH.exec(location.hash);
  if (!m) return false;
  anaUserChose();
  if (typeof openTab === 'function') openTab('analysis', { updateHash: false });
  window.scrollTo(0, 0);
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
