// --------------------------------------------------------------------
// El inicio (dashboard.html), diseño v4, con datos reales:
//   - una tarjeta por red (GET /api/inicio): Instagram con las
//     publicaciones de hoy, las que se despegaron y el tono de los últimos
//     7 días (los mismos números de Estadísticas: sin clasificar cuenta
//     como neutral) y el trazo de esos días; X con lo de hoy y su última
//     corrida real; Facebook y TikTok, "pronto";
//   - la próxima corrida: cuenta regresiva y anillo (cuánto pasó desde la
//     corrida programada anterior), la línea de las 24 h con las corridas
//     de hoy y su estado real (terminada, cortada, en curso, interrumpida,
//     la siguiente o la que no corrió) y los números de la última terminada,
//     con US$ como el Pipeline;
//   - las últimas publicaciones de Instagram (el listado de siempre),
//     dibujadas con postView.js; cada una abre su pop-up en el Monitoreo
//     (instagram.html#publicacion-<id>). Cuando cambia la última corrida se
//     vuelven a pedir y las nuevas entran con su animación;
//   - los 4 últimos análisis de publicación (GET /api/analisis), cada uno a
//     su análisis (instagram.html#analisis-<id>).
// /api/inicio se vuelve a pedir cada minuto (y al volver a la pestaña).
// Horas de Argentina, UTC-3 fija (no hay horario de verano).
//
// Script clásico: todo lo suyo lleva prefijo home / HOME_. Todo dato entra
// por textContent.
// --------------------------------------------------------------------
const HOME_TZ = 'America/Argentina/Buenos_Aires';
const HOME_AR_OFFSET_MS = -3 * 3600e3;
const HOME_HOUR_MS = 3600e3;
const HOME_DAY_MS = 24 * HOME_HOUR_MS;
// Como la barra superior (topbar.js): "escuchando" si la última corrida
// terminó hace menos de 5 h.
const HOME_FRESH_MS = 5 * HOME_HOUR_MS;
const HOME_POLL_MS = 60 * 1000;
const HOME_AGO_EVERY_MS = 30 * 1000;
const HOME_POSTS = 12;
const HOME_ANALISIS = 4;
const HOME_RING = 377; // largo del anillo: 2π·60
// Con menos lugar que esto entre dos horas, los rótulos van más chicos.
const HOME_LABEL_ROOM_PX = 60;
const HOME_SVG = 'http://www.w3.org/2000/svg';
const HOME_INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const HOME_USD = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HOME_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: HOME_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const HOME_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: HOME_TZ }); // AAAA-MM-DD

let homeInicio = null; // la última respuesta de /api/inicio
let homeNextAt = null; // la próxima corrida programada (ms) o null
let homeLastRunAt; // la última corrida de Instagram ya vista (undefined: todavía nada)
let homePostIds = null; // los ids ya dibujados en "Últimas publicaciones"
let homePostsLoading = false;
let homeLoadFailed = false; // el último pedido de /api/inicio falló
let homeRetryTimer = 0;
let homeAnaKey = null; // los análisis ya dibujados (ids y fechas)

function homeEl(id) {
  return document.getElementById(id);
}

function homeNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function homeSvg(tag, attrs = {}) {
  const node = document.createElementNS(HOME_SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function homeCount(value) {
  return Number.isFinite(value) ? HOME_INT.format(value) : '—';
}

// ---------- horas de Argentina ----------

function homeArDay(ms) {
  return HOME_DAY.format(new Date(ms));
}

// "05/10" (el formato es-AR de Intl da "5/10" con algunos datos de idioma).
function homeDayMonth(ms) {
  const [, month, day] = homeArDay(ms).split('-');
  return `${day}/${month}`;
}

// La hora del día en Argentina, con decimales (14,5 = 14:30).
function homeArHours(ms) {
  const local = (((ms + HOME_AR_OFFSET_MS) % HOME_DAY_MS) + HOME_DAY_MS) % HOME_DAY_MS;
  return local / HOME_HOUR_MS;
}

function homeArDayStart(ms) {
  return Math.floor((ms + HOME_AR_OFFSET_MS) / HOME_DAY_MS) * HOME_DAY_MS - HOME_AR_OFFSET_MS;
}

// "20:02" si es de hoy; "23/10 20:02" si no.
function homeWhenText(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const time = HOME_TIME.format(ms);
  return homeArDay(ms) === homeArDay(Date.now()) ? time : `${homeDayMonth(ms)} ${time}`;
}

function homeHoursText(hours) {
  const list = hours.map(String);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}` : list[0] || '';
}

function homeRed(id) {
  return (homeInicio && Array.isArray(homeInicio.redes) && homeInicio.redes.find((red) => red.id === id)) || null;
}

// ---------- tarjetas de las redes ----------

// El estado de una red, con la regla de la barra superior.
function homeRenderState(el, red) {
  const text = el.querySelector('span');
  el.className = 'st';
  delete el.dataset.tip;
  if (!red) {
    text.textContent = '—';
    return;
  }
  const last = Date.parse(red.lastRunAt);
  if (Number.isFinite(last)) el.dataset.tip = `Última corrida terminada: ${homeWhenText(red.lastRunAt)}`;
  if (!red.enCron) {
    el.classList.add('pause');
    text.textContent = 'en pausa';
  } else if (Number.isFinite(last) && Date.now() - last < HOME_FRESH_MS) {
    el.classList.add('live');
    text.textContent = 'escuchando';
  } else {
    text.textContent = Number.isFinite(last) ? `última ${homeDayMonth(last)}` : 'todavía no corrió';
  }
}

// El trazo de los últimos días, con su relleno (como el de las KPI).
function homeSpark(values) {
  if (values.length < 2) return null;
  const w = 300;
  const h = 36;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const points = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / (max - min || 1)) * (h - 8)]);
  const d = `M${points.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L')}`;
  const svg = homeSvg('svg', { class: 'sp', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const gradient = homeSvg('linearGradient', { id: 'homeSparkFill', x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(
    homeSvg('stop', { offset: 0, 'stop-color': 'var(--accent)', 'stop-opacity': 0.45 }),
    homeSvg('stop', { offset: 1, 'stop-color': 'var(--accent)', 'stop-opacity': 0 })
  );
  const defs = homeSvg('defs');
  defs.appendChild(gradient);
  const area = homeSvg('path', { d: `${d}L${w},${h}L0,${h}Z`, fill: 'url(#homeSparkFill)' });
  const line = homeSvg('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' });
  line.style.stroke = 'var(--accent)';
  svg.append(defs, area, line);
  return svg;
}

function homeRenderPlats() {
  const ig = homeRed('instagram');
  homeRenderState(homeEl('homeIgState'), ig);
  const week = ig && ig.sieteDias;
  homeEl('homeIgHoy').textContent = homeCount(ig ? ig.hoy : null);
  homeEl('homeIgUp').textContent = homeCount(week ? week.seDespegaron : null);
  homeEl('homeIgPos').textContent = week && Number.isFinite(week.positivoPct) ? `${Math.round(week.positivoPct)} %` : '—';
  homeEl('homeIgNeg').textContent = week && Number.isFinite(week.negativoPct) ? `${Math.round(week.negativoPct)} %` : '—';
  const spark = homeEl('homeIgSpark');
  const days = week && Array.isArray(week.porDia) ? week.porDia : [];
  const svg = homeSpark(days.map((day) => Number(day.total) || 0));
  spark.replaceChildren(...(svg ? [svg] : []));
  if (svg) {
    spark.dataset.tipTitle = 'Publicaciones por día · 7 días';
    spark.dataset.tip = days.map((day) => `${day.fecha.slice(8, 10)}/${day.fecha.slice(5, 7)}: ${HOME_INT.format(day.total)}`).join('\n');
  }

  const x = homeRed('x');
  homeRenderState(homeEl('homeXState'), x);
  homeEl('homeXHoy').textContent = homeCount(x ? x.hoy : null);
  const xLast = x ? Date.parse(x.lastRunAt) : NaN;
  homeEl('homeXLast').textContent = Number.isFinite(xLast) ? homeDayMonth(xLast) : '—';
  const xPaused = Boolean(x) && !x.enCron;
  homeEl('homeXNote').hidden = !xPaused;
  homeEl('homeX').classList.toggle('off', xPaused);
}

// ---------- próxima corrida ----------

// La primera de las próximas corridas de las redes que están en el cron.
function homeFindNextAt() {
  const times = (homeInicio ? homeInicio.redes : [])
    .filter((red) => red.enCron && red.nextRunAt)
    .map((red) => Date.parse(red.nextRunAt))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

// La corrida programada anterior a `next` (para el anillo).
function homePrevSlot(next) {
  const hours = (homeInicio && homeInicio.runHours) || [];
  const start = homeArDayStart(next);
  const before = [];
  for (const day of [-1, 0]) {
    for (const hour of hours) {
      const slot = start + day * HOME_DAY_MS + hour * HOME_HOUR_MS;
      if (slot < next) before.push(slot);
    }
  }
  return before.length ? Math.max(...before) : next - HOME_DAY_MS;
}

function homeNextWhenText(next, now) {
  const day = homeArDay(next);
  if (day === homeArDay(now)) {
    const hours = (homeInicio && homeInicio.runHours) || [];
    const first = hours.length ? Math.min(...hours) : null;
    return first !== null && Math.abs(homeArHours(next) - first) < 0.01 ? 'hoy, la primera del día' : 'hoy';
  }
  if (day === homeArDay(now + HOME_DAY_MS)) return 'mañana';
  return homeDayMonth(next);
}

function homeTick() {
  const now = Date.now();
  const clock = homeEl('homeClock');
  const ring = homeEl('homeRing');
  const dot = homeEl('homeRingDot');
  let k = 0;
  if (homeNextAt === null) {
    clock.textContent = '—';
    homeEl('homeClockLabel').textContent = '';
    homeEl('homeNextAt').textContent = '—';
    homeEl('homeNextWhen').textContent = homeInicio ? 'no hay corridas programadas' : homeLoadFailed ? 'sin respuesta del servidor' : '—';
  } else {
    const left = Math.max(0, Math.floor((homeNextAt - now) / 1000));
    const hh = String(Math.floor(left / 3600)).padStart(2, '0');
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    clock.textContent = `${hh}:${mm}:${ss}`;
    homeEl('homeClockLabel').textContent = left > 0 ? 'faltan' : 'arrancando';
    homeEl('homeNextAt').textContent = HOME_TIME.format(homeNextAt);
    homeEl('homeNextWhen').textContent = homeNextWhenText(homeNextAt, now);
    const prev = homePrevSlot(homeNextAt);
    k = Math.min(1, Math.max(0, (now - prev) / (homeNextAt - prev)));
    // Llegó la hora: en un rato se vuelve a pedir el inicio (la corrida en
    // curso, la próxima).
    if (left === 0 && !homeRetryTimer) homeRetryTimer = setTimeout(homeLoad, 20 * 1000);
  }
  ring.style.strokeDashoffset = String(HOME_RING * (1 - k));
  const angle = -Math.PI / 2 + k * 2 * Math.PI;
  dot.setAttribute('cx', (70 + 60 * Math.cos(angle)).toFixed(2));
  dot.setAttribute('cy', (70 + 60 * Math.sin(angle)).toFixed(2));
  homeEl('homeNow').style.left = `${(homeArHours(now) / 24) * 100}%`;
}

// ---------- la línea de las 24 h ----------

// Estado de /api/inicio → [clase, nombre, rótulo debajo del punto si el
// nombre es largo para el lugar que hay entre dos horas].
const HOME_RUN_STATES = {
  ok: ['ok', 'terminada'],
  cortada: ['cut', 'cortada'],
  'en curso': ['live', 'en curso'],
  interrumpida: ['stop', 'interrumpida', 'se cayó'],
};

function homeRunName(run) {
  return (HOME_RUN_STATES[run.estado] || ['', run.estado])[1];
}

function homeRunTip(run) {
  const parts = [`${homeWhenText(run.startedAt)} · ${homeRunName(run)}`];
  if (run.trigger === 'manual') parts[0] = `A mano · ${parts[0]}`;
  if (run.estado === 'cortada') parts.push('Se cortó por la cuota de Apify.');
  if (run.estado === 'interrumpida') parts.push('Arrancó y no terminó: el proceso se cortó en el medio.');
  if (run.estado === 'ok' || run.estado === 'cortada') {
    // Sin números: la corrida fue de varias redes y los suyos son de todas.
    parts.push(
      run.nuevas === null && run.guardadas === null
        ? 'Corrida de varias redes: sus números no son solo de esta.'
        : `${homeCount(run.nuevas)} nuevas · ${homeCount(run.guardadas)} relevantes guardadas`
    );
  }
  return parts.join('\n');
}

function homeRenderTrack() {
  const track = homeEl('homeTrack');
  for (const old of track.querySelectorAll('.run')) old.remove();
  const ig = homeRed('instagram');
  const runs = (ig && Array.isArray(ig.corridasHoy) ? ig.corridasHoy : []).filter((run) => Number.isFinite(Date.parse(run.startedAt)));
  const hours = (homeInicio && homeInicio.runHours) || [];
  const now = Date.now();
  const nowHours = homeArHours(now);
  const nextHours = homeNextAt !== null && homeArDay(homeNextAt) === homeArDay(now) ? homeArHours(homeNextAt) : null;
  const used = new Set();
  const summary = [];
  // Una corrida es la de su hora si arrancó en esa media hora (la del cron
  // primero, si hay otra a mano en el mismo rato).
  const matchAt = (hour) => {
    const near = runs
      .map((run, i) => [run, i])
      .filter(([run, i]) => !used.has(i) && Math.abs(homeArHours(Date.parse(run.startedAt)) - hour - 0.2) <= 0.3);
    const pick = near.find(([run]) => run.trigger === 'cron') || near[0];
    if (!pick) return null;
    used.add(pick[1]);
    return pick[0];
  };
  for (const hour of hours) {
    const run = matchAt(hour);
    const el = homeNode('span', 'run');
    el.style.left = `${(hour / 24) * 100}%`;
    el.append('✓', homeNode('b', '', `${hour}:00`));
    const small = homeNode('small');
    let state = '';
    if (run) {
      const [cls, name, short] = HOME_RUN_STATES[run.estado] || ['', run.estado];
      if (cls) el.classList.add(cls);
      small.textContent = run.estado === 'ok' && Number.isFinite(run.nuevas) ? `${HOME_INT.format(run.nuevas)} nuevas` : short || name;
      el.dataset.tip = homeRunTip(run);
      state = name;
    } else if (hour < nowHours - 0.25) {
      el.classList.add('miss');
      small.textContent = 'no corrió';
      el.dataset.tip = `${hour}:00 · no hubo corrida`;
      state = 'no corrió';
    } else if (nextHours !== null && Math.abs(hour - nextHours) < 0.01) {
      el.classList.add('next');
      small.textContent = 'siguiente';
      state = 'la siguiente';
    }
    el.appendChild(small);
    track.appendChild(el);
    summary.push(`${hour} h${state ? ` ${state}` : ''}`);
  }
  // Las que no son de ninguna hora del cron (a mano, fuera de horario).
  runs.forEach((run, i) => {
    if (used.has(i)) return;
    const el = homeNode('span', 'run extra');
    el.style.left = `${(homeArHours(Date.parse(run.startedAt)) / 24) * 100}%`;
    el.dataset.tip = homeRunTip(run);
    track.appendChild(el);
    summary.push(`otra a las ${HOME_TIME.format(Date.parse(run.startedAt))} ${homeRunName(run)}`);
  });
  track.setAttribute('aria-label', summary.length ? `Corridas de hoy: ${summary.join(', ')}` : 'Corridas de hoy');
  homeEl('homeRunsHint').textContent = hours.length ? `${hours.length} por día · ${homeHoursText(hours)} h` : '';
  homeFitTrackLabels();
}

// Los rótulos de las horas no se enciman: con poco lugar entre dos horas
// (celular, dos columnas angostas) van en letra más chica (.tight) y cada
// uno, como mucho, del ancho que le deja el más cercano; lo que no entra se
// corta con "…" (el estado entero está en el tip y en el aria-label).
function homeFitTrackLabels() {
  const track = homeEl('homeTrack');
  const runs = [...track.querySelectorAll('.run:not(.extra)')];
  const width = track.clientWidth;
  if (!runs.length || !width) return;
  const at = runs.map((el) => (parseFloat(el.style.left) / 100) * width);
  const room = at.map((x, i) =>
    Math.min(i > 0 ? x - at[i - 1] : Infinity, i < at.length - 1 ? at[i + 1] - x : Infinity)
  );
  track.classList.toggle('tight', Math.min(...room) < HOME_LABEL_ROOM_PX);
  runs.forEach((el, i) => {
    const max = Number.isFinite(room[i]) ? `${Math.max(24, room[i] - 4)}px` : '';
    for (const label of el.querySelectorAll('b, small')) label.style.maxWidth = max;
  });
}

// ---------- la última corrida ----------

function homeRenderLastRun() {
  const ig = homeRed('instagram');
  const run = ig && ig.lastRun;
  homeEl('homeLastAt').textContent = run ? homeWhenText(run.finishedAt) : ig ? 'todavía no corrió' : '—';
  const chips = homeEl('homeLastChips');
  if (!run) {
    chips.replaceChildren();
    return;
  }
  const chip = (value, label, tip) => {
    const el = homeNode('span');
    el.append(homeNode('b', '', value), ` ${label}`);
    if (tip) el.dataset.tip = tip;
    return el;
  };
  const list = [
    chip(homeCount(run.fetched), 'traídas', 'Resultados de las búsquedas de esa corrida.'),
    chip(
      homeCount(run.newCandidates),
      'nuevas',
      run.newCandidates === null ? 'Esta corrida es anterior al conteo de nuevas.' : 'Las que no estaban guardadas ni evaluadas: las clasificó el modelo.'
    ),
    chip(homeCount(run.saved), 'relevantes', 'Las relevantes, guardadas en la base.'),
  ];
  if (Number.isFinite(run.usd)) {
    const usd = homeNode('span');
    usd.appendChild(homeNode('b', '', `US$ ${HOME_USD.format(run.usd)}`));
    usd.dataset.tip = 'Costo estimado de Apify de esa corrida.';
    list.push(usd);
  }
  chips.replaceChildren(...list);
}

// ---------- últimas publicaciones ----------

function homeLine(post, isNew) {
  const line = homeNode('a', 'fl big');
  line.href = `instagram.html#publicacion-${encodeURIComponent(post.id)}`;
  line.dataset.id = post.id;
  if (!isNew) line.classList.add('seen');
  // Sin aria-label: el lector de pantalla lee lo mismo que se ve (cuenta,
  // título, tono, tema, alcance y hora) y, al final, adónde lleva.

  const thumb = postThumb(post);
  const net = homeNode('span', 'net');
  const glyph = document.querySelector('#homeIg .ic svg');
  if (glyph) net.appendChild(glyph.cloneNode(true));
  thumb.appendChild(net);

  const body = homeNode('span', 'body');
  // La cuenta arriba, en su renglón, y el título entero en dos.
  const title = postTitleLine(post, { wrap: true });

  const meta = homeNode('span', 'l2');
  const [toneClass, toneName] = POST_TONES[post.sentiment] || ['', 'Sin clasificar'];
  const tone = homeNode('span', 'lbl');
  const dot = homeNode('i');
  if (toneClass) dot.className = toneClass;
  tone.append(dot, toneName);
  meta.appendChild(tone);
  const tema = buildTemaTag(post.tema);
  if (tema) meta.appendChild(tema);
  meta.appendChild(buildReachMeter(postReach(post)));
  const when = homeNode('span', 't', feedAgo(post.detected_at));
  when.dataset.detected = post.detected_at || '';
  const { date, time } = formatFullDateTime(post.posted_at);
  when.title = `Publicada el ${time ? `${date} · ${time}` : date}`;
  meta.appendChild(when);

  body.append(title, meta, homeNode('span', 'sr', ' · Abrir en el Monitoreo'));
  line.append(thumb, body);
  return line;
}

function homeRenderFeed(posts) {
  const feed = homeEl('homeFeed');
  if (!posts.length) {
    feed.replaceChildren(homeNode('p', 'note empty', 'Todavía no hay publicaciones guardadas de Instagram.'));
    homePostIds = new Set();
    return;
  }
  const before = homePostIds;
  feed.replaceChildren(...posts.map((post) => homeLine(post, before !== null && !before.has(String(post.id)))));
  homePostIds = new Set(posts.map((post) => String(post.id)));
  homeFitFeed();
}

// En escritorio la tarjeta tiene el alto de la fila (el de "Próxima
// corrida") y nunca crece: van las líneas que entran enteras. Se mide con
// offset* (sin la animación de entrada, que las corre unos píxeles).
function homeFitFeed() {
  const feed = homeEl('homeFeed');
  const lines = [...feed.querySelectorAll('.fl')];
  for (const line of lines) line.hidden = false;
  const limit = feed.offsetTop + feed.clientHeight;
  let cut = false;
  for (const line of lines) {
    if (!cut && line.offsetTop + line.offsetHeight > limit + 0.5) cut = true;
    line.hidden = cut;
  }
}

let homeTemasLoaded = false;

// Los temas de la config, para el color de cada uno (temaColor en
// postView.js). Sin ellos, los temas van en el gris de "otras".
async function homeLoadTemas() {
  if (homeTemasLoaded) return;
  try {
    const res = await fetch('/api/monitoring/config?plataforma=instagram', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const config = await res.json();
    setPostViewTemas(config.temas);
    homeTemasLoaded = true;
  } catch (err) {
    console.error('Error leyendo los temas:', err);
  }
}

// @returns {Promise<boolean>} si llegaron (si no, se vuelve a probar con la
// recarga siguiente del inicio).
async function homeLoadPosts() {
  try {
    const [res] = await Promise.all([
      fetch(`/api/monitoring/posts?plataforma=instagram&pageSize=${HOME_POSTS}`, { credentials: 'same-origin' }),
      homeLoadTemas(),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const posts = (data.posts || []).filter((post) => !post.ignored && (post.plataforma || 'instagram') === 'instagram');
    homeRenderFeed(posts.slice(0, HOME_POSTS));
    return true;
  } catch (err) {
    console.error('Error leyendo las últimas publicaciones:', err);
    if (homePostIds === null) homeEl('homeFeed').replaceChildren(homeNode('p', 'note empty', 'No se pudieron cargar las publicaciones.'));
    return false;
  }
}

function homeTickAgo() {
  for (const when of document.querySelectorAll('#homeFeed .t')) {
    const text = feedAgo(when.dataset.detected);
    if (when.textContent !== text) when.textContent = text;
  }
}

// ---------- análisis recientes ----------

const HOME_ANA_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: HOME_TZ, day: 'numeric', month: 'short' });
const HOME_ANA_YEAR = new Intl.DateTimeFormat('es-AR', { timeZone: HOME_TZ, year: 'numeric' });
const HOME_ANA_FULL = new Intl.DateTimeFormat('es-AR', { timeZone: HOME_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const HOME_ANA_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: HOME_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const HOME_ANA_CAPTION = 90; // el texto, recortado en el DOM (si no, el enlace se lee entero)

function homeAnaDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// "27 sept" (con el año si no es este): la fecha de la publicación.
function homeAnaShort(d) {
  const corta = HOME_ANA_DATE.format(d).replace('.', '');
  const anio = HOME_ANA_YEAR.format(d);
  return anio === HOME_ANA_YEAR.format(new Date()) ? corta : `${corta} ${anio}`;
}

function homeAnaLine(a) {
  const line = homeNode('a');
  line.href = `instagram.html#analisis-${encodeURIComponent(a.id)}`;
  const th = homeNode('span', 'th');
  th.style.setProperty('--a', accountColor(a.cuenta));
  th.setAttribute('aria-hidden', 'true');
  if (a.imagen && a.imagen.thumbUrl) {
    const img = homeNode('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = a.imagen.thumbUrl;
    img.addEventListener('error', () => img.remove());
    th.appendChild(img);
  }
  const tx = homeNode('span', 'tx');
  // La fecha de la publicación; si no vino, la del análisis, dicha así.
  const publicada = homeAnaDate(a.postedAt);
  const analizada = homeAnaDate(a.finishedAt);
  const fecha = publicada ? homeAnaShort(publicada) : analizada ? `analizado ${homeAnaShort(analizada)}` : null;
  const cuenta = a.cuenta ? `@${a.cuenta}` : 'Publicación';
  tx.appendChild(homeNode('b', '', `${cuenta}${fecha ? ` · ${fecha}` : ''}`));
  const caption = (a.caption || '').replace(/\s+/g, ' ').trim();
  let corto = caption;
  if (caption.length > HOME_ANA_CAPTION) {
    const corte = caption.lastIndexOf(' ', HOME_ANA_CAPTION);
    corto = `${caption.slice(0, corte > 40 ? corte : HOME_ANA_CAPTION)}…`;
  }
  tx.appendChild(homeNode('small', '', corto || 'Sin texto.'));
  const t = a.tonos || {};
  const base = (t.positivos || 0) + (t.neutrales || 0) + (t.negativos || 0);
  const pos = base > 0 ? Math.round(((t.positivos || 0) / base) * 100) : null;
  const num = homeNode('span', 'num');
  if (pos !== null) num.appendChild(homeNode('span', 'sent-pos', `${pos} % pos`));
  // Los analizados, dicho así: no es el total de comentarios de la publicación.
  num.appendChild(homeNode('span', '', `${homeCount(a.analizados)} analizados`));
  // Un nombre corto para el lector de pantalla (el texto entero no).
  const total = Number.isFinite(a.comentariosTotal) && a.comentariosTotal > a.analizados ? ` de ${homeCount(a.comentariosTotal)}` : '';
  const partes = [
    `Análisis de ${cuenta}`,
    publicada ? `publicación del ${HOME_ANA_FULL.format(publicada)}` : null,
    analizada ? `analizado el ${HOME_ANA_FULL.format(analizada)}` : null,
    pos !== null ? `${pos} % positivo` : null,
    `${homeCount(a.analizados)}${total} comentarios analizados`,
  ];
  line.setAttribute('aria-label', partes.filter(Boolean).join(', '));
  // Dos análisis de la misma publicación se distinguen por cuándo se hicieron.
  if (analizada) line.dataset.tip = `Analizado el ${HOME_ANA_FULL.format(analizada)} a las ${HOME_ANA_TIME.format(analizada)}`;
  line.append(th, tx, num);
  return line;
}

async function homeLoadAnalisis() {
  const box = homeEl('homeAna');
  try {
    const res = await fetch(`/api/analisis?plataforma=instagram&limit=${HOME_ANALISIS}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = (data.recientes || []).slice(0, HOME_ANALISIS);
    const key = list.map((a) => `${a.id}:${a.finishedAt}`).join('|');
    if (key === homeAnaKey) return;
    homeAnaKey = key;
    if (!list.length) {
      box.replaceChildren(homeNode('p', 'note empty', 'Todavía no hay análisis. Pegá el link de una publicación en Análisis de publicación.'));
      return;
    }
    box.replaceChildren(...list.map(homeAnaLine));
  } catch (err) {
    console.error('Error leyendo los análisis recientes:', err);
    if (homeAnaKey === null) box.replaceChildren(homeNode('p', 'note empty', 'No se pudieron cargar los análisis.'));
  }
}

// ---------- carga ----------

async function homeLoad() {
  clearTimeout(homeRetryTimer);
  homeRetryTimer = 0;
  homeLoadAnalisis();
  try {
    const res = await fetch('/api/inicio', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    homeInicio = await res.json();
  } catch (err) {
    console.error('Error leyendo el inicio:', err);
    homeLoadFailed = true;
    homeTick();
    // Las publicaciones se piden recién con el inicio: hasta que responda, lo
    // mismo que dice la otra tarjeta, no "Cargando…".
    if (homePostIds === null) homeEl('homeFeed').replaceChildren(homeNode('p', 'note empty', 'Sin respuesta del servidor.'));
    return;
  }
  homeLoadFailed = false;
  homeNextAt = homeFindNextAt();
  homeRenderPlats();
  homeRenderLastRun();
  homeRenderTrack();
  homeTick();
  // Las publicaciones se vuelven a pedir cuando cambia la última corrida; la
  // marca avanza recién cuando llegaron (si el pedido falla, se reintenta con
  // la recarga siguiente, no con la próxima corrida).
  const ig = homeRed('instagram');
  const lastRunAt = ig ? ig.lastRunAt : null;
  if (lastRunAt !== homeLastRunAt && !homePostsLoading) {
    homePostsLoading = true;
    homeLoadPosts()
      .then((ok) => {
        if (ok) homeLastRunAt = lastRunAt;
      })
      .finally(() => {
        homePostsLoading = false;
      });
  }
}

homeLoad();
new ResizeObserver(homeFitFeed).observe(homeEl('homeFeed'));
new ResizeObserver(homeFitTrackLabels).observe(homeEl('homeTrack'));
setInterval(homeTick, 1000);
setInterval(() => {
  if (!document.hidden) homeLoad();
}, HOME_POLL_MS);
setInterval(() => {
  if (!document.hidden) homeTickAgo();
}, HOME_AGO_EVERY_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) homeLoad();
});
