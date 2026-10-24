// --------------------------------------------------------------------
// Pop-up del posteo del Monitoreo de Instagram: el posteo completo, con la
// foto a la izquierda y el texto, las métricas y las acciones a la derecha,
// y el paso al anterior y al siguiente de la lista desde la que se abrió
// (estilos en public/css/styles.css, clases feed-pop-*; la maqueta vigente
// es design/social-listening-v4.html).
//
// Se abre desde tres lugares, cada uno con su lista (openFeedPopList):
//   - una tarjeta del feed: toda la lista del feed, filtrada y ordenada,
//     aunque solo se vean las primeras filas (feedVisibleIds);
//   - una línea del flujo en vivo: las líneas del flujo, en su orden;
//   - una tira de "Se despegaron": solo esas tiras.
// La lista es de ids: los datos salen siempre de la fila de Tabulator del
// posteo (acá no se guarda ninguna copia), así anda aunque el posteo no
// tenga tarjeta (vista Tabla, un filtro que lo tapa, una fila sin dibujar).
//
// Lo carga SOLO instagram.html, después de monitoringFeed.js, y se apoya en
// lo que ese archivo y monitoring.js ya definen: postReach, buildBenchLine,
// buildTemaTag, updateSentiment, confirmIgnore y los formateadores.
//
// Es un <dialog> abierto con showModal(): el navegador deja el foco adentro,
// vuelve inactivo el resto de la página y lo cierra con Esc.
// --------------------------------------------------------------------
const feedPopEl = document.getElementById('feedPop');
const feedPopBoxEl = document.getElementById('feedPopBox');
const feedPopPhotoEl = document.getElementById('feedPopPhoto');
const feedPopAvatarEl = document.getElementById('feedPopAvatar');
const feedPopWhoEl = document.getElementById('feedPopWho');
const feedPopFollowersEl = document.getElementById('feedPopFollowers');
const feedPopPosEl = document.getElementById('feedPopPos');
const feedPopCloseEl = document.getElementById('feedPopClose');
const feedPopScrollWrapEl = document.getElementById('feedPopScrollWrap');
const feedPopScrollEl = document.getElementById('feedPopScroll');
const feedPopFootEl = document.getElementById('feedPopFoot');
// Anterior y siguiente: las flechas grandes a los costados de la ventana y,
// cuando no entran (ventana angosta, celular), las chicas de la cabecera.
const feedPopPrevEls = [document.getElementById('feedPopPrev'), document.getElementById('feedPopPrevSmall')];
const feedPopNextEls = [document.getElementById('feedPopNext'), document.getElementById('feedPopNextSmall')];

// La lista que se recorre (ids, siempre texto) y en qué lugar de ella está
// el posteo que se ve. feedPopId null: el pop-up está cerrado.
let feedPopList = [];
let feedPopIndex = -1;
let feedPopId = null;
// Con qué se abrió: el elemento (la tarjeta, la línea del flujo, la tira),
// su contenedor (si el elemento se rehízo mientras tanto, se busca ahí el
// del mismo posteo) y el posteo. Al cerrar, el foco vuelve ahí.
let feedPopOpener = null;
let feedPopOpenerBox = null;
let feedPopOpenerId = null;
// El pie está pidiendo confirmar "ignorar".
let feedPopConfirming = false;
// Elemento en el que cayó el último clic dentro del pop-up. null: todavía
// ninguno desde que se abrió (ver "Doble clic").
let feedPopLastClicked = null;

// -------------------------------------------------------------------------
// Lado de la foto.
// -------------------------------------------------------------------------

// Imagen grande del posteo: la copia de 900 px que el listado manda en
// `image.fullUrl` (ver feedImageUrl en monitoringFeed.js). Sin copia
// guardada da null.
function feedPopImageUrl(post) {
  return (post.image && post.image.fullUrl) || null;
}

// Qué es la imagen cuando no es el posteo entero.
const FEED_POP_PHOTO_NOTES = { reel: 'Portada del reel', carrusel: 'Primera imagen del carrusel' };

// Texto alternativo de la foto: qué es y de quién. Acá la foto es el
// contenido de ese lado del pop-up, no un adorno como en la tarjeta.
function feedPopPhotoAlt(post) {
  const what = FEED_POP_PHOTO_NOTES[post.post_type] || 'Foto del posteo';
  const account = post.account && post.account !== 'N/D' ? ` de @${post.account}` : '';
  return `${what}${account}`;
}

function fillFeedPopPhoto(post) {
  const typeLabel = FEED_TYPE_LABELS[post.post_type];
  // Un posteo sin tipo detectado no lleva etiqueta, como en la tarjeta.
  const badge = () => (typeLabel ? [feedNode('span', 'feed-badge type', typeLabel)] : []);

  // Recuadro rayado con un texto: "Sin foto" si nunca se intentó bajar la
  // imagen, "Imagen no disponible" si la descarga falló o la copia no cargó.
  const showEmpty = (text) => {
    feedPopPhotoEl.className = 'feed-pop-photo empty';
    feedPopPhotoEl.replaceChildren(feedNode('p', 'feed-pop-photo-msg', text), ...badge());
  };

  const imageUrl = feedPopImageUrl(post);
  if (!imageUrl) {
    showEmpty(feedImageFailed(post) ? 'Imagen no disponible' : 'Sin foto');
    return;
  }

  const img = document.createElement('img');
  img.alt = feedPopPhotoAlt(post); // texto, no HTML: entra como atributo
  img.decoding = 'async';
  img.addEventListener('error', () => {
    // Si mientras cargaba se pasó a otro posteo, esta imagen ya no está en
    // pantalla y no hay nada que avisar.
    if (img.isConnected) showEmpty('Imagen no disponible');
  });
  img.src = imageUrl;

  feedPopPhotoEl.className = 'feed-pop-photo';
  feedPopPhotoEl.replaceChildren(img, ...badge());
  const note = FEED_POP_PHOTO_NOTES[post.post_type];
  if (note) feedPopPhotoEl.appendChild(feedNode('span', 'feed-pop-note', note));
}

// -------------------------------------------------------------------------
// Contenido. Todo dato del posteo entra por textContent (feedNode) o como
// nodo de texto: título, texto, cuenta y motivo vienen de Instagram y nunca
// se insertan como HTML.
// -------------------------------------------------------------------------

// Arriba del título: "Alcance alto · 2,10× por comentarios" (la etiqueta de
// la tarjeta, la razón que la decidió y de qué métrica es; sin referencia
// en ninguna de las dos métricas, lo dice), el tipo y el tema.
function buildFeedPopChips(post, reach) {
  const chips = feedNode('div', 'feed-pop-chips');
  const reachChip = reach
    ? feedNode('span', `chip-r ${reach.level}`, `${FEED_REACH_LABELS[reach.level]} · ${formatBenchmarkRatio(reach.ratio)}× por ${reach.label}`)
    : feedNode('span', 'chip-r sinref', 'Alcance sin referencia');
  if (reach) {
    reachChip.dataset.tipTitle = FEED_REACH_LABELS[reach.level];
    reachChip.dataset.tip = `Razón de alcance: ${benchmarkRatioBasis(reach.metric)}.`;
  }
  chips.appendChild(reachChip);
  const typeLabel = FEED_TYPE_LABELS[post.post_type];
  if (typeLabel) chips.appendChild(feedNode('span', 'chip-t', typeLabel));
  const tema = buildTemaTag(post.tema);
  if (tema) chips.appendChild(tema);
  return chips;
}

// Una de las dos métricas, en su recuadro: el número grande con su ícono y,
// si la cuenta tiene referencia, la razón ("1,56×"; lleva colchón: al pasar
// el mouse dice con qué se calculó); debajo, contra lo habitual de la
// cuenta (su mediana) o por qué no hay con qué comparar (el mismo texto que
// da la tabla: lo arma buildBenchLine). "hit": es la métrica que disparó un
// alcance alto.
function buildFeedPopMetric(kind, name, value, metric, hit) {
  const box = feedNode('div', `feed-pop-mbox ${kind}${hit ? ' hit' : ''}`);
  const hasReference = Boolean(metric) && metric.level !== 'sin-referencia';

  const big = feedNode('b');
  // Constante propia, no un dato del posteo: se puede insertar como HTML.
  big.insertAdjacentHTML('beforeend', FEED_METRIC_ICONS[kind]);
  const shown = feedNode('span', 'v', feedCount(value));
  const exact = value === null || value === undefined ? NaN : Number(value);
  if (Number.isFinite(exact)) shown.title = formatBenchmarkNumber(exact); // el número entero
  big.appendChild(shown);
  if (hasReference) {
    const x = feedNode('span', `x${metric.level === 'alto' ? ' up' : ''}`, `${formatBenchmarkRatio(metric.ratio)}×`);
    x.title = `Razón de alcance: ${benchmarkRatioBasis(metric)}`;
    big.appendChild(x);
  }

  let sub;
  if (hasReference) {
    sub = `${name.toLowerCase()} · mediana de la cuenta ${formatBenchmarkNumber(metric.median)}`;
  } else {
    // "Likes: sin dato (...)" -> "likes · sin dato (...)".
    const text = buildBenchLine(name, metric).textContent;
    sub = `${name.toLowerCase()} · ${text.startsWith(`${name}: `) ? text.slice(name.length + 2) : text}`;
  }
  box.append(big, feedNode('small', '', sub));
  if (hit) box.appendChild(feedNode('span', 'feed-pop-hit', 'dispara el alcance'));
  return box;
}

function buildFeedPopMetrics(post, reach) {
  const benchmark = post.benchmark || {};
  const hit = (by) => Boolean(reach) && reach.level === 'alto' && reach.by === by;
  const mets = feedNode('div', 'feed-pop-mets');
  mets.append(
    buildFeedPopMetric('likes', 'Likes', post.likes, benchmark.likes, hit('likes')),
    buildFeedPopMetric('comments', 'Comentarios', post.comments, benchmark.comments, hit('comments'))
  );
  return mets;
}

// Debajo de las métricas: de cuándo son ("Métricas al 08/10/2026 · 23:48",
// ver postMetricsDate en monitoring.js). En ámbar si tienen más de 3 días.
// null si el posteo no trae fecha.
function buildFeedPopMetricsDate(post) {
  const when = postMetricsDate(post);
  if (!when) return null;
  const line = feedNode('p', `feed-pop-mt-date${when.stale ? ' stale' : ''}`, `Métricas al ${when.full}`);
  if (when.stale) line.title = `Hace más de ${METRICS_STALE_DAYS} días que no se actualizan`;
  return line;
}

// "value": un texto o un nodo ya armado (el enlace al perfil).
function appendFeedPopDetail(list, label, value) {
  const dd = feedNode('dd');
  dd.append(value);
  list.append(feedNode('dt', '', label), dd);
}

function buildFeedPopDetails(post) {
  const list = feedNode('dl', 'feed-pop-dl');
  // El motivo completo (el pie de la tarjeta lleva la versión corta).
  appendFeedPopDetail(list, 'Detectado por', post.matched_reason || 'N/D');
  if (post.account && post.account !== 'N/D') {
    const profile = feedNode('a', '', 'Ver perfil ↗');
    profile.href = `${PROFILE_BASE}${post.account}`;
    profile.target = '_blank';
    profile.rel = 'noopener';
    appendFeedPopDetail(list, 'Cuenta', profile);
  }
  return list;
}

// Pie fijo: el selector de sentimiento de la tabla, "Ignorar", "Analizar
// comentarios" y el enlace al posteo. Los cambios y los clics los atiende el
// pie entero (ver "Acciones del pie"). "error": un aviso al lado de
// "Ignorar" (el pedido falló).
function fillFeedPopFoot(post, error = '') {
  feedPopConfirming = false;

  const sentiment = buildSentimentSelect(post.sentiment);
  sentiment.setAttribute('aria-label', 'Sentimiento');

  const ignore = feedNode('button', 'feed-pop-btn danger', 'Ignorar');
  ignore.type = 'button';
  ignore.dataset.act = 'ignore';

  const analyze = feedNode('button', 'feed-pop-btn', 'Analizar comentarios');
  analyze.type = 'button';
  analyze.dataset.act = 'analyze';
  analyze.dataset.tipTitle = 'Analizar comentarios';
  analyze.dataset.tip = 'Abre la solapa Análisis con este link ya cargado. No gasta nada hasta que aprietes Analizar.';

  const open = feedNode('a', 'feed-pop-btn primary', 'Abrir en Instagram ↗');
  open.href = post.url;
  open.target = '_blank';
  open.rel = 'noopener';

  // Las dos de la derecha van juntas: si no entran en el renglón, bajan las
  // dos.
  const acts = feedNode('span', 'feed-pop-acts');
  acts.append(analyze, open);
  feedPopFootEl.replaceChildren(sentiment, ignore, acts);
  if (error) {
    const notice = feedNode('span', 'feed-pop-error', error);
    notice.setAttribute('role', 'alert');
    ignore.after(notice);
  }
}

// El pie pasa a pedir la confirmación, adentro del pop-up (en la tabla y en
// las tarjetas es un cartel aparte). El foco va a "Cancelar".
function showFeedPopConfirm() {
  feedPopConfirming = true;

  const question = feedNode('p');
  question.append(feedNode('b', '', '¿Ignorar este posteo?'), ' Dejará de aparecer en el monitoreo.');

  const cancel = feedNode('button', 'feed-pop-btn', 'Cancelar');
  cancel.type = 'button';
  cancel.dataset.act = 'cancel';

  const confirm = feedNode('button', 'feed-pop-btn dangersolid', 'Sí, ignorar');
  confirm.type = 'button';
  confirm.dataset.act = 'confirm';

  const wrap = feedNode('div', 'feed-pop-confirm');
  wrap.append(question, cancel, confirm);
  feedPopFootEl.replaceChildren(wrap);
  cancel.focus();
}

// El degradé de abajo del texto, solo si queda texto por leer.
function updateFeedPopFade() {
  const el = feedPopScrollEl;
  feedPopScrollWrapEl.classList.toggle('more', el.scrollTop + el.clientHeight < el.scrollHeight - 4);
}

function fillFeedPop(post) {
  const reach = postReach(post);
  const account = post.account && post.account !== 'N/D' ? post.account : null;

  // Borde de arriba con el color del sentimiento, como la tarjeta.
  feedPopBoxEl.dataset.s = post.sentiment || SENTIMENT_UNSET;

  feedPopAvatarEl.textContent = account ? account[0].toUpperCase() : '?';
  feedPopAvatarEl.style.background = accountColor(account);
  feedPopWhoEl.textContent = account ? `@${account}` : 'N/D';
  feedPopWhoEl.title = feedPopWhoEl.textContent; // entero al pasar el mouse, si quedó cortado
  const { date, time } = formatFullDateTime(post.posted_at);
  feedPopFollowersEl.textContent = `${feedCount(post.followers)} seguidores · ${time ? `${date} ${time}` : date}`;

  fillFeedPopPhoto(post);

  const title = feedNode('h2', 'feed-pop-title', post.title || '(sin clasificar)');
  title.id = 'feedPopTitle'; // el nombre del diálogo (aria-labelledby)
  const metricsDate = buildFeedPopMetricsDate(post);
  feedPopScrollEl.replaceChildren(
    buildFeedPopChips(post, reach),
    title,
    feedNode('p', 'feed-pop-cap', post.caption || ''),
    buildFeedPopMetrics(post, reach),
    ...(metricsDate ? [metricsDate] : []),
    buildFeedPopDetails(post)
  );
  feedPopScrollEl.scrollTop = 0;
  requestAnimationFrame(updateFeedPopFade);

  fillFeedPopFoot(post);
}

feedPopScrollEl.addEventListener('scroll', updateFeedPopFade, { passive: true });
window.addEventListener('resize', () => {
  if (feedPopEl.open) updateFeedPopFade();
});
// La rueda del mouse sobre la foto desplaza el texto (la foto no se mueve).
feedPopPhotoEl.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || !feedPopEl.open) return;
    if (feedPopScrollEl.scrollHeight <= feedPopScrollEl.clientHeight) return;
    feedPopScrollEl.scrollTop += e.deltaY;
    e.preventDefault();
  },
  { passive: false }
);

// -------------------------------------------------------------------------
// Anterior y siguiente, sobre la lista con la que se abrió.
// -------------------------------------------------------------------------
// Los ids que siguen en la tabla. getRow de Tabulator deja un aviso en la
// consola si el id ya no está (un posteo recién ignorado): se pregunta acá
// antes. Quien recorre una lista entera arma el conjunto una sola vez.
function feedPopTableIds() {
  return new Set(monitoringTable ? monitoringTable.getData().map((post) => String(post.id)) : []);
}

function feedPopRowOf(id, ids = feedPopTableIds()) {
  if (id === null || id === undefined || !monitoringTable || !ids.has(String(id))) return null;
  return monitoringTable.getRow(id) || null;
}

// La fila de Tabulator del posteo que se está mostrando.
function feedPopRow() {
  return feedPopRowOf(feedPopId);
}

// El posteo que se está mostrando, tal como está ahora en la tabla.
function feedPopPost() {
  const row = feedPopRow();
  return row ? row.getData() : null;
}

// Las flechas (las grandes y las chicas) y el contador "3 / 40": a la vista
// si la lista tiene más de un posteo. En los extremos, la flecha que no
// lleva a ningún lado queda deshabilitada.
function updateFeedPopPosition() {
  const many = feedPopList.length > 1;
  for (const el of [...feedPopPrevEls, ...feedPopNextEls, feedPopPosEl]) el.classList.toggle('hidden', !many);
  feedPopEl.classList.toggle('nav-on', many);
  feedPopPosEl.textContent = many ? `${feedPopIndex + 1} / ${feedPopList.length}` : '';
  const focused = document.activeElement;
  for (const button of feedPopPrevEls) button.disabled = feedPopIndex <= 0;
  for (const button of feedPopNextEls) button.disabled = feedPopIndex >= feedPopList.length - 1;
  // Un botón deshabilitado no puede quedarse con el foco: pasa a la ✕.
  if (focused && focused.disabled && feedPopEl.contains(focused)) feedPopCloseEl.focus();
}

// Muestra el posteo de ese lugar de la lista. Devuelve false si su fila ya
// no está.
function showFeedPopAt(index) {
  const id = feedPopList[index];
  const row = feedPopRowOf(id);
  if (!row) return false;
  feedPopIndex = index;
  feedPopId = id;
  fillFeedPop(row.getData());
  updateFeedPopPosition();
  // El contenido y el pie se rehicieron: si el foco estaba en algo que ya no
  // existe ("Ignorar", un enlace), pasa a la ✕. Sin foco adentro, ← → y Esc
  // dejarían de llegar.
  if (feedPopEl.open && !feedPopEl.contains(document.activeElement)) feedPopCloseEl.focus();
  return true;
}

// Al de antes (-1) o al de después (1); si alguno ya no está, se lo saltea.
function stepFeedPop(step) {
  const ids = feedPopTableIds();
  for (let i = feedPopIndex + step; i >= 0 && i < feedPopList.length; i += step) {
    if (!feedPopRowOf(feedPopList[i], ids)) continue;
    showFeedPopAt(i);
    feedPopBoxEl.classList.remove('swap');
    void feedPopBoxEl.offsetWidth; // reinicia la animación del cambio
    feedPopBoxEl.classList.add('swap');
    return;
  }
}

for (const button of feedPopPrevEls) button.addEventListener('click', () => stepFeedPop(-1));
for (const button of feedPopNextEls) button.addEventListener('click', () => stepFeedPop(1));

// Teclado. Esc se atiende acá, en la tecla, y no se deja al navegador: así
// cancela el pedido de confirmación sin cerrar el pop-up, pase lo que pase.
// ← y → no actúan con el foco en el selector de sentimiento: ahí las flechas
// cambian el valor.
feedPopEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    escapeFeedPop();
    return;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest('select, input, textarea')) return;
  e.preventDefault();
  stepFeedPop(e.key === 'ArrowLeft' ? -1 : 1);
});

// -------------------------------------------------------------------------
// Acciones del pie: las mismas de la tarjeta y de la fila de la tabla, con
// las mismas funciones.
// -------------------------------------------------------------------------
// Con qué se tocó por última vez el selector de sentimiento: el mouse (o el
// dedo) o el teclado. Lo usa el final del "change".
let feedPopSelectByPointer = false;
feedPopFootEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('select.sentiment-select')) feedPopSelectByPointer = true;
});
feedPopFootEl.addEventListener('keydown', (e) => {
  if (e.target.closest('select.sentiment-select')) feedPopSelectByPointer = false;
});

feedPopFootEl.addEventListener('change', (e) => {
  const select = e.target.closest('select.sentiment-select');
  const row = feedPopRow();
  if (!select || !row || select.value === SENTIMENT_UNSET) return;
  // PATCH, color de la pastilla, dato de la tabla, "Se despegaron" y aviso
  // a las otras vistas (el feed, el panel y el flujo se rehacen con el dato
  // nuevo). Un filtro de sentimiento puesto no saca al posteo de la lista
  // hasta que se vuelva a filtrar, igual que al corregirlo desde la tarjeta.
  updateSentiment(row.getData().id, select.value, select);
  row.update({ sentiment: select.value });
  renderHighlightCards(monitoringTable.getData());
  notifyMonitoringViews();
  feedPopBoxEl.dataset.s = select.value; // borde de arriba de la ventana
  // Elegido con el mouse, el foco quedaría en el selector, y ahí las flechas
  // cambian el valor y lo guardan: al apretar → para pasar de posteo se
  // corregía otra vez el sentimiento. El foco pasa a la ✕. Si se lo está
  // manejando con el teclado, se queda donde está.
  if (feedPopSelectByPointer) {
    feedPopSelectByPointer = false;
    feedPopCloseEl.focus();
  }
});

// Vuelve del pedido de confirmación al pie normal, con el foco en "Ignorar"
// (de donde se vino). "error": aviso para mostrar al lado.
function cancelFeedPopConfirm(error = '') {
  const post = feedPopPost();
  if (!post) return;
  fillFeedPopFoot(post, error);
  feedPopFootEl.querySelector('[data-act="ignore"]').focus();
}

async function confirmFeedPopIgnore() {
  const row = feedPopRow();
  if (!row) return;
  const id = feedPopId;
  // Un solo pedido, aunque se apriete dos veces.
  for (const button of feedPopFootEl.querySelectorAll('button')) button.disabled = true;
  // La pregunta ya se contestó y el pedido sale: no queda nada que cancelar.
  // Sin esto, Esc con el pedido en camino volvía a armar el pie con
  // "Ignorar" como si se hubiera cancelado, y el posteo se ignoraba igual.
  // Desde acá Esc cierra el pop-up, como siempre.
  feedPopConfirming = false;
  // confirmIgnore (monitoring.js) ignora el posteo anotado en
  // pendingIgnoreId, que es lo que deja el cartel de la tabla al abrirse. Acá
  // la confirmación ya se dio en el pie: se anota directo, sin ese cartel.
  pendingIgnoreId = row.getData().id;
  await confirmIgnore();
  if (!feedPopEl.open || feedPopId !== id) return;
  // Si la fila sigue, el pedido falló.
  if (feedPopRow()) {
    cancelFeedPopConfirm('No se pudo ignorar');
    return;
  }
  // Salió de la lista: se pasa al que seguía (o al anterior, si era el
  // último); si no queda ninguno, se cierra.
  feedPopList.splice(feedPopIndex, 1);
  for (let i = Math.min(feedPopIndex, feedPopList.length - 1); i >= 0; i--) {
    if (showFeedPopAt(i)) return;
  }
  closeFeedPop();
}

// "Analizar comentarios": cierra el pop-up, abre la solapa Análisis y deja
// el link del posteo en el campo, con el foco ahí. No analiza nada: eso
// recién con "Analizar".
function analyzeFromFeedPop() {
  const post = feedPopPost();
  if (!post) return;
  closeFeedPop({ restoreFocus: false });
  openTabFromUser('analysis');
  const input = document.getElementById('url');
  if (!input) return;
  input.value = post.url;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

feedPopFootEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  if (button.dataset.act === 'ignore') showFeedPopConfirm();
  else if (button.dataset.act === 'cancel') cancelFeedPopConfirm();
  else if (button.dataset.act === 'confirm') confirmFeedPopIgnore();
  else if (button.dataset.act === 'analyze') analyzeFromFeedPop();
});

// -------------------------------------------------------------------------
// Abrir y cerrar.
// -------------------------------------------------------------------------

// Muestra el <dialog>, si no está ya abierto, y deja el foco en la ✕.
function showFeedPopDialog() {
  if (!feedPopEl.open) {
    feedPopLastClicked = null;
    // El diálogo vuelve inactiva la página de atrás pero no frena su scroll:
    // se bloquea acá (html.feed-pop-lock). Al bloquearlo desaparece la barra
    // de scroll y la página se ensancha: ese ancho, medido antes y después,
    // se compensa para que el fondo no salte.
    const root = document.documentElement;
    const widthBefore = root.clientWidth;
    root.style.setProperty('--feed-pop-gap', '0px');
    root.classList.add('feed-pop-lock');
    root.style.setProperty('--feed-pop-gap', `${Math.max(0, root.clientWidth - widthBefore)}px`);
    feedPopEl.showModal();
  }
  feedPopCloseEl.focus();
  updateFeedPopFade();
}

// Abre el posteo "id" sobre la lista "ids" (en el orden en que se ve).
// "opener": el elemento desde el que se abrió (el foco vuelve ahí). Si el
// posteo no está en la lista, se lo muestra solo. Devuelve false si su fila
// no está (quien llama decide qué hacer).
function openFeedPopList(ids, id, opener) {
  const target = String(id);
  if (!feedPopRowOf(target)) return false;
  const list = (ids || []).map(String);
  let index = list.indexOf(target);
  if (index < 0) {
    list.length = 0;
    list.push(target);
    index = 0;
  }
  if (!feedPopEl.open) {
    feedPopOpener = opener || null;
    feedPopOpenerBox = (opener && opener.parentElement) || null;
    feedPopOpenerId = target;
  }
  feedPopList = list;
  showFeedPopAt(index);
  showFeedPopDialog();
  return true;
}

// Lo llama el feed: un clic en una tarjeta o, con el foco en ella, Enter o
// Espacio. Recorre toda la lista del feed, no solo las filas a la vista.
function openFeedPop(card) {
  return openFeedPopList(feedVisibleIds, card.dataset.id, card);
}

// La tarjeta del posteo en el que se cerró puede no estar donde se la dejó:
// se navegó a otro posteo. Si no quedó entera a la vista se la trae debajo
// de la barra superior y se la marca un instante; si ya se ve, la página no
// se mueve.
function revealFeedPopCard(card) {
  const { top, bottom } = card.getBoundingClientRect();
  if (top < feedBarBottom() || bottom > window.innerHeight) {
    feedScrollToCard(card);
    // Al llegar se dibujan las tarjetas de alrededor con su alto real y la
    // posición puede correrse unos píxeles: se acomoda una vez más.
    setTimeout(() => {
      if (card.isConnected) feedScrollToCard(card);
    }, 80);
  }
  card.classList.remove('flash');
  void card.offsetWidth; // reinicia la animación si ya había corrido
  card.classList.add('flash');
}

// El elemento del posteo "id" en el contenedor desde el que se abrió (la
// tarjeta, la línea o la tira se pudieron rehacer mientras tanto).
function feedPopFindIn(box, id) {
  if (!box || !box.isConnected) return null;
  return [...box.children].find((el) => (el.dataset.id || el.dataset.postId) === id) || null;
}

// Deja todo como antes de abrir: la página vuelve a desplazarse y el foco va
// a lo que lo abrió. Si se abrió desde el feed y se navegó a otro posteo
// cuya tarjeta está dibujada, el foco va a esa tarjeta y se la trae a la
// vista. Se puede llamar de más: si ya se hizo, no cambia nada.
function afterFeedPopClose({ restoreFocus = true } = {}) {
  document.documentElement.classList.remove('feed-pop-lock');
  const lastId = feedPopId;
  const opener = feedPopOpener;
  const openerBox = feedPopOpenerBox;
  const openerId = feedPopOpenerId;
  feedPopId = null;
  feedPopList = [];
  feedPopIndex = -1;
  feedPopOpener = null;
  feedPopOpenerBox = null;
  feedPopOpenerId = null;
  feedPopConfirming = false;
  if (!restoreFocus || lastId === null) return;
  if (openerBox === feedContainerEl && lastId !== openerId) {
    const card = feedCardById(lastId);
    if (card) {
      card.focus({ preventScroll: true });
      revealFeedPopCard(card);
      return;
    }
  }
  // Si lo que lo abrió ya no está (se ignoró), el foco va al posteo que se
  // estaba viendo o, si tampoco está, al primero de esa lista: nunca a
  // <body>, donde las teclas dejan de llegar a algún lado.
  const back =
    (opener && opener.isConnected ? opener : feedPopFindIn(openerBox, openerId)) ||
    feedPopFindIn(openerBox, lastId) ||
    (openerBox && openerBox.isConnected ? openerBox.querySelector('[tabindex="0"]') : null);
  if (back) back.focus({ preventScroll: true });
}

// El único camino para cerrar: la ✕, Esc, un clic afuera y el propio código.
function closeFeedPop({ restoreFocus = true } = {}) {
  if (!feedPopEl.open) return;
  feedPopEl.close();
  afterFeedPopClose({ restoreFocus });
}

feedPopCloseEl.addEventListener('click', () => closeFeedPop());

// Esc: con el pedido de confirmación de "ignorar" abierto lo cancela; si no,
// cierra.
function escapeFeedPop() {
  if (feedPopConfirming) cancelFeedPopConfirm();
  else closeFeedPop();
}

// El navegador pide cerrar por su cuenta (Esc con el foco fuera de la
// ventana, el botón "atrás" del celular): mismo criterio.
feedPopEl.addEventListener('cancel', (e) => {
  e.preventDefault();
  escapeFeedPop();
});

// Respaldo, por si el navegador lo cierra igual sin pasar por closeFeedPop.
// Si en el medio se volvió a abrir, no hay nada que ordenar.
feedPopEl.addEventListener('close', () => {
  if (!feedPopEl.open) afterFeedPopClose();
});

// -------------------------------------------------------------------------
// Doble clic. El segundo clic puede caer sobre algo que no estaba ahí en el
// primero:
//   - el pop-up recién abierto con un doble clic en la tarjeta: el fondo
//     oscuro (lo cerraría en el acto), una flecha o "Abrir en Instagram";
//   - el pie recién rehecho: "Abrir en Instagram" queda donde estaban
//     "Cancelar" y "Sí, ignorar", y abriría una pestaña.
// Se descarta todo clic repetido (detail > 1: sigue de corrido a otro) que no
// caiga en el mismo elemento que el anterior. Apretar varias veces seguidas
// la misma flecha sigue andando. Se atiende en la fase de captura, antes que
// cualquier otro manejador de clic de acá adentro.
// -------------------------------------------------------------------------
feedPopEl.addEventListener(
  'click',
  (e) => {
    if (e.detail > 1 && e.target !== feedPopLastClicked) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return; // no cuenta como clic propio: un tercero seguido también se descarta
    }
    feedPopLastClicked = e.target;
  },
  true
);

// Clic en el fondo oscuro, que es el <dialog> mismo (la ventana es su hijo).
// Solo si el botón también se apretó ahí: arrastrar para seleccionar texto y
// soltar afuera no cierra.
let feedPopPressedOutside = false;
feedPopEl.addEventListener('mousedown', (e) => {
  feedPopPressedOutside = e.target === feedPopEl;
});
feedPopEl.addEventListener('click', (e) => {
  if (e.target === feedPopEl && feedPopPressedOutside) closeFeedPop();
});

// Cambiaron los datos con el pop-up abierto (terminó una corrida, se
// recargó la lista): los posteos que ya no están salen de la lista; si el
// que se ve no está, se cierra.
monitoringViewListeners.push((change) => {
  if (!feedPopEl.open || feedPopId === null) return false;
  if (change && (change.run || 'config' in change || change.goToId !== undefined || change.ignoredId !== undefined)) return false;
  if (!feedPopRow()) {
    closeFeedPop();
    return false;
  }
  const current = feedPopId;
  const ids = feedPopTableIds();
  feedPopList = feedPopList.filter((id) => id === current || ids.has(String(id)));
  feedPopIndex = feedPopList.indexOf(current);
  updateFeedPopPosition();
  return false;
});

// Desde el inicio: "instagram.html#publicacion-<id>" (dashboard.js) abre el
// Monitoreo y, cuando llegan los posteos, el pop-up de esa publicación, que
// recorre el feed si está en él (si no, va sola). Si no está en la tabla
// (se ignoró, o el id no es de Instagram) queda el Monitoreo sin pop-up. La
// dirección vuelve a ser la de la solapa, sin sumar un paso al historial.
const FEED_POP_HASH_RE = /^#publicacion-(\d{1,30})$/;
let feedPopHashId = null;

function feedPopTakeHash() {
  const match = FEED_POP_HASH_RE.exec(location.hash);
  if (!match) return;
  feedPopHashId = match[1];
  history.replaceState(null, '', '#tab-monitoring');
  openTab('monitoring', { updateHash: false });
}

monitoringViewListeners.push((change) => {
  if (feedPopHashId === null || change !== undefined || !monitoringTable) return false;
  const id = feedPopHashId;
  feedPopHashId = null;
  // Después del redibujo del feed (que espera 150 ms), para recorrer su
  // lista y devolverle el foco a su tarjeta al cerrar (si no tiene, a la
  // solapa del Monitoreo: nunca a <body>).
  setTimeout(() => {
    const ids = feedVisibleIds.includes(id) ? feedVisibleIds : [id];
    const opener = feedCardById(id) || document.querySelector('[role="tab"][data-tab="monitoring"]');
    openFeedPopList(ids, id, opener);
  }, 250);
  return false;
});

feedPopTakeHash();
