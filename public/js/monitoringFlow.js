// --------------------------------------------------------------------
// Flujo en vivo del Monitoreo de Instagram (diseño v4, la columna del
// centro): una línea por publicación del período, la más nueva arriba por
// fecha de detección (detected_at), tantas como entran en el alto de la
// tarjeta (que nunca crece). Cada línea: la foto chiquita, "@cuenta ·
// título" con el término de búsqueda resaltado, el punto del tono, el tema,
// el medidor de alcance y "hace N min". Al terminar "Actualizar ahora" las
// publicaciones nuevas entran arriba de a una, con "ahora"; con el mouse
// encima, esperan a que salga. Un clic abre el pop-up y deja recorrer el
// flujo con ← →. Estilos: .flowcard / .fl en public/css/styles.css.
//
// Lo carga SOLO instagram.html, después de monitoring.js, monitoringFeed.js
// y monitoringFeedPopup.js (prefijo flow). Todo dato entra por textContent.
// --------------------------------------------------------------------
const flowEl = document.getElementById('flow');
const flowRateEl = document.getElementById('flowRate');
const flowReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const FLOW_RATE = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const FLOW_TONES = {
  positivo: ['bg-pos', 'Positivo'],
  neutral: ['bg-neu', 'Neutral'],
  negativo: ['bg-neg', 'Negativo'],
};
// Entre una publicación nueva y la siguiente, al entrar.
const FLOW_STEP_MS = 900;
// Alto de una línea más el espacio entre líneas (.fl en styles.css): para
// saber cuántas armar antes de medir.
const FLOW_ROW_PX = 50;

// Con el mouse encima el flujo no se mueve: lo nuevo espera en la cola.
let flowPaused = false;
const flowQueue = [];
let flowQueueTimer = null;
// Hay una corrida en curso: los datos nuevos que lleguen antes de que
// termine se dibujan al final, para hacer entrar las publicaciones nuevas.
let flowRunning = false;
// Las que entraron en vivo en esta visita: dicen "ahora" en lugar de "hace".
const flowLiveIds = new Set();
let flowLastKey = null;
let flowLastHeight = 0;

// Dónde está el término dentro del texto, sin mirar mayúsculas ni acentos:
// [inicio, fin) en el texto original, o null.
function flowFindTerm(text, term) {
  const needle = normalizeSearch(term).trim();
  if (!needle || !text) return null;
  let folded = '';
  const origin = [];
  for (let i = 0; i < text.length; i++) {
    const piece = normalizeSearch(text[i]);
    for (let k = 0; k < piece.length; k++) {
      folded += piece[k];
      origin.push(i);
    }
  }
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  return [origin[at], origin[at + needle.length - 1] + 1];
}

// "@cuenta · título", con el término de la búsqueda que lo trajo en <mark>
// (armado con nodos de texto, nunca como HTML).
function flowTitleLine(post) {
  const line = document.createElement('span');
  line.className = 'l1';
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'N/D';
  const name = document.createElement('b');
  name.textContent = account;
  const title = post.title || '(sin clasificar)';
  const reason = postReasonParts(post.matched_reason);
  const hit = reason.text === 'búsqueda' ? flowFindTerm(title, reason.term) : null;
  line.append(name, ' · ');
  if (hit) {
    const mark = document.createElement('mark');
    mark.textContent = title.slice(hit[0], hit[1]);
    line.append(title.slice(0, hit[0]), mark, title.slice(hit[1]));
  } else {
    line.append(title);
  }
  line.title = `${account} · ${title}`;
  return line;
}

function flowThumb(post) {
  const th = document.createElement('span');
  th.className = 'th';
  th.setAttribute('aria-hidden', 'true');
  const account = post.account && post.account !== 'N/D' ? post.account : '';
  th.textContent = account ? account[0].toUpperCase() : '?';
  const url = feedImageUrl(post);
  if (url) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => img.remove());
    img.src = url;
    th.appendChild(img);
  }
  return th;
}

function flowLine(post, { live = false } = {}) {
  const el = document.createElement('div');
  el.className = 'fl';
  el.dataset.id = post.id;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'cuenta sin identificar';
  el.setAttribute('aria-label', `Publicación de ${account}: abrir el detalle`);

  const body = document.createElement('span');
  body.className = 'body';
  body.appendChild(flowTitleLine(post));

  const [toneClass, toneName] = FLOW_TONES[post.sentiment] || ['', 'Sin clasificar'];
  const tone = document.createElement('span');
  tone.className = 'lbl';
  tone.dataset.tip = toneName;
  const dot = document.createElement('i');
  if (toneClass) dot.className = toneClass;
  tone.appendChild(dot);

  const when = document.createElement('span');
  when.className = live ? 't now' : 't';
  when.textContent = live ? 'ahora' : feedAgo(post.detected_at);
  const { date, time } = formatFullDateTime(post.posted_at);
  when.title = `Publicada el ${time ? `${date} · ${time}` : date}`;

  el.append(flowThumb(post), body, tone);
  const tema = buildTemaTag(post.tema);
  el.appendChild(tema || document.createElement('span'));
  el.append(buildReachMeter(postReach(post)), when);
  if (live) flowLiveIds.add(String(post.id));
  return el;
}

// Las publicaciones del período, la última detectada primero (a igual
// detección, la última publicada).
function flowPosts() {
  if (!monitoringTable) return [];
  const from = monitorPeriodStart();
  return monitoringTable
    .getData()
    .filter((post) => postInPeriod(post, from))
    .sort((a, b) => String(b.detected_at || '').localeCompare(String(a.detected_at || '')) || String(b.posted_at || '').localeCompare(String(a.posted_at || '')));
}

// Saca las líneas que no entran. Al hacer lugar para una nueva, la de abajo
// se va con su animación; al dibujar todo, directo.
function flowTrim({ animate = false } = {}) {
  const height = flowEl.clientHeight;
  if (!height) return;
  let used = 0;
  for (const line of [...flowEl.children]) {
    if (line.classList.contains('out')) continue;
    used += line.offsetHeight + 8;
    if (used <= height + 4) continue;
    if (animate && !flowReducedMotion.matches) {
      line.classList.add('out');
      setTimeout(() => line.remove(), 380);
    } else {
      line.remove();
    }
  }
}

// "N,N publicaciones/hora": las del período sobre las horas que van del
// período.
function flowRenderRate(count) {
  if (!flowRateEl) return;
  const from = monitorPeriodStart();
  const hours = from === null ? 0 : (Date.now() - from) / 3600e3;
  flowRateEl.textContent = hours > 0 ? FLOW_RATE.format(count / hours) : '—';
}

// Dibuja el flujo entero (sin las de "skip", que van a entrar de a una).
// Las que siguen en la cola tampoco: si no, al salir el mouse entrarían de
// nuevo y quedarían repetidas.
function flowRender({ animate = true, skip = null } = {}) {
  if (!flowEl || !monitoringTable) return;
  const height = flowEl.clientHeight;
  flowLastHeight = height;
  const posts = flowPosts();
  flowRenderRate(posts.length);
  if (!height) return; // solapa oculta: se dibuja al verse (ResizeObserver)
  if (flowQueue.length) {
    skip = new Set(skip || []);
    for (const post of flowQueue) skip.add(String(post.id));
  }
  const shown = skip ? posts.filter((post) => !skip.has(String(post.id))) : posts;
  if (!shown.length && !(skip && skip.size)) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.appendChild(buildEmptyListLine({ filtered: false }));
    flowEl.replaceChildren(empty);
    return;
  }
  const count = Math.max(3, Math.ceil((height + 8) / FLOW_ROW_PX));
  const lines = shown.slice(0, count).map((post, i) => {
    const line = flowLine(post, { live: flowLiveIds.has(String(post.id)) });
    if (!animate || flowReducedMotion.matches) line.style.animation = 'none';
    else line.style.animationDelay = `${i * 30}ms`;
    return line;
  });
  flowEl.replaceChildren(...lines);
  flowTrim();
}

// Entra una publicación nueva arriba (si el mouse no está encima).
function flowPush(post) {
  if (!flowEl.clientHeight) return;
  const empty = flowEl.querySelector('.empty');
  if (empty) empty.remove();
  const line = flowLine(post, { live: true });
  if (flowReducedMotion.matches) line.style.animation = 'none';
  flowEl.prepend(line);
  flowTrim({ animate: true });
}

function flowDrain() {
  clearTimeout(flowQueueTimer);
  flowQueueTimer = null;
  if (flowPaused || !flowQueue.length) return;
  flowPush(flowQueue.shift());
  if (flowQueue.length) flowQueueTimer = setTimeout(flowDrain, flowReducedMotion.matches ? 0 : FLOW_STEP_MS);
}

// Terminó una corrida: el flujo se rehace sin las nuevas y las nuevas del
// período entran arriba de a una, la más vieja primero (así la última queda
// arriba). Solo las que entran en la tarjeta.
function flowRunEnded(newIds) {
  const fresh = new Set((newIds || []).map(String));
  const posts = flowPosts().filter((post) => fresh.has(String(post.id)));
  const fits = Math.max(3, Math.ceil((flowEl.clientHeight + 8) / FLOW_ROW_PX));
  const entering = posts.slice(0, fits).reverse();
  flowRender({ animate: false, skip: new Set(entering.map((post) => String(post.id))) });
  flowLastKey = flowKey();
  flowQueue.push(...entering);
  flowDrain();
}

function flowKey() {
  return `${monitorPeriodStart()}|${flowPosts()
    .slice(0, 40)
    .map((p) => `${p.id}:${p.sentiment || ''}:${p.tema || ''}:${p.likes}:${p.comments}`)
    .join(',')}`;
}

// Abre el pop-up sobre la lista del flujo, en el orden en que se ve.
function flowOpen(line) {
  const ids = [...flowEl.querySelectorAll('.fl:not(.out)')].map((el) => el.dataset.id);
  openFeedPopList(ids, line.dataset.id, line);
}

if (flowEl) {
  flowEl.addEventListener('mouseenter', () => {
    flowPaused = true;
  });
  flowEl.addEventListener('mouseleave', () => {
    flowPaused = false;
    flowDrain();
  });
  flowEl.addEventListener('click', (e) => {
    const line = e.target.closest('.fl');
    if (line && !line.classList.contains('out')) flowOpen(line);
  });
  flowEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.matches('.fl')) return;
    e.preventDefault();
    flowOpen(e.target);
  });

  monitoringViewListeners.push((change) => {
    if (change && change.run === 'start') {
      flowRunning = true;
      return false;
    }
    if (change && change.run === 'end') {
      flowRunning = false;
      flowRunEnded(change.newIds);
      return false;
    }
    if (change && change.goToId !== undefined) return false;
    // La config trae los temas (el color del punto): se redibuja.
    if (change && 'config' in change) flowLastKey = null;
    if (flowRunning) return false;
    const key = flowKey();
    if (key === flowLastKey) return false;
    flowLastKey = key;
    flowRender();
    return false;
  });

  // Cambió el alto (la ventana, la solapa que se vuelve a ver): se rehace
  // sin animar.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const height = flowEl.clientHeight;
      if (Math.abs(height - flowLastHeight) < 8) return;
      if (flowLastHeight === 0) flowRender();
      else flowRender({ animate: false });
    }).observe(flowEl);
  }

  // Los posteos pudieron llegar antes de que se cargara este archivo.
  if (monitoringTable) {
    flowLastKey = flowKey();
    flowRender();
  }
}
