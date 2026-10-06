// --------------------------------------------------------------------
// Vista "Feed" de la solapa Monitoreo en vivo de Instagram: las mismas
// publicaciones y los mismos filtros que la tabla, en tarjetas. Calcado de
// design/monitoreo-feed.html (estilos en public/css/styles.css, clases
// feed-*).
//
// Lo carga SOLO instagram.html, después de monitoring.js, y se apoya en lo
// que ese archivo ya define: monitoringTable (la fuente de los posteos),
// readFilterValues / postMatchesFilters (los filtros de la barra), postReach
// (el alcance), buildSentimentSelect y los formateadores. x.html no lo
// carga: en X la solapa sigue siendo solo la tabla.
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
function feedAgo(iso) {
  const hours = iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : NaN;
  if (!Number.isFinite(hours)) return 'N/D';
  if (hours < 1) return `hace ${Math.max(0, Math.round(hours * 60))} min`;
  if (hours < 24) return `hace ${Math.round(hours)} h`;
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
const FEED_TYPE_LABELS = { reel: 'Reel', imagen: 'Imagen', carrusel: 'Carrusel' };
// Íconos de la maqueta, uno por post_type. Un posteo sin tipo detectado lleva
// el de imagen y ninguna etiqueta de tipo.
const FEED_TYPE_ICONS = {
  reel: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  imagen:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/></svg>',
  carrusel:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="6" y="4" width="13" height="16" rx="2.5"/><path d="M3 7v10"/><path d="M22 7v10"/></svg>',
};
const FEED_REACH_LABELS = { alto: 'Alcance alto', medio: 'Alcance medio', bajo: 'Alcance bajo' };
// Colores del avatar de la maqueta. El color del avatar y el tono del recuadro
// salen del nombre de la cuenta, así cada cuenta se ve siempre igual.
const FEED_PALETTE = ['#12805f', '#c4522c', '#2f6f9e', '#8a5a10', '#6b4c8f', '#a8324f', '#4f7a3a', '#3f6f6a'];

function feedHash(text) {
  let hash = 7;
  for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash;
}

// Imagen del posteo. Hoy el backend no guarda ni manda fotos, así que esto da
// siempre null y la tarjeta muestra el recuadro de reemplazo. Cuando el
// posteo traiga el dato alcanza con devolverlo acá: el resto ya está armado
// (carga diferida y aviso si la imagen no carga).
function feedImageUrl(post) {
  return post.image_url || null;
}

function feedNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildFeedMedia(post, reach) {
  const media = feedNode('div', 'feed-media');
  const hue = (feedHash(post.account) >>> 3) % 360;
  media.style.background = `linear-gradient(135deg, hsl(${hue}, 45%, 38%), hsl(${(hue + 40) % 360}, 50%, 58%))`;
  // Constante propia, no un dato del posteo: se puede insertar como HTML.
  media.insertAdjacentHTML('beforeend', FEED_TYPE_ICONS[post.post_type] || FEED_TYPE_ICONS.imagen);

  const imageUrl = feedImageUrl(post);
  if (imageUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy'; // son cientos de tarjetas sin paginar
    img.decoding = 'async';
    img.addEventListener('error', () => {
      // Las URLs de Instagram vencen: se avisa en vez de dejar el ícono roto.
      media.classList.add('broken');
      media.style.background = '';
      media.querySelector('svg')?.remove();
      img.replaceWith(feedNode('span', 'feed-media-msg', 'Imagen no disponible'));
    });
    img.src = imageUrl;
    media.appendChild(img);
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
  who.append(feedNode('b', '', account ? `@${account}` : 'N/D'), feedNode('small', '', `${feedCount(post.followers)} seguidores`));

  const when = feedNode('span', 'feed-when', feedAgo(post.posted_at));
  const { date, time } = formatFullDateTime(post.posted_at);
  when.title = time ? `${date} · ${time}` : date;

  head.append(avatar, who, when);
  return head;
}

function buildFeedBody(post) {
  const body = feedNode('div', 'feed-body');
  body.append(feedNode('h3', 'feed-title', post.title || '(sin clasificar)'), feedNode('p', 'feed-cap', post.caption || ''));
  return body;
}

// "♥ 4,8 k" / "💬 612". La razón contra la mediana de la cuenta ("5,4×") va al
// lado de la métrica que disparó la etiqueta de alcance, en coral si es alto.
function buildFeedMetric(symbol, label, value, reach, by) {
  const metric = feedNode('span', '', `${symbol} ${feedCount(value)}`);
  metric.title = label;
  if (reach && reach.by === by) {
    const ratio = `${formatBenchmarkRatio(reach.ratio)}×`;
    const x = feedNode('span', `feed-x${reach.level === 'alto' ? ' up' : ''}`, ratio);
    x.title = `${ratio} la mediana de ${reach.label} de la cuenta`;
    metric.append(' ', x);
  }
  return metric;
}

function buildFeedMetrics(post, reach) {
  const metrics = feedNode('div', 'feed-metrics');
  // El mismo selector de la tabla. Por ahora solo muestra el sentimiento.
  const sentiment = buildSentimentSelect(post.sentiment);
  sentiment.setAttribute('aria-label', 'Sentimiento');
  sentiment.disabled = true;
  metrics.append(
    buildFeedMetric('♥', 'Likes', post.likes, reach, 'likes'),
    buildFeedMetric('💬', 'Comentarios', post.comments, reach, 'comments'),
    sentiment
  );
  return metrics;
}

function buildFeedFoot(post) {
  const foot = feedNode('div', 'feed-foot');

  const why = feedNode('span', 'feed-why');
  const { text, term } = feedReasonParts(post.matched_reason);
  why.append(term ? `${text} ` : text);
  if (term) why.appendChild(feedNode('code', '', term));
  why.title = post.matched_reason || '';

  const open = feedNode('a', '', 'Abrir ↗');
  open.href = post.url;
  open.target = '_blank';
  open.rel = 'noopener';

  foot.append(why, open);
  return foot;
}

function buildFeedCard(post, reach) {
  const card = feedNode('article', 'feed-card');
  card.dataset.id = post.id;
  // Color del borde de arriba (ver .feed-card[data-s] en styles.css).
  card.dataset.s = post.sentiment || SENTIMENT_UNSET;
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
// Dibujo. Se rehace entero cada vez que cambian los datos, los filtros o el
// orden (monitoring.js avisa por monitoringViewListeners, ver
// scheduleFeedRender). Solo si el feed es la vista elegida: en la vista
// Tabla no se arma ninguna tarjeta.
// -------------------------------------------------------------------------
let feedRenderTimer = null;

function renderFeed() {
  clearTimeout(feedRenderTimer);
  if (feedCurrentView !== 'feed' || !monitoringTable) return;
  const all = monitoringTable.getData();
  const filters = readFilterValues();
  const visible = all.filter((post) => postMatchesFilters(post, filters));
  const reachById = new Map(visible.map((post) => [post.id, postReach(post)]));
  visible.sort(feedSorter(feedOrderEl.value, reachById));

  const fragment = document.createDocumentFragment();
  for (const post of visible) fragment.appendChild(buildFeedCard(post, reachById.get(post.id)));
  if (!visible.length) {
    fragment.appendChild(
      feedNode('div', 'feed-empty', all.length ? 'No hay publicaciones con esos filtros.' : 'Todavía no se detectó ningún posteo.')
    );
  }
  feedContainerEl.replaceChildren(fragment);
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
    // La tabla pudo armarse o cambiar mientras estaba oculta: Tabulator
    // necesita redibujarse al volver a verse para calcular bien los anchos.
    if (monitoringTable) monitoringTable.redraw(true);
  }
  if (save) feedSaveView(feedCurrentView);
}

feedViewSegEl.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (button) setFeedView(button.dataset.view);
});
feedOrderEl.addEventListener('change', renderFeed);
monitoringViewListeners.push(scheduleFeedRender);

// Al entrar: la última vista elegida. Los posteos todavía no llegaron; el
// feed se dibuja cuando monitoring.js avisa que ya hay datos.
setFeedView(feedReadSavedView(), { save: false });
