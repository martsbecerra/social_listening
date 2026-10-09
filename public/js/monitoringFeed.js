// --------------------------------------------------------------------
// Vista "Feed" de la solapa Monitoreo en vivo de Instagram: las mismas
// publicaciones y los mismos filtros que la tabla, en tarjetas. Calcado de
// design/monitoreo-feed.html (estilos en public/css/styles.css, clases
// feed-*).
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
const feedTableWrapEl = document.getElementById('monitoringTable').closest('.tbl-wrap');

// Última vista elegida. localStorage puede no estar (modo privado,
// almacenamiento bloqueado): en ese caso vale la tabla y no se recuerda nada.
const FEED_VIEW_KEY = 'sl.monitoreo.vista';
let feedCurrentView = 'tabla';

function feedReadSavedView() {
  try {
    return window.localStorage.getItem(FEED_VIEW_KEY) === 'feed' ? 'feed' : 'tabla';
  } catch (err) {
    return 'tabla';
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

// "hace 30 min" / "hace 5 h" / "hace 3 días", desde la fecha de publicación.
// La unidad se elige con el número ya redondeado: 59,6 minutos es "hace 1 h"
// y 23,6 horas es "hace 1 día", nunca "hace 60 min" ni "hace 24 h".
function feedAgo(iso) {
  const hours = iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : NaN;
  if (!Number.isFinite(hours)) return 'N/D';
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 60) return `hace ${minutes} min`;
  const wholeHours = Math.round(hours);
  if (wholeHours < 24) return `hace ${wholeHours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

// Motivo corto para el pie de la tarjeta, a partir de matched_reason (lo arma
// src/monitor.js): "búsqueda <término>", "palabra clave <término>" o "cuenta
// trackeada". Lo que viene después de " · " es el motivo del clasificador y
// no entra acá. Una forma desconocida se muestra tal cual.
function feedReasonParts(reason) {
  const base = String(reason || '').split(' · ')[0].trim();
  let match = base.match(/^Búsqueda:\s*(.+?)(?:\s+\(|\s+—\s|$)/);
  if (match) return { text: 'búsqueda', term: match[1] };
  match = base.match(/^Coincidencia con palabra clave:\s*"?(.+?)"?$/);
  if (match) return { text: 'palabra clave', term: match[1] };
  if (base.startsWith('Cuenta trackeada')) return { text: 'cuenta trackeada', term: null };
  return { text: base, term: null };
}

// -------------------------------------------------------------------------
// Recuadro de la imagen.
// -------------------------------------------------------------------------
// Un posteo sin tipo detectado no lleva etiqueta de tipo.
const FEED_TYPE_LABELS = { reel: 'Reel', imagen: 'Imagen', carrusel: 'Carrusel' };
const FEED_REACH_LABELS = { alto: 'Alcance alto', medio: 'Alcance medio', bajo: 'Alcance bajo' };
// Colores del avatar de la maqueta. El color sale del nombre de la cuenta,
// así cada cuenta se ve siempre igual.
const FEED_PALETTE = ['#12805f', '#c4522c', '#2f6f9e', '#8a5a10', '#6b4c8f', '#a8324f', '#4f7a3a', '#3f6f6a'];

function feedHash(text) {
  let hash = 7;
  for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash;
}

// Foto del posteo. El listado manda `image` (src/postImageRoutes.js):
// thumbUrl y fullUrl, las direcciones de las dos copias guardadas en el
// servidor (null si no hay), y status, cómo salió el último intento de
// bajarla. El frontend lee ese dato en tres puntos: acá, en feedImageFailed
// (abajo) y en feedPopImageUrl (pop-up). La tarjeta usa la miniatura y el
// pop-up la imagen grande.
function feedImageUrl(post) {
  return (post.image && post.image.thumbUrl) || null;
}

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
    img.loading = 'lazy'; // son cientos de tarjetas sin paginar
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
  // Sin referencia en ninguna de las dos métricas no hay etiqueta de alcance.
  if (reach) media.appendChild(feedNode('span', `feed-badge reach ${reach.level}`, FEED_REACH_LABELS[reach.level]));
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
  avatar.style.background = FEED_PALETTE[feedHash(account) % FEED_PALETTE.length];
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
// comments. La razón contra la mediana de la cuenta ("5,4×") va chica, al
// lado del número que disparó la etiqueta de alcance, en coral si es alto.
function buildFeedMetric(kind, label, value, reach) {
  const metric = feedNode('span', `feed-metric ${kind}`);
  metric.title = label;
  // Constante propia, no un dato del posteo: se puede insertar como HTML.
  metric.insertAdjacentHTML('beforeend', FEED_METRIC_ICONS[kind]);
  metric.appendChild(feedNode('b', '', feedCount(value)));
  if (reach && reach.by === kind) {
    const ratio = `${formatBenchmarkRatio(reach.ratio)}×`;
    const x = feedNode('span', `feed-x${reach.level === 'alto' ? ' up' : ''}`, ratio);
    x.title = `${ratio} la mediana de ${reach.label} de la cuenta`;
    metric.appendChild(x);
  }
  return metric;
}

// Franja propia de likes y comentarios, arriba del pie.
function buildFeedMetrics(post, reach) {
  const metrics = feedNode('div', 'feed-metrics');
  metrics.append(buildFeedMetric('likes', 'Likes', post.likes, reach), buildFeedMetric('comments', 'Comentarios', post.comments, reach));
  return metrics;
}

function buildFeedFoot(post) {
  const foot = feedNode('div', 'feed-foot');

  const why = feedNode('span', 'feed-why');
  const { text, term } = feedReasonParts(post.matched_reason);
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

  // El motivo ocupa su renglón; abajo, el selector y el enlace (styles.css).
  foot.append(why, sentiment, open);
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
  card.append(buildFeedHead(post), buildFeedMedia(post, reach), buildFeedBody(post), buildFeedMetrics(post, reach), buildFeedFoot(post));
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
  // "Mayor alcance": la mayor de las dos razones contra la mediana de la
  // cuenta (postReach ya la trae).
  const ratio = (post) => (reachById.get(post.id) || {}).ratio;
  if (order === 'reach') return (a, b) => feedDescending(ratio(a), ratio(b)) || recent(a, b);
  if (order === 'likes') return (a, b) => feedDescending(a.likes, b.likes) || recent(a, b);
  return recent;
}

// -------------------------------------------------------------------------
// Aviso de que cambia la lista de tarjetas. El pop-up del posteo
// (monitoringFeedPopup.js, que se carga después) se anota acá para no quedar
// mostrando un posteo que ya no está. "change" dice qué pasó:
//   (nada)         la lista ya cambió: se redibujó entera o salió una tarjeta.
//   { removing }   esa tarjeta está por salir (se ignoró su posteo) y todavía
//                  ocupa su lugar.
// -------------------------------------------------------------------------
const feedListListeners = [];

function notifyFeedList(change) {
  for (const listener of feedListListeners) listener(change);
}

// -------------------------------------------------------------------------
// Dibujo. Se rehace entero cada vez que cambian los datos, los filtros o el
// orden (monitoring.js avisa por monitoringViewListeners, ver
// scheduleFeedRender). Solo si el feed es la vista elegida: en la vista
// Tabla no se arma ninguna tarjeta.
// -------------------------------------------------------------------------
let feedRenderTimer = null;
// Filtros y orden del último dibujo. Si el siguiente llega con otros, la
// lista es otra y hay que mostrarla desde su principio (ver
// feedScrollToStart); si son los mismos (llegaron datos nuevos), la página
// se queda donde está. null: todavía no se dibujó desde que se entró al feed.
let feedLastQuery = null;

function renderFeed() {
  clearTimeout(feedRenderTimer);
  feedRenderTimer = null;
  if (feedCurrentView !== 'feed' || !monitoringTable) return;
  const query = JSON.stringify([readFilterValues(), feedOrderEl.value]);
  const listChanged = feedLastQuery !== null && query !== feedLastQuery;
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

  const fragment = document.createDocumentFragment();
  for (const post of visible) fragment.appendChild(buildFeedCard(post, reachById.get(post.id)));
  if (!visible.length) {
    fragment.appendChild(
      feedNode(
        'div',
        'feed-empty',
        monitoringTable.getDataCount() ? 'No hay publicaciones con esos filtros.' : 'Todavía no se detectó ningún posteo.'
      )
    );
  }
  feedContainerEl.replaceChildren(fragment);
  if (listChanged) feedScrollToStart();
  notifyFeedList();
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
  feedOrderEl.classList.toggle('hidden', !isFeed);

  if (isFeed) {
    renderFeed();
  } else {
    feedContainerEl.replaceChildren();
    feedLastQuery = null;
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
}

feedViewSegEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (button) setFeedView(button.dataset.view);
});
feedOrderEl.addEventListener('change', renderFeed);

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

// Se ignoró un posteo: sale solo su tarjeta, sin rehacer el resto (así la
// página no salta). Si era la última queda el cartel de "no hay".
function removeFeedCard(id) {
  const card = feedCardById(id);
  if (!card) return;
  // Antes de sacarla, mientras todavía ocupa su lugar: si el pop-up está
  // mostrando ese posteo, pasa al de la tarjeta de al lado.
  notifyFeedList({ removing: card });
  card.remove();
  // Si no quedó ninguna, el cartel de "no hay" (renderFeed ya avisa el cambio).
  if (!feedContainerEl.querySelector('.feed-card')) renderFeed();
  else notifyFeedList();
}

// Hasta dónde tapa la barra de filtros, que queda pegada arriba al bajar.
function feedBarBottom() {
  const bar = document.querySelector('.filters');
  return bar ? (parseFloat(getComputedStyle(bar).top) || 0) + bar.offsetHeight : 0;
}

// Deja la tarjeta justo debajo de la barra de filtros. De un salto, sin
// animar: las tarjetas que todavía no se dibujaron tienen un alto estimado y
// un scroll animado caería en otro lado.
function feedScrollToCard(card) {
  window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - feedBarBottom() - 12 });
}

// La barra de filtros queda pegada arriba, así que se puede filtrar, ordenar
// o cambiar de vista desde cualquier altura de la lista. Si se estaba más
// abajo que el principio de los resultados ("el": el feed o la tabla), se
// vuelve ahí: sin esto se quedaba mirando la mitad de la lista nueva, o su
// final si era más corta. Si el principio ya está a la vista, la página no
// se mueve.
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
