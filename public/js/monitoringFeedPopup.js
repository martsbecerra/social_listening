// --------------------------------------------------------------------
// Pop-up "Ver más" del feed del Monitoreo de Instagram: el posteo completo,
// con la foto a la izquierda y el texto, las métricas y las acciones a la
// derecha, y el paso al posteo anterior y al siguiente. Calcado de
// design/monitoreo-popup.html (estilos en public/css/styles.css, clases
// feed-pop-*).
//
// Lo carga SOLO instagram.html, después de monitoringFeed.js, y se apoya en
// lo que ese archivo y monitoring.js ya definen: las tarjetas del feed, la
// fila de Tabulator de cada posteo (de ahí salen los datos: acá no se guarda
// ninguna copia), postReach, buildBenchLine y los formateadores.
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
const feedPopScrollEl = document.getElementById('feedPopScroll');
const feedPopFootEl = document.getElementById('feedPopFoot');
// Anterior y siguiente: las flechas grandes a los costados de la ventana y,
// cuando no entran (ventana angosta, celular), las chicas de la cabecera.
const feedPopPrevEls = [document.getElementById('feedPopPrev'), document.getElementById('feedPopPrevSmall')];
const feedPopNextEls = [document.getElementById('feedPopNext'), document.getElementById('feedPopNextSmall')];

// Posteo que se está mostrando: el data-id de su tarjeta (siempre texto).
// null: el pop-up está cerrado.
let feedPopId = null;
// Posteo con el que se abrió. Si al cerrar es otro (se navegó), su tarjeta
// se trae a la vista.
let feedPopOpenerId = null;
// El pie está pidiendo confirmar "ignorar".
let feedPopConfirming = false;
// Elemento en el que cayó el último clic dentro del pop-up. null: todavía
// ninguno desde que se abrió (ver "Doble clic").
let feedPopLastClicked = null;

// -------------------------------------------------------------------------
// Lado de la foto.
// -------------------------------------------------------------------------

// Imagen grande del posteo. Hoy el backend no guarda ni manda fotos, así que
// esto da siempre null y se ve el recuadro "Sin foto". Cuando el
// posteo traiga el dato alcanza con devolverlo acá (image_full_url es un
// nombre provisorio): el resto ya está armado.
function feedPopImageUrl(post) {
  return post.image_full_url || null;
}

// Qué es la imagen cuando no es el posteo entero.
const FEED_POP_PHOTO_NOTES = { reel: 'Portada del reel', carrusel: 'Primera imagen del carrusel' };

function fillFeedPopPhoto(post) {
  const typeLabel = FEED_TYPE_LABELS[post.post_type];
  // Un posteo sin tipo detectado no lleva etiqueta, como en la tarjeta.
  const badge = () => (typeLabel ? [feedNode('span', 'feed-badge type', typeLabel)] : []);

  // Recuadro rayado con un texto: "Sin foto" si el posteo no tiene imagen,
  // "Imagen no disponible" si la tiene y no cargó.
  const showEmpty = (text) => {
    feedPopPhotoEl.className = 'feed-pop-photo empty';
    feedPopPhotoEl.replaceChildren(feedNode('p', 'feed-pop-photo-msg', text), ...badge());
  };

  const imageUrl = feedPopImageUrl(post);
  if (!imageUrl) {
    showEmpty('Sin foto');
    return;
  }

  const img = document.createElement('img');
  img.alt = '';
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

// "Alcance alto · por comentarios": la etiqueta de la tarjeta más la métrica
// que la disparó. Sin referencia en ninguna de las dos métricas, lo dice.
function buildFeedPopChips(post, reach) {
  const chips = feedNode('div', 'feed-pop-chips');
  chips.appendChild(
    reach
      ? feedNode('span', `feed-pop-chip reach ${reach.level}`, `${FEED_REACH_LABELS[reach.level]} · por ${reach.label}`)
      : feedNode('span', 'feed-pop-chip reach sinref', 'Alcance sin referencia')
  );
  const typeLabel = FEED_TYPE_LABELS[post.post_type];
  if (typeLabel) chips.appendChild(feedNode('span', 'feed-pop-chip type', typeLabel));
  return chips;
}

// Una fila de la tabla de métricas: "♥ Likes  4,8 k  5,4×" y, debajo, la
// mediana de la cuenta. "metric" es lo que manda el backend en post.benchmark
// (nivel, mediana y razón). Sin referencia (likes ocultos, cuenta con pocos
// posteos) no hay × y debajo va el motivo, con el mismo texto que da la
// tabla: lo arma buildBenchLine. "hit": es la métrica que disparó un alcance
// alto.
function buildFeedPopMetric(symbol, name, value, metric, hit) {
  const row = feedNode('div', `feed-pop-mt-row${hit ? ' hit' : ''}`);
  const hasReference = Boolean(metric) && metric.level !== 'sin-referencia';

  const key = feedNode('span', 'k', `${symbol} ${name}`);
  if (hit) key.append(' ', feedNode('span', 'feed-pop-hit', 'dispara el alcance'));

  const shown = feedNode('span', 'v', feedCount(value));
  const exact = value === null || value === undefined ? NaN : Number(value);
  if (Number.isFinite(exact)) shown.title = formatBenchmarkNumber(exact); // el número entero

  const x = feedNode('span', 'x', hasReference ? `${formatBenchmarkRatio(metric.ratio)}×` : '');
  if (hasReference && metric.level === 'alto') x.classList.add('up');

  let sub;
  if (hasReference) {
    sub = `Mediana de la cuenta: ${formatBenchmarkNumber(metric.median)}`;
  } else {
    // "Likes: sin dato (...)" -> "Sin dato (...)": el nombre ya está en la fila.
    const text = buildBenchLine(name, metric).textContent;
    const reason = text.startsWith(`${name}: `) ? text.slice(name.length + 2) : text;
    sub = reason.charAt(0).toUpperCase() + reason.slice(1);
  }

  row.append(key, shown, x, feedNode('span', 'sub', sub));
  return row;
}

function buildFeedPopMetrics(post, reach) {
  const benchmark = post.benchmark || {};
  const hit = (by) => Boolean(reach) && reach.level === 'alto' && reach.by === by;
  const table = feedNode('div', 'feed-pop-mt');
  table.append(
    buildFeedPopMetric('♥', 'Likes', post.likes, benchmark.likes, hit('likes')),
    buildFeedPopMetric('💬', 'Comentarios', post.comments, benchmark.comments, hit('comments'))
  );
  return table;
}

// "value": un texto o un nodo ya armado (el enlace al perfil).
function appendFeedPopDetail(list, label, value) {
  const dd = feedNode('dd');
  dd.append(value);
  list.append(feedNode('dt', '', label), dd);
}

function buildFeedPopDetails(post) {
  const list = feedNode('dl', 'feed-pop-dl');
  const { date, time } = formatFullDateTime(post.posted_at);
  appendFeedPopDetail(list, 'Publicado', time ? `${date} · ${time}` : date);
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

// Pie: el selector de sentimiento de la tabla, "Ignorar" y el enlace al
// posteo. Los cambios y los clics los atiende el pie entero (ver "Acciones
// del pie"). "error": un aviso al lado de "Ignorar" (el pedido falló).
function fillFeedPopFoot(post, error = '') {
  feedPopConfirming = false;

  const sentiment = buildSentimentSelect(post.sentiment);
  sentiment.setAttribute('aria-label', 'Sentimiento');

  const ignore = feedNode('button', 'feed-pop-btn danger', 'Ignorar');
  ignore.type = 'button';
  ignore.dataset.act = 'ignore';

  const open = feedNode('a', 'feed-pop-btn primary', 'Abrir en Instagram ↗');
  open.href = post.url;
  open.target = '_blank';
  open.rel = 'noopener';

  feedPopFootEl.replaceChildren(sentiment, ignore, open);
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

function fillFeedPop(post) {
  const reach = postReach(post);
  const account = post.account && post.account !== 'N/D' ? post.account : null;

  // Borde de arriba con el color del sentimiento, como la tarjeta.
  feedPopBoxEl.dataset.s = post.sentiment || SENTIMENT_UNSET;

  feedPopAvatarEl.textContent = account ? account[0].toUpperCase() : '?';
  feedPopAvatarEl.style.background = FEED_PALETTE[feedHash(account) % FEED_PALETTE.length];
  feedPopWhoEl.textContent = account ? `@${account}` : 'N/D';
  feedPopWhoEl.title = feedPopWhoEl.textContent; // entero al pasar el mouse, si quedó cortado
  feedPopFollowersEl.textContent = `${feedCount(post.followers)} seguidores`;

  fillFeedPopPhoto(post);

  const title = feedNode('h2', 'feed-pop-title', post.title || '(sin clasificar)');
  title.id = 'feedPopTitle'; // el nombre del diálogo (aria-labelledby)
  feedPopScrollEl.replaceChildren(
    buildFeedPopChips(post, reach),
    title,
    feedNode('p', 'feed-pop-cap', post.caption || ''),
    buildFeedPopMetrics(post, reach),
    buildFeedPopDetails(post)
  );
  feedPopScrollEl.scrollTop = 0;

  fillFeedPopFoot(post);
}

// -------------------------------------------------------------------------
// Anterior y siguiente. La lista es la de las tarjetas en pantalla, en su
// orden (con los filtros y el orden elegidos): no hay una segunda lista que
// mantener al día.
// -------------------------------------------------------------------------
function feedPopCard() {
  return feedPopId === null ? null : feedCardById(feedPopId);
}

// El posteo que se está mostrando, tal como está ahora en la tabla.
function feedPopPost() {
  const card = feedPopCard();
  const row = card ? feedRowOf(card) : null;
  return row ? row.getData() : null;
}

// La tarjeta de antes (-1) o de después (1) de la que se está mostrando.
function feedPopNeighbor(step) {
  const card = feedPopCard();
  const other = card && (step < 0 ? card.previousElementSibling : card.nextElementSibling);
  return other && other.classList.contains('feed-card') ? other : null;
}

// Contador "3 / 195" y flechas. En los extremos, la flecha que no lleva a
// ningún lado queda deshabilitada.
function updateFeedPopPosition() {
  const card = feedPopCard();
  if (!card) return;
  const cards = feedContainerEl.querySelectorAll('.feed-card');
  feedPopPosEl.textContent = `${Array.prototype.indexOf.call(cards, card) + 1} / ${cards.length}`;
  const focused = document.activeElement;
  const noPrev = !feedPopNeighbor(-1);
  const noNext = !feedPopNeighbor(1);
  for (const button of feedPopPrevEls) button.disabled = noPrev;
  for (const button of feedPopNextEls) button.disabled = noNext;
  // Un botón deshabilitado no puede quedarse con el foco: pasa a la ✕.
  if (focused && focused.disabled && feedPopEl.contains(focused)) feedPopCloseEl.focus();
}

// Muestra el posteo de una tarjeta. Los datos salen de su fila de Tabulator,
// igual que al dibujar la tarjeta. Devuelve false si la fila ya no está.
function showFeedPopCard(card) {
  const row = card ? feedRowOf(card) : null;
  if (!row) return false;
  feedPopId = card.dataset.id;
  fillFeedPop(row.getData());
  updateFeedPopPosition();
  // El contenido y el pie se rehicieron: si el foco estaba en algo que ya no
  // existe ("Ignorar", un enlace), pasa a la ✕. Sin foco adentro, ← → y Esc
  // dejarían de llegar.
  if (feedPopEl.open && !feedPopEl.contains(document.activeElement)) feedPopCloseEl.focus();
  return true;
}

function stepFeedPop(step) {
  const other = feedPopNeighbor(step);
  if (other) showFeedPopCard(other);
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
  const card = feedPopCard();
  if (!select || !card || select.value === SENTIMENT_UNSET) return;
  // PATCH, color de la pastilla, dato de la tabla y "Se despegaron".
  feedSetSentiment(card, select.value, select);
  feedPopBoxEl.dataset.s = select.value; // borde de arriba de la ventana
  // La tarjeta de atrás se rehace con el dato nuevo. No sale de la lista
  // aunque haya un filtro de sentimiento puesto: eso pasa recién al volver a
  // filtrar, igual que al corregirlo desde la tarjeta.
  const row = feedRowOf(card);
  if (row) card.replaceWith(buildFeedCard(row.getData(), postReach(row.getData())));
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
  const card = feedPopCard();
  if (!card) return;
  const id = feedPopId;
  const row = feedRowOf(card);
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
  pendingIgnoreId = row ? row.getData().id : id;
  await confirmIgnore();
  // Si salió bien, confirmIgnore sacó la fila y avisó al feed, que sacó la
  // tarjeta: el pop-up ya pasó a otro posteo o se cerró (ver
  // feedListListeners, más abajo). Si sigue en el mismo, el pedido falló.
  if (feedPopEl.open && feedPopId === id) cancelFeedPopConfirm('No se pudo ignorar');
}

feedPopFootEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  if (button.dataset.act === 'ignore') showFeedPopConfirm();
  else if (button.dataset.act === 'cancel') cancelFeedPopConfirm();
  else if (button.dataset.act === 'confirm') confirmFeedPopIgnore();
});

// -------------------------------------------------------------------------
// Abrir y cerrar.
// -------------------------------------------------------------------------

// Lo llama el feed: "Ver más" y el clic en la foto de una tarjeta.
function openFeedPop(card) {
  if (!showFeedPopCard(card)) return;
  if (!feedPopEl.open) {
    feedPopOpenerId = feedPopId;
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
}

// Se cerró en otro posteo que el de partida: su tarjeta queda a la vista
// (debajo de la barra de filtros, si hubo que mover la página) y se marca un
// instante, como al llegar desde "Se despegaron", para no perder el lugar.
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

// Deja todo como antes de abrir: la página vuelve a desplazarse y el foco va
// al "Ver más" de la tarjeta del último posteo visto. Se puede llamar de más:
// si ya se hizo, no cambia nada.
function afterFeedPopClose() {
  document.documentElement.classList.remove('feed-pop-lock');
  const card = feedPopCard();
  const moved = feedPopId !== feedPopOpenerId;
  feedPopId = null;
  feedPopOpenerId = null;
  feedPopConfirming = false;
  if (!card) return;
  const more = card.querySelector('.feed-foot [data-more]');
  if (more) more.focus({ preventScroll: true });
  if (moved) revealFeedPopCard(card);
}

// El único camino para cerrar: la ✕, Esc, un clic afuera y el propio código.
function closeFeedPop() {
  if (!feedPopEl.open) return;
  feedPopEl.close();
  afterFeedPopClose();
}

feedPopCloseEl.addEventListener('click', closeFeedPop);

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

// La lista de tarjetas cambió (ver feedListListeners en monitoringFeed.js).
feedListListeners.push((change) => {
  if (feedPopId === null) return;
  if (change && change.removing) {
    // Está por salir una tarjeta (se ignoró su posteo) y todavía ocupa su
    // lugar. Si es la del posteo abierto, el pop-up pasa al siguiente, o al
    // anterior si era el último; si no queda ninguno, se cierra.
    if (change.removing.dataset.id !== feedPopId) return;
    const other = feedPopNeighbor(1) || feedPopNeighbor(-1);
    if (!other || !showFeedPopCard(other)) {
      feedPopId = null;
      closeFeedPop();
    }
    return;
  }
  // Se redibujó la lista o ya salió una tarjeta: si el posteo abierto no
  // está, no queda nada que mostrar; si está, puede haber cambiado de lugar.
  if (!feedPopCard()) closeFeedPop();
  else updateFeedPopPosition();
});
