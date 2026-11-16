// --------------------------------------------------------------------
// Vista "Feed" de la solapa Monitoreo en vivo de Instagram: las mismas
// publicaciones y los mismos filtros que la tabla, en tarjetas (estilos en
// public/css/styles.css, clases feed-*; la maqueta vigente es
// design/social-listening-v4.html).
//
// Lo carga SOLO instagram.html, después de monitoring.js, y se apoya en lo
// que ese archivo ya define: monitoringTable (la fuente de los posteos, ya
// filtrados por la barra con postMatchesFilters), readFilterValues, postReach
// (el alcance), buildSentimentSelect y los formateadores. El pop-up del
// posteo, que se abre desde la tarjeta, está aparte: monitoringFeedPopup.js.
// x.html no lo carga: en X la solapa sigue siendo solo la tabla.
// --------------------------------------------------------------------
const feedContainerEl = document.getElementById('monitoringFeed');
const feedViewSegEl = document.getElementById('viewSeg');
const feedOrderEl = document.getElementById('fOrden');
const feedOrderWrapEl = feedOrderEl.closest('.f');
const feedTableWrapEl = document.getElementById('monitoringTable').closest('.tbl-wrap');

// Última vista elegida; si no hay ninguna, el feed.
// localStorage puede no estar (modo privado, almacenamiento bloqueado): en
// ese caso vale el feed y no se recuerda nada.
const FEED_VIEW_KEY = 'sl.monitoreo.vista';
let feedCurrentView = 'feed';

function feedReadSavedView() {
  try {
    return window.localStorage.getItem(FEED_VIEW_KEY) === 'tabla' ? 'tabla' : 'feed';
  } catch (err) {
    return 'feed';
  }
}

function feedSaveView(view) {
  try {
    window.localStorage.setItem(FEED_VIEW_KEY, view);
  } catch (err) {
    // Sin almacenamiento la vista igual cambia; solo no queda guardada.
  }
}

// -------------------------------------------------------------------------
// Textos de la tarjeta, con el formato de la maqueta.
// -------------------------------------------------------------------------

// 4,8 k / 15 k / 1,2 M. Sin dato va "—", nunca 0 (likes ocultos por el autor).
function feedCount(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return '—';
  if (n >= 999500) return `${(n / 1e6).toFixed(1).replace('.', ',')} M`;
  if (n >= 1e3) {
    const k = n / 1e3;
    return `${k.toFixed(k >= 9.95 ? 0 : 1).replace('.', ',')} k`;
  }
  return String(n);
}

// feedAgo y feedImageUrl están en postView.js (compartido con el inicio).

// -------------------------------------------------------------------------
// Recuadro de la imagen.
// -------------------------------------------------------------------------
// Un posteo sin tipo detectado no lleva etiqueta de tipo.
const FEED_TYPE_LABELS = { reel: 'Reel', imagen: 'Imagen', carrusel: 'Carrusel' };
const FEED_REACH_LABELS = { alto: 'Alcance alto', medio: 'Alcance medio', bajo: 'Alcance bajo' };

// Se intentó bajar la foto y no quedó ninguna copia (el link de Instagram
// venció o la imagen no se aceptó): la tarjeta y el pop-up avisan "Imagen no
// disponible". Si nunca se intentó (posteo viejo, respuesta sin link de
// imagen) o quedó pendiente de reintentar (status "pendiente") es un posteo
// que todavía no tiene foto: los dos dicen "Sin foto".
function feedImageFailed(post) {
  const image = post.image;
  return Boolean(image && !image.thumbUrl && (image.status === 'vencido' || image.status === 'error'));
}

// La misma X de la fila de la tabla (columna de ignorar en monitoring.js).
const FEED_IGNORE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function feedNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// El recuadro es siempre el mismo cuadrado (.feed-media en styles.css): con
// foto, la miniatura entera sobre fondo negro; sin foto, rayado y con su
// texto.
function buildFeedMedia(post, reach) {
  const media = feedNode('div', 'feed-media');

  // Recuadro rayado con el texto, en lugar de la foto.
  const showEmpty = (text, img) => {
    media.classList.add('empty');
    const msg = feedNode('span', 'feed-media-msg', text);
    if (img) img.replaceWith(msg);
    else media.appendChild(msg);
  };

  const imageUrl = feedImageUrl(post);
  if (imageUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy'; // con el scroll pueden llegar a ser cientos de tarjetas
    img.decoding = 'async';
    // La foto abre el pop-up con un clic. Una imagen se puede arrastrar: si
    // el mouse se movía un poco entre apretar y soltar, el navegador
    // empezaba a arrastrarla y el clic no llegaba.
    img.draggable = false;
    // La copia guardada no se pudo mostrar (falta el archivo, se cortó la
    // red): se avisa en vez de dejar el ícono de imagen rota.
    img.addEventListener('error', () => showEmpty('Imagen no disponible', img));
    img.src = imageUrl;
    media.appendChild(img);
  } else {
    showEmpty(feedImageFailed(post) ? 'Imagen no disponible' : 'Sin foto', null);
  }

  const typeLabel = FEED_TYPE_LABELS[post.post_type];
  if (typeLabel) media.appendChild(feedNode('span', 'feed-badge type', typeLabel));
  // Alcance alto: la razón arriba a la derecha, "1,56× se despegó" (la razón
  // lleva colchón: no es "N veces lo habitual"). El medidor va en el pie
  // (buildFeedFoot).
  if (reach && reach.level === 'alto') {
    const hot = feedNode('span', 'feed-badge hot', `${formatBenchmarkRatio(reach.ratio)}× se despegó`);
    hot.title = `Razón de alcance por ${reach.label}: ${benchmarkRatioBasis(reach.metric)}`;
    media.appendChild(hot);
  }
  return media;
}

// -------------------------------------------------------------------------
// Tarjeta. Todo dato del posteo entra por textContent (título, texto y
// cuenta vienen de Instagram: nunca se insertan como HTML).
// -------------------------------------------------------------------------
function buildFeedHead(post) {
  const head = feedNode('div', 'feed-head');
  const account = post.account && post.account !== 'N/D' ? post.account : null;

  const avatar = feedNode('div', 'feed-av', account ? account[0].toUpperCase() : '?');
  avatar.style.background = accountColor(account);
  avatar.setAttribute('aria-hidden', 'true');

  const who = feedNode('div', 'feed-who');
  const name = feedNode('b', '', account ? `@${account}` : 'N/D');
  name.title = name.textContent; // entero al pasar el mouse, si quedó cortado
  who.append(name, feedNode('small', '', `${feedCount(post.followers)} seguidores`));

  const when = feedNode('span', 'feed-when', feedAgo(post.posted_at));
  const { date, time } = formatFullDateTime(post.posted_at);
  when.title = time ? `${date} · ${time}` : date;

  // El clic lo atiende el contenedor (ver "Acciones de la tarjeta").
  const ignore = feedNode('button', 'ico del');
  ignore.type = 'button';
  ignore.title = 'Ignorar publicación';
  ignore.setAttribute('aria-label', 'Ignorar publicación');
  ignore.innerHTML = FEED_IGNORE_ICON;

  head.append(avatar, who, when, ignore);
  return head;
}

// Solo el título. El texto del posteo no va en la tarjeta: se lee entero en
// el pop-up.
function buildFeedBody(post) {
  const body = feedNode('div', 'feed-body');
  body.appendChild(feedNode('h3', 'feed-title', post.title || '(sin clasificar)'));
  return body;
}

// Íconos de las dos métricas (corazón y globo de comentario).
const FEED_METRIC_ICONS = {
  likes:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.5 3.6 12.3a5.2 5.2 0 0 1 7.4-7.4l1 1 1-1a5.2 5.2 0 0 1 7.4 7.4z"/></svg>',
  comments:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3.5h14A2.5 2.5 0 0 1 21.5 6v9a2.5 2.5 0 0 1-2.5 2.5h-8.2L6 21.5v-4H5A2.5 2.5 0 0 1 2.5 15V6A2.5 2.5 0 0 1 5 3.5z"/></svg>',
};

// Una métrica, bien a la vista: ícono y número grande. "kind" es likes o
// comments. La razón del alcance ("1,10×", la que decidió la etiqueta) va
// chica, al lado del número de esa métrica, en coral si es alto. No es
// valor / mediana (lleva colchón): al pasar el mouse dice con qué se
// calculó.
function buildFeedMetric(kind, label, value, reach) {
  const metric = feedNode('span', `feed-metric ${kind}`);
  metric.title = label;
  // Constante propia, no un dato del posteo: se puede insertar como HTML.
  metric.insertAdjacentHTML('beforeend', FEED_METRIC_ICONS[kind]);
  metric.appendChild(feedNode('b', '', feedCount(value)));
  if (reach && reach.by === kind) {
    const x = feedNode('span', `feed-x${reach.level === 'alto' ? ' up' : ''}`, `${formatBenchmarkRatio(reach.ratio)}×`);
    x.title = `Razón de alcance por ${reach.label}: ${benchmarkRatioBasis(reach.metric)}`;
    metric.appendChild(x);
  }
  return metric;
}

// Franja propia de likes y comentarios, arriba del pie. A la derecha, chica,
// la fecha de esos números ("al 08/10", ver postMetricsDate en
// monitoring.js): en naranja si tienen más de 3 días. Va en el mismo
// renglón: no le suma alto a la tarjeta (styles.css).
function buildFeedMetrics(post, reach) {
  const metrics = feedNode('div', 'feed-metrics');
  metrics.append(buildFeedMetric('likes', 'Likes', post.likes, reach), buildFeedMetric('comments', 'Comentarios', post.comments, reach));
  const when = postMetricsDate(post);
  if (when) {
    const date = feedNode('span', `feed-metrics-date${when.stale ? ' stale' : ''}`, `al ${when.short}`);
    date.title = `Métricas al ${when.full}${when.stale ? ` (hace más de ${METRICS_STALE_DAYS} días)` : ''}`;
    metrics.appendChild(date);
  }
  return metrics;
}

// Pie: arriba el motivo (cortado con "…") y "Abrir ↗"; abajo el selector de
// sentimiento y, al lado, el medidor de alcance (buildReachMeter de
// monitoring.js). Son dos renglones,
// igual que antes: el medidor no le suma alto a la tarjeta (styles.css).
function buildFeedFoot(post, reach) {
  const foot = feedNode('div', 'feed-foot');

  const why = feedNode('span', 'feed-why');
  const { text, term } = postReasonParts(post.matched_reason);
  why.append(term ? `${text} ` : text);
  if (term) why.appendChild(feedNode('code', '', term));
  why.title = post.matched_reason || '';

  // El mismo selector de la tabla; el cambio lo atiende el contenedor (ver
  // "Acciones de la tarjeta").
  const sentiment = buildSentimentSelect(post.sentiment);
  sentiment.setAttribute('aria-label', 'Sentimiento');

  // El posteo en Instagram, en otra pestaña.
  const open = feedNode('a', '', 'Abrir ↗');
  open.href = post.url;
  open.target = '_blank';
  open.rel = 'noopener';

  foot.append(why, open, sentiment, buildReachMeter(reach));
  return foot;
}

function buildFeedCard(post, reach) {
  const card = feedNode('article', 'feed-card');
  card.dataset.id = post.id;
  // Color del borde de arriba (ver .feed-card[data-s] en styles.css).
  card.dataset.s = post.sentiment || SENTIMENT_UNSET;
  // Toda la tarjeta abre el pop-up del posteo (ver "Acciones de la tarjeta").
  // Con el teclado se llega a ella con Tab y se abre con Enter o Espacio.
  card.tabIndex = 0;
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'cuenta sin identificar';
  card.setAttribute('aria-label', `Posteo de ${account}: abrir el detalle`);
  card.append(buildFeedHead(post), buildFeedMedia(post, reach), buildFeedBody(post), buildFeedMetrics(post, reach), buildFeedFoot(post, reach));
  return card;
}

// -------------------------------------------------------------------------
// Orden. La tabla ordena por encabezado; el feed, con el selector de la barra
// (que solo se ve en esta vista). Lo que no tiene dato va al final, y a
// igualdad queda primero lo más reciente.
// -------------------------------------------------------------------------
function feedDescending(a, b) {
  const aMissing = a === null || a === undefined || !Number.isFinite(Number(a));
  const bMissing = b === null || b === undefined || !Number.isFinite(Number(b));
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  return Number(b) - Number(a);
}

function feedSorter(order, reachById) {
  // posted_at es ISO 8601: ordena bien como texto (igual que en la tabla).
  const recent = (a, b) => {
    const pa = a.posted_at || '';
    const pb = b.posted_at || '';
    return pa < pb ? 1 : pa > pb ? -1 : 0;
  };
  // "Mayor alcance": primero la etiqueta (alto, medio, bajo) y, dentro de
  // cada una, la razón que la decidió (postReach trae las dos). La etiqueta
  // va primero porque no depende solo de la razón: una métrica puede pasar
  // el corte de alto sin llegar a su piso. Sin etiqueta, al final.
  const level = (post) => {
    const reach = reachById.get(post.id);
    return reach ? REACH_LEVELS.indexOf(reach.level) : null;
  };
  const ratio = (post) => (reachById.get(post.id) || {}).ratio;
  if (order === 'reach') {
    return (a, b) => feedDescending(level(a), level(b)) || feedDescending(ratio(a), ratio(b)) || recent(a, b);
  }
  if (order === 'likes') return (a, b) => feedDescending(a.likes, b.likes) || recent(a, b);
  if (order === 'comments') return (a, b) => feedDescending(a.comments, b.comments) || recent(a, b);
  return recent;
}

// -------------------------------------------------------------------------
// Dibujo. Se rehace entero cada vez que cambian los datos, los filtros o el
// orden (monitoring.js avisa por monitoringViewListeners, ver
// scheduleFeedRender). Solo si el feed es la vista elegida: en la vista
// Tabla no se arma ninguna tarjeta.
//
// Scroll infinito: primero van FEED_ROWS_STEP filas (según cuántas columnas
// tiene la grilla de verdad) y, al acercarse al final del feed, se suman
// solas otras tantas (feedFill, más abajo), hasta terminar la lista. Sin
// botón, sin contador y sin cartel de fin: cuando no hay más, sigue el pie.
// Con otros filtros u otro orden se vuelve a las primeras filas; un redibujo
// de la misma lista (ignorar, datos nuevos) conserva las ya sumadas.
// -------------------------------------------------------------------------
let feedRenderTimer = null;
// Filtros y orden del último dibujo. Si el siguiente llega con otros, la
// lista es otra y hay que mostrarla desde su principio (ver
// feedScrollToStart); si son los mismos (llegaron datos nuevos), la página
// se queda donde está. null: todavía no se dibujó desde que se entró al feed.
let feedLastQuery = null;
// Los ids de toda la lista del feed (filtrada y ordenada), no solo de las
// tarjetas a la vista: el pop-up abierto desde una tarjeta la recorre
// entera.
let feedVisibleIds = [];
// La misma lista, con los posteos y su alcance: de acá salen las tarjetas
// que suma el scroll, sin volver a leer ni a ordenar la tabla.
let feedList = [];
let feedReachById = new Map();
// Cuántas tarjetas hay dibujadas: las primeras feedShown de feedList.
let feedShown = 0;
const FEED_ROWS_STEP = 3;
let feedRows = FEED_ROWS_STEP;
// Columnas del último dibujo: si cambian (otro ancho de ventana), se rehace.
let feedLastColumns = 0;

// Cuántas columnas tiene la grilla del feed (auto-fill de 240 px).
function feedColumns() {
  const template = getComputedStyle(feedContainerEl).gridTemplateColumns;
  return Math.max(1, template.split(' ').filter((part) => part.endsWith('px')).length);
}

// El alto de cada tarjeta dibujada como lo pide contain-intrinsic-height: sin
// los bordes y con decimales (redondeado, la diferencia de cada fila se
// sumaba).
function feedCardHeights() {
  const cards = [...feedContainerEl.querySelectorAll('.feed-card')];
  if (!cards.length) return [];
  const style = getComputedStyle(cards[0]);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  return cards.map((card) => card.getBoundingClientRect().height - borders);
}

// "fill": false solo desde setFeedView, que primero vuelve al principio de
// los resultados y después completa (ver feedFill).
function renderFeed({ fill = true } = {}) {
  clearTimeout(feedRenderTimer);
  feedRenderTimer = null;
  if (feedCurrentView !== 'feed' || !monitoringTable) return;
  const query = JSON.stringify([readFilterValues(), feedOrderEl.value]);
  const listChanged = feedLastQuery !== null && query !== feedLastQuery;
  if (listChanged) feedRows = FEED_ROWS_STEP;
  feedLastQuery = query;
  // Los posteos a mostrar son las filas "activas" de la tabla: las que dejó
  // pasar la barra de filtros la última vez que se aplicó (applyFilters, con
  // postMatchesFilters). El feed no vuelve a filtrar por su cuenta: así
  // muestra siempre lo mismo que la tabla y que el contador "Mostrando N de
  // M", también cuando queda en pantalla un posteo que dejó de cumplir el
  // filtro (un sentimiento recién corregido se queda hasta que se vuelva a
  // filtrar; reordenar o cambiar de vista no lo saca). getData devuelve un
  // arreglo nuevo: ordenarlo acá no toca el orden de la tabla.
  const visible = monitoringTable.getData('active');
  const reachById = new Map(visible.map((post) => [post.id, postReach(post)]));
  visible.sort(feedSorter(feedOrderEl.value, reachById));
  feedVisibleIds = visible.map((post) => String(post.id));
  feedList = visible;
  feedReachById = reachById;

  const columns = feedColumns();
  // Un redibujo de la misma lista (ignorar, un tono corregido, datos nuevos)
  // rehace todas las tarjetas, y las que quedan lejos de la pantalla tienen
  // un alto estimado (content-visibility en styles.css): las de arriba se
  // estiraban o se achicaban y la página se corría, decenas de píxeles por
  // fila. Cada lugar de la grilla arranca con el alto que tenía; cuando su
  // tarjeta se dibuja, toma el suyo.
  const keepHeights = !listChanged && columns === feedLastColumns ? feedCardHeights() : [];
  feedLastColumns = columns;
  const shown = visible.slice(0, columns * feedRows);
  feedShown = shown.length;

  const fragment = document.createDocumentFragment();
  shown.forEach((post, i) => {
    const card = buildFeedCard(post, reachById.get(post.id));
    if (keepHeights[i]) card.style.containIntrinsicHeight = `auto ${keepHeights[i]}px`;
    fragment.appendChild(card);
  });
  if (!visible.length) {
    // "No hay publicaciones con esos filtros", o el período vacío con el
    // enlace al siguiente (buildEmptyListLine en monitoring.js).
    const empty = feedNode('div', 'feed-empty');
    empty.appendChild(buildEmptyListLine());
    fragment.appendChild(empty);
  }
  feedContainerEl.replaceChildren(fragment);
  // Primero de vuelta al principio de la lista nueva y recién después, si
  // falta, más filas: al revés, con la página bajada, se sumaban tandas
  // antes de volver y no quedaban las primeras filas.
  if (listChanged) feedScrollToStart();
  if (fill) feedFill();
  feedUpdateTopButton();
}

// Los avisos de monitoring.js llegan de a uno por tecla del buscador. Rehacer
// cientos de tarjetas en cada tecla traba la escritura: se espera una pausa
// corta y se dibuja una sola vez. La primera vez (feed todavía vacío) se
// dibuja en el momento.
const FEED_RENDER_DELAY_MS = 150;

function scheduleFeedRender() {
  if (!feedContainerEl.firstChild) {
    renderFeed();
    return;
  }
  clearTimeout(feedRenderTimer);
  feedRenderTimer = setTimeout(renderFeed, FEED_RENDER_DELAY_MS);
}

// -------------------------------------------------------------------------
// Scroll infinito. Al acercarse al final del feed se suma otra tanda de
// filas (FEED_ROWS_STEP × columnas) al final: solo las tarjetas nuevas, sin
// rehacer las que ya están ni mover la página. En una pantalla alta se suman
// tandas hasta llenarla o terminar la lista.
// -------------------------------------------------------------------------
const feedTabEl = document.getElementById('tab-monitoring');
const feedReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Otra tanda cuando al borde de abajo del feed le falta menos de esta
// cantidad de pantallas para entrar a la vista.
const FEED_AHEAD_SCREENS = 1;
// Seguro por llamada: una pantalla muy alta se llena en pocas tandas; si algo
// midiera mal, no se dibuja la lista entera de un saque.
const FEED_MAX_BATCHES = 20;
// Las tarjetas nuevas entran subiendo y escalonadas, como las .rv, con techo.
const FEED_RISE_STEP_MS = 35;
const FEED_RISE_MAX_MS = 300;

// El feed se ve: es la vista elegida y la solapa Monitoreo está abierta.
// Oculta, la solapa sigue en el layout (invisible: ver
// #tab-monitoring.tab-panel.hidden en styles.css) y el feed mide como si se
// viera, así que hay que mirar la clase.
function feedOnScreen() {
  return feedCurrentView === 'feed' && !(feedTabEl && feedTabEl.classList.contains('hidden'));
}

// Otra tanda al final: las tarjetas de feedList que faltan para completar
// feedRows filas. Entran con feed-rise (styles.css), salvo con movimiento
// reducido.
function feedAppendRows(columns) {
  feedRows += FEED_ROWS_STEP;
  const next = feedList.slice(feedShown, columns * feedRows);
  const animate = !feedReducedMotion.matches;
  const fragment = document.createDocumentFragment();
  next.forEach((post, i) => {
    const card = buildFeedCard(post, feedReachById.get(post.id));
    if (animate) {
      card.classList.add('feed-rise');
      card.style.animationDelay = `${Math.min(i * FEED_RISE_STEP_MS, FEED_RISE_MAX_MS)}ms`;
    }
    fragment.appendChild(card);
  });
  feedContainerEl.appendChild(fragment);
  feedShown += next.length;
}

// Suma tandas mientras el final del feed esté cerca y queden posteos. No
// hace nada si el feed no se ve, si hay un redibujo completo en espera (al
// terminar vuelve a llamar acá) o si cambió la cantidad de columnas (el
// redibujo que pide "resize" completa las filas).
function feedFill() {
  if (!feedOnScreen() || feedRenderTimer !== null) return;
  const columns = feedColumns();
  if (columns !== feedLastColumns) return;
  for (let i = 0; i < FEED_MAX_BATCHES && feedShown < feedList.length; i += 1) {
    if (feedContainerEl.getBoundingClientRect().bottom > window.innerHeight * (1 + FEED_AHEAD_SCREENS)) break;
    feedAppendRows(columns);
  }
}

// Terminada la entrada, la tarjeta vuelve a ser como las demás: sin la clase
// vuelven el hover (que también usa transform) y el aro de "flash", y no
// queda en una capa propia.
function feedRiseDone(e) {
  const card = e.target;
  if (e.animationName !== 'rise' || !card.classList.contains('feed-rise')) return;
  card.classList.remove('feed-rise');
  card.style.animationDelay = '';
}
feedContainerEl.addEventListener('animationend', feedRiseDone);
feedContainerEl.addEventListener('animationcancel', feedRiseDone);

// -------------------------------------------------------------------------
// "Volver arriba" (#feedTop en instagram.html): aparece cuando la página
// bajó más allá del comienzo del feed, solo con el feed a la vista (vista
// Feed, solapa Monitoreo), y lleva al tope de la página. No gasta ni
// modifica nada.
// -------------------------------------------------------------------------
const feedTopEl = document.getElementById('feedTop');

function feedUpdateTopButton() {
  if (!feedTopEl) return;
  const show = feedOnScreen() && feedShown > 0 && feedContainerEl.getBoundingClientRect().top < feedBarBottom();
  feedTopEl.classList.toggle('on', show);
}

if (feedTopEl) {
  feedTopEl.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: feedReducedMotion.matches ? 'auto' : 'smooth' });
    // Arriba el botón se esconde: el foco pasa a la solapa elegida de la
    // barra superior (si no, caía en <body>) y el Tab sigue desde ahí.
    const tab = document.querySelector('nav.tabs [role="tab"][aria-selected="true"]');
    if (tab) tab.focus({ preventScroll: true });
  });
}

// Se mira con el scroll (el navegador lo avisa como mucho una vez por
// cuadro), con otro tamaño de ventana y cuando se abre o se cierra la solapa
// (main.js le cambia la clase; así también cuando se abre sin mover la
// página, como desde #publicacion-<id>).
function feedCheckScroll() {
  feedFill();
  feedUpdateTopButton();
}
window.addEventListener('scroll', feedCheckScroll, { passive: true });
if (feedTabEl) new MutationObserver(feedCheckScroll).observe(feedTabEl, { attributes: true, attributeFilter: ['class'] });

// -------------------------------------------------------------------------
// Interruptor Tabla / Feed.
// -------------------------------------------------------------------------
function setFeedView(view, { save = true } = {}) {
  feedCurrentView = view === 'feed' ? 'feed' : 'tabla';
  const isFeed = feedCurrentView === 'feed';

  for (const button of feedViewSegEl.querySelectorAll('button[data-view]')) {
    const on = button.dataset.view === feedCurrentView;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  feedTableWrapEl.classList.toggle('hidden', isFeed);
  feedContainerEl.classList.toggle('hidden', !isFeed);
  // "Orden" es del feed: en la tabla se ordena con el encabezado de cada
  // columna. Queda a la vista, deshabilitado y con el aviso.
  feedOrderEl.disabled = !isFeed;
  if (feedOrderWrapEl) {
    if (isFeed) {
      delete feedOrderWrapEl.dataset.tipTitle;
      delete feedOrderWrapEl.dataset.tip;
    } else {
      feedOrderWrapEl.dataset.tipTitle = 'Orden de la tabla';
      feedOrderWrapEl.dataset.tip = 'En la tabla se ordena con el encabezado de cada columna.';
    }
  }

  if (isFeed) {
    renderFeed({ fill: false });
  } else {
    feedContainerEl.replaceChildren();
    feedLastQuery = null;
    feedList = [];
    feedShown = 0;
    // Al volver al feed se arranca de las primeras filas.
    feedRows = FEED_ROWS_STEP;
    // La tabla pudo armarse o cambiar mientras estaba oculta: Tabulator
    // necesita redibujarse al volver a verse para calcular bien los anchos.
    if (monitoringTable) monitoringTable.redraw(true);
  }
  if (save) {
    feedSaveView(feedCurrentView);
    // Lo eligió el usuario (no es la vista recordada al entrar): los
    // resultados son otros y se muestran desde su principio.
    feedScrollToStart(isFeed ? feedContainerEl : feedTableWrapEl);
  }
  // Recién ahora, ya en el principio, las filas que falten para llenar la
  // pantalla.
  if (isFeed) feedFill();
  feedUpdateTopButton();
}

feedViewSegEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (button) setFeedView(button.dataset.view);
});

// -------------------------------------------------------------------------
// Acciones de la tarjeta: las mismas de la fila de la tabla, con los mismos
// endpoints (updateSentiment y openIgnoreModal / confirmIgnore de
// monitoring.js). Se atienden en el contenedor y no tarjeta por tarjeta: son
// cientos y se rehacen con cada filtro.
// -------------------------------------------------------------------------
function feedCardById(id) {
  return feedContainerEl.querySelector(`.feed-card[data-id="${CSS.escape(String(id))}"]`);
}

// La fila de Tabulator del posteo de una tarjeta: de ahí sale el id tal como
// vino del backend (data-id es siempre texto) y ahí se actualiza el dato.
function feedRowOf(card) {
  return (monitoringTable && monitoringTable.getRow(card.dataset.id)) || null;
}

// Corrige el sentimiento del posteo de una tarjeta. "select" es el selector
// que se tocó: el de la tarjeta o el del pop-up (monitoringFeedPopup.js).
function feedSetSentiment(card, sentiment, select) {
  const row = feedRowOf(card);
  // PATCH y color de la pastilla, igual que en la tabla.
  updateSentiment(row ? row.getData().id : card.dataset.id, sentiment, select);
  card.dataset.s = sentiment; // borde de arriba de la tarjeta
  // También el dato de la tabla: de ahí se vuelve a dibujar el feed y es lo
  // que leen los filtros y "Se despegaron".
  if (row) row.update({ sentiment });
  if (monitoringTable) renderHighlightCards(monitoringTable.getData());
  // El panel (tono de las fuentes, KPI) y el flujo, al día; el feed se
  // rehace con el color nuevo.
  notifyMonitoringViews();
}

feedContainerEl.addEventListener('change', (e) => {
  const select = e.target.closest('select.sentiment-select');
  const card = select && select.closest('.feed-card');
  if (!card || select.value === SENTIMENT_UNSET) return;
  feedSetSentiment(card, select.value, select);
});

// Controles con acción propia dentro de la tarjeta: la ✕ de ignorar, el
// selector de sentimiento y "Abrir ↗". Un clic en ellos no abre el pop-up.
const FEED_CARD_CONTROLS = 'a, button, select, input, textarea, label';

// Hay texto de la tarjeta marcado: se soltó el mouse después de arrastrar
// para seleccionarlo. Eso también llega como un clic, y no tiene que abrir
// nada (si no, no se podría copiar un título).
function feedSelectingIn(card) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  return card.contains(selection.anchorNode) || card.contains(selection.focusNode);
}

feedContainerEl.addEventListener('click', (e) => {
  const card = e.target.closest('.feed-card');
  if (!card) return;
  if (e.target.closest('.feed-head .ico.del')) {
    const row = feedRowOf(card);
    // El mismo cartel de confirmación; al aceptar, confirmIgnore saca la fila
    // de la tabla y avisa acá con { ignoredId } (ver onMonitoringChange).
    openIgnoreModal(row ? row.getData().id : card.dataset.id);
    return;
  }
  // Un clic en cualquier otro lado de la tarjeta abre el pop-up del posteo
  // (monitoringFeedPopup.js).
  if (e.target.closest(FEED_CARD_CONTROLS) || feedSelectingIn(card)) return;
  openFeedPop(card);
});

// Lo mismo con el teclado: Enter o Espacio con el foco en la tarjeta. Con el
// foco en uno de sus controles, la tecla es de ese control. Una tecla que se
// mantiene apretada no vuelve a abrirlo.
feedContainerEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
  if (!e.target.matches('.feed-card')) return;
  e.preventDefault(); // Espacio no baja la página
  openFeedPop(e.target);
});

// Se ignoró un posteo: el feed se rehace con las mismas filas (la que sigue
// ocupa su lugar). Si era la última queda el cartel de "no hay". El pop-up,
// si estaba abierto, ya pasó al siguiente de su lista
// (monitoringFeedPopup.js).
function removeFeedCard() {
  renderFeed();
}

// Con otro ancho la grilla puede tener otra cantidad de columnas: las filas
// se vuelven a completar. Con otro alto puede faltar otra tanda.
window.addEventListener('resize', () => {
  if (feedCurrentView === 'feed' && feedContainerEl.firstChild && feedColumns() !== feedLastColumns) scheduleFeedRender();
  feedCheckScroll();
});

// Hasta dónde tapa la barra superior, que en escritorio queda fija arriba al
// bajar (en celular va en su lugar y no tapa nada).
function feedBarBottom() {
  const top = document.querySelector('header.top');
  if (!top) return 0;
  const position = getComputedStyle(top).position;
  return position === 'sticky' || position === 'fixed' ? top.offsetHeight : 0;
}

// Deja la tarjeta justo debajo de la barra superior. De un salto, sin
// animar: las tarjetas que todavía no se dibujaron tienen un alto estimado y
// un scroll animado caería en otro lado.
function feedScrollToCard(card) {
  window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - feedBarBottom() - 12 });
}

// Si se cambia un filtro, el orden o la vista con la página más abajo que el
// principio de los resultados ("el": el feed o la tabla), se vuelve ahí: sin
// esto se quedaba mirando la mitad de la lista nueva, o su final si era más
// corta. Si el principio ya está a la vista, la página no se mueve.
function feedScrollToStart(el = feedContainerEl) {
  const top = el.getBoundingClientRect().top;
  const limit = feedBarBottom() + 12;
  if (top < limit) window.scrollTo({ top: top + window.scrollY - limit });
}

// Tarjeta a la que lleva un destacado de "Se despegaron" cuando el feed es la
// vista activa. Igual que en la tabla, no toca los filtros: si el posteo
// quedó tapado por uno, no hace nada.
function feedGoToCard(id) {
  if (feedCurrentView !== 'feed') return false;
  if (feedRenderTimer !== null) renderFeed(); // había un redibujo en espera
  const card = feedCardById(id);
  if (!card) return true;
  feedScrollToCard(card);
  // Al llegar se dibujan las tarjetas de alrededor con su alto real y la
  // posición puede correrse unos píxeles: se acomoda una vez más.
  setTimeout(() => {
    if (card.isConnected) feedScrollToCard(card);
  }, 80);
  card.classList.remove('flash');
  void card.offsetWidth; // reinicia la animación si ya había corrido
  card.classList.add('flash');
  return true;
}

// Aviso de monitoring.js (ver monitoringViewListeners).
function onMonitoringChange(change) {
  // Los avisos de "Actualizar ahora" y de la config no son para el feed: se
  // redibuja con el aviso de los datos nuevos, que llega aparte.
  if (change && (change.run || 'config' in change)) return false;
  if (change && change.goToId !== undefined) return feedGoToCard(change.goToId);
  if (change && change.ignoredId !== undefined) {
    removeFeedCard(change.ignoredId);
    return false;
  }
  scheduleFeedRender();
  return false;
}

monitoringViewListeners.push(onMonitoringChange);

// Al entrar: la última vista elegida. Los posteos todavía no llegaron; el
// feed se dibuja cuando monitoring.js avisa que ya hay datos.
setFeedView(feedReadSavedView(), { save: false });
