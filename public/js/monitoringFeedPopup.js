// --------------------------------------------------------------------
// Pop-up "Ver más" del feed del Monitoreo de Instagram: el posteo completo,
// con la foto a la izquierda y el texto, las métricas y las acciones a la
// derecha. Calcado de design/monitoreo-popup.html (estilos en
// public/css/styles.css, clases feed-pop-*).
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
const feedPopCloseEl = document.getElementById('feedPopClose');
const feedPopScrollEl = document.getElementById('feedPopScroll');
const feedPopFootEl = document.getElementById('feedPopFoot');

// Posteo que se está mostrando: el data-id de su tarjeta (siempre texto).
// null: el pop-up está cerrado.
let feedPopId = null;

// -------------------------------------------------------------------------
// Lado de la foto.
// -------------------------------------------------------------------------

// Imagen grande del posteo. Hoy el backend no guarda ni manda fotos, así que
// esto da siempre null y se ve el recuadro "Imagen no disponible". Cuando el
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

  const showMissing = () => {
    feedPopPhotoEl.className = 'feed-pop-photo broken';
    feedPopPhotoEl.replaceChildren(feedNode('p', 'feed-pop-photo-msg', 'Imagen no disponible'), ...badge());
  };

  const imageUrl = feedPopImageUrl(post);
  if (!imageUrl) {
    showMissing();
    return;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    // Si mientras cargaba se pasó a otro posteo, esta imagen ya no está en
    // pantalla y no hay nada que avisar.
    if (img.isConnected) showMissing();
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

function fillFeedPopFoot(post) {
  const open = feedNode('a', 'feed-pop-btn primary', 'Abrir en Instagram ↗');
  open.href = post.url;
  open.target = '_blank';
  open.rel = 'noopener';
  feedPopFootEl.replaceChildren(open);
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
// Abrir y cerrar.
// -------------------------------------------------------------------------

// Muestra el posteo de una tarjeta. Los datos salen de su fila de Tabulator,
// igual que al dibujar la tarjeta. Devuelve false si la fila ya no está.
function showFeedPopCard(card) {
  const row = card ? feedRowOf(card) : null;
  if (!row) return false;
  feedPopId = card.dataset.id;
  fillFeedPop(row.getData());
  return true;
}

// Lo llama el feed: "Ver más" y el clic en la foto de una tarjeta.
function openFeedPop(card) {
  if (!showFeedPopCard(card)) return;
  if (!feedPopEl.open) {
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

// Deja todo como antes de abrir: la página vuelve a desplazarse y el foco va
// al "Ver más" de la tarjeta del posteo que se estaba viendo. Se puede llamar
// de más: si ya se hizo, no cambia nada.
function afterFeedPopClose() {
  document.documentElement.classList.remove('feed-pop-lock');
  const card = feedPopId === null ? null : feedCardById(feedPopId);
  feedPopId = null;
  const more = card && card.querySelector('.feed-foot [data-more]');
  if (more) more.focus({ preventScroll: true });
}

// El único camino para cerrar: la ✕, Esc, un clic afuera y el propio código.
function closeFeedPop() {
  if (!feedPopEl.open) return;
  feedPopEl.close();
  afterFeedPopClose();
}

feedPopCloseEl.addEventListener('click', closeFeedPop);

// Esc. Sin esto lo cierra el navegador por su cuenta y el orden de arriba
// quedaría para el evento "close", que llega recién en el próximo cuadro.
feedPopEl.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeFeedPop();
});

// Respaldo, por si el navegador lo cierra igual sin pasar por closeFeedPop.
// Si en el medio se volvió a abrir, no hay nada que ordenar.
feedPopEl.addEventListener('close', () => {
  if (!feedPopEl.open) afterFeedPopClose();
});

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
// Si el posteo que se está mostrando ya no está, no queda nada que mostrar.
feedListListeners.push(() => {
  if (feedPopId !== null && !feedCardById(feedPopId)) closeFeedPop();
});
