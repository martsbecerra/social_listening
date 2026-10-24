// --------------------------------------------------------------------
// Cómo se ve un posteo, compartido (diseño v4): lo usan el Monitoreo
// (monitoring.js, el feed, el pop-up, el panel, el flujo), Estadísticas y el
// inicio (dashboard.js). Son funciones puras o que arman nodos: no piden
// datos ni dependen de la página. Salieron TAL CUAL de monitoring.js,
// monitoringFeed.js y monitoringFlow.js (fase D) con sus nombres de
// siempre; lo del flujo pasó a llamarse post… (postFindTerm,
// postTitleLine, postThumb, POST_TONES).
//
// Va antes que todos ellos en instagram.html, x.html y dashboard.html.
// Script clásico: comparte el ámbito global. Todo dato entra por
// textContent.
// --------------------------------------------------------------------

// Los temas posibles de un posteo, en el orden de la config
// (/api/monitoring/config): de ahí sale el color de cada uno (temaColor).
let postViewTemas = [];

function setPostViewTemas(temas) {
  postViewTemas = Array.isArray(temas) ? temas : [];
}

// Formatea un número con separador de miles es-AR, o "—" si no hay dato
// (mismo símbolo que usa design/monitoreo.html en fmt/abbr).
function formatCount(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('es-AR');
}

// Color del avatar de una cuenta (la inicial va en blanco), de la paleta de
// la maqueta v4 en su tono oscuro. Sale del nombre de la cuenta: cada una se
// ve siempre igual en el feed, el pop-up, el flujo, las cuentas seguidas y
// el filtro de Cuenta.
const ACCOUNT_PALETTE = ['#199e70', '#d04a4a', '#2a78d6', '#c98500', '#6250d6', '#0b7fc4', '#d95926', '#5466b8'];

function accountColor(account) {
  let hash = 7;
  for (const ch of String(account || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return ACCOUNT_PALETTE[hash % ACCOUNT_PALETTE.length];
}

// Color del punto de un tema (el flujo, el pop-up): el de su lugar en la
// lista de temas de la config (postViewTemas, la fija quien la trae:
// monitoring.js al cargar la config, el inicio con la suya), con los doce
// colores de categoría del mapa (--cat-1 … --cat-12, se repiten); sin tema,
// el gris de "otras".
function temaColor(tema) {
  const i = tema ? postViewTemas.indexOf(tema) : -1;
  return i < 0 ? 'var(--cat-otras)' : `var(--cat-${(i % 12) + 1})`;
}

// El tema a la vista: punto de color y nombre (.tema en styles.css). null
// si el posteo no tiene tema.
function buildTemaTag(tema) {
  if (!tema) return null;
  const tag = document.createElement('span');
  tag.className = 'tema';
  const dot = document.createElement('i');
  dot.style.background = temaColor(tema);
  dot.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.textContent = tema;
  tag.title = tema;
  tag.append(dot, name);
  return tag;
}

// Por qué se detectó un posteo, a partir de matched_reason (lo arma
// src/monitor.js): "búsqueda" con su término, "palabra clave" con la
// palabra, o "cuenta trackeada". Lo que viene después de " · " es el motivo
// del clasificador y no entra acá. Una forma desconocida va tal cual, sin
// término.
function postReasonParts(reason) {
  const base = String(reason || '').split(' · ')[0].trim();
  let match = base.match(/^Búsqueda:\s*(.+?)(?:\s+\(|\s+—\s|$)/);
  if (match) return { text: 'búsqueda', term: match[1] };
  match = base.match(/^Coincidencia con palabra clave:\s*"?(.+?)"?$/);
  if (match) return { text: 'palabra clave', term: match[1] };
  if (base.startsWith('Cuenta trackeada')) return { text: 'cuenta trackeada', term: null };
  return { text: base, term: null };
}

function formatBenchmarkNumber(n) {
  return n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('es-AR');
}

// Formateador armado una sola vez: toLocaleString con opciones crea uno
// nuevo en cada llamada, y el feed formatea cientos de tarjetas de un saque.
const BENCHMARK_RATIO_OPTIONS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const BENCHMARK_RATIO_FORMAT = new Intl.NumberFormat('es-AR', BENCHMARK_RATIO_OPTIONS);

// La razón del alcance, con dos decimales ("1,09"). Se CORTA, no se
// redondea: los cortes de la regla (1,1 y 1,5, ver src/reachRule.js) tienen
// hasta dos decimales, y un 1,096 redondeado diría "1,10" al lado de
// "Alcance bajo". Cortando, el número que se ve nunca queda del otro lado
// del corte que su etiqueta. El 1e-9 es por la cuenta en punto flotante
// (1,15 * 100 da 114,99999999999999).
function formatBenchmarkRatio(ratio) {
  // Solo los números pasan por el formateador compartido. Con cualquier otra
  // cosa hace lo mismo que antes de tenerlo: un null tira, no sale "0,00".
  if (typeof ratio !== 'number') return ratio.toLocaleString('es-AR', BENCHMARK_RATIO_OPTIONS);
  return BENCHMARK_RATIO_FORMAT.format(Math.floor(ratio * 100 + 1e-9) / 100);
}

// Con qué se calculó la razón de una métrica, en palabras: "229 contra una
// mediana de 21 en la cuenta, con colchón de 2.000". La razón no es valor /
// mediana: el backend suma el colchón arriba y abajo y lo manda junto con
// ella. Va donde se muestra la razón (detalle de la tabla, tarjetas y
// pop-up), para que el número no parezca mal calculado.
function benchmarkRatioBasis(metric) {
  const basis = `${formatBenchmarkNumber(metric.value)} contra una mediana de ${formatBenchmarkNumber(metric.median)} en la cuenta`;
  return metric.cushion > 0 ? `${basis}, con colchón de ${formatBenchmarkNumber(metric.cushion)}` : basis;
}

// Fecha + hora completas (24hs, no "a. m./p. m."). "N/D" si no hay fecha.
// Mismo motivo que BENCHMARK_RATIO_FORMAT: formateadores armados una vez.
const FULL_DATE_FORMAT = new Intl.DateTimeFormat('es-AR');
const FULL_TIME_FORMAT = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

function formatFullDateTime(iso) {
  if (!iso) return { date: 'N/D', time: '' };
  const d = new Date(iso);
  // Una fecha inválida hace tirar a Intl.DateTimeFormat (toLocaleDateString
  // devolvía el texto "Invalid Date"): se conserva ese resultado.
  if (Number.isNaN(d.getTime())) return { date: 'Invalid Date', time: 'Invalid Date' };
  return { date: FULL_DATE_FORMAT.format(d), time: FULL_TIME_FORMAT.format(d) };
}

// -------------------------------------------------------------------------
// Alcance del posteo: UNA etiqueta (alto | medio | bajo) a partir de los dos
// niveles que ya manda el backend en benchmark.likes y benchmark.comments
// (classifyValue en src/accountStats.js, con la regla de src/reachRule.js:
// razón con colchón, piso para el alto, y los cortes que diga el .env). Acá
// no se recalcula nada ni se conoce ningún corte, solo se combinan. Likes y
// comentarios pesan igual y vale el mejor de los dos: alto si alguno da
// alto, bajo solo si los dos dan bajo, medio en el resto ("normal" del
// backend se muestra como "medio"; "bajo" quiere decir que el posteo no se
// despega de lo normal de su cuenta). Una métrica sin referencia (likes
// ocultos, muestra chica) no cuenta y decide la otra; si ninguna tiene
// referencia devuelve null y el posteo no lleva etiqueta de alcance.
//   by / label: la métrica que decidió la etiqueta: la de mejor nivel y, a
//               igual nivel, la de mayor razón (empate: comentarios, igual
//               que highlightOf en el backend).
//   ratio:      la razón de esa métrica, (valor + colchón) / (mediana de la
//               cuenta + colchón). Es la que se muestra al lado de la
//               etiqueta y, dentro de cada nivel, la que ordena "Mayor
//               alcance".
//   metric:     lo que mandó el backend para esa métrica (valor, mediana,
//               colchón), para poder decir con qué se calculó la razón.
// -------------------------------------------------------------------------
const REACH_RANK = { bajo: 0, normal: 1, alto: 2 };
const REACH_LEVELS = ['bajo', 'medio', 'alto'];
const REACH_METRICS = [
  { by: 'comments', label: 'comentarios' },
  { by: 'likes', label: 'likes' },
];

function postReach(post) {
  const benchmark = (post && post.benchmark) || {};
  let best = null;
  for (const { by, label } of REACH_METRICS) {
    const metric = benchmark[by];
    const rank = metric ? REACH_RANK[metric.level] : undefined;
    // "sin-referencia" (o cualquier nivel desconocido) no entra en la cuenta.
    if (typeof rank !== 'number' || !Number.isFinite(metric.ratio)) continue;
    if (!best || rank > best.rank || (rank === best.rank && metric.ratio > best.ratio)) {
      best = { rank, by, label, ratio: metric.ratio, metric };
    }
  }
  if (!best) return null;
  return { level: REACH_LEVELS[best.rank], by: best.by, label: best.label, ratio: best.ratio, metric: best.metric };
}

// El alcance a la vista: el .reach de design/social-listening-v4.html, cinco
// barras y una palabra. En "alto" las cinco laten en el color de acento y al
// lado va la razón ("1,56×"); en "medio" van tres en ámbar; en "bajo" quedan
// grises. Sin referencia: "—". Al pasar el mouse dice con qué se calculó (la
// razón lleva colchón). Lo usan la columna "Alcance" de la tabla, el pie de
// la tarjeta del feed, el flujo y "Se despegaron". "reach" es lo que
// devuelve postReach.
const REACH_TITLES = { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };

function buildReachMeter(reach) {
  const cell = document.createElement('span');
  if (!reach) {
    cell.className = 'reach none';
    // La raya es para la vista; el lector lee qué quiere decir.
    const dash = document.createElement('span');
    dash.setAttribute('aria-hidden', 'true');
    dash.textContent = '—';
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = 'Alcance sin referencia';
    cell.append(dash, sr);
    cell.dataset.tipTitle = 'Alcance sin referencia';
    cell.dataset.tip = 'Ninguna de sus dos métricas tiene con qué compararse en su cuenta.';
    return cell;
  }
  cell.className = `reach ${reach.level}`;
  const bars = document.createElement('span');
  bars.className = 'bars';
  bars.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 5; i++) bars.appendChild(document.createElement('i'));
  // Para un lector de pantalla, el nivel en palabras.
  const sr = document.createElement('span');
  sr.className = 'sr';
  if (reach.level === 'alto') {
    sr.textContent = 'Alcance alto, razón ';
    cell.append(bars, sr, `${formatBenchmarkRatio(reach.ratio)}×`);
  } else {
    sr.textContent = 'Alcance ';
    cell.append(bars, sr, reach.level);
  }
  cell.dataset.tipTitle = `Alcance ${reach.level}`;
  cell.dataset.tip = `Razón ${formatBenchmarkRatio(reach.ratio)} en ${reach.label}: ${benchmarkRatioBasis(reach.metric)}.`;
  return cell;
}

function normalizeSearch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
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

// Foto del posteo. El listado manda `image` (src/postImageRoutes.js):
// thumbUrl y fullUrl, las direcciones de las dos copias guardadas en el
// servidor (null si no hay), y status, cómo salió el último intento de
// bajarla. El frontend lee ese dato en tres puntos: acá, en feedImageFailed
// (abajo) y en feedPopImageUrl (pop-up). La tarjeta usa la miniatura y el
// pop-up la imagen grande.
function feedImageUrl(post) {
  return (post.image && post.image.thumbUrl) || null;
}

const POST_TONES = {
  positivo: ['bg-pos', 'Positivo'],
  neutral: ['bg-neu', 'Neutral'],
  negativo: ['bg-neg', 'Negativo'],
};

// Dónde está el término dentro del texto, sin mirar mayúsculas ni acentos:
// [inicio, fin) en el texto original, o null.
function postFindTerm(text, term) {
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

// Si el término cae lejos del principio, el título se recorta adelante
// ("…de octubre GCBA"): si no, la elipsis del final lo tapaba y del
// resaltado asomaba solo una astilla.
const POST_TERM_LEAD = 16;
const POST_TERM_KEEP = 10;

// "@cuenta · título", con el término de la búsqueda que lo trajo en <mark>
// (armado con nodos de texto, nunca como HTML). En un renglón (el flujo)
// el título se recorta adelante si el término cae lejos; `wrap` (el inicio,
// donde la cuenta va en su renglón y el título en dos) lo deja entero y sin
// el " · ".
function postTitleLine(post, { wrap = false } = {}) {
  const line = document.createElement('span');
  line.className = 'l1';
  const account = post.account && post.account !== 'N/D' ? `@${post.account}` : 'N/D';
  const name = document.createElement('b');
  name.textContent = account;
  const title = post.title || '(sin clasificar)';
  const reason = postReasonParts(post.matched_reason);
  const hit = reason.text === 'búsqueda' ? postFindTerm(title, reason.term) : null;
  line.append(name);
  if (!wrap) line.append(' · ');
  if (hit) {
    let start = 0;
    if (!wrap && hit[0] > POST_TERM_LEAD) {
      // Desde el principio de una palabra, unas letras antes del término.
      const space = title.indexOf(' ', hit[0] - POST_TERM_KEEP);
      start = space >= 0 && space < hit[0] ? space + 1 : hit[0] - POST_TERM_KEEP;
    }
    const mark = document.createElement('mark');
    mark.textContent = title.slice(hit[0], hit[1]);
    line.append(start ? `…${title.slice(start, hit[0])}` : title.slice(0, hit[0]), mark, title.slice(hit[1]));
  } else {
    line.append(title);
  }
  line.title = `${account} · ${title}`;
  return line;
}

function postThumb(post) {
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
