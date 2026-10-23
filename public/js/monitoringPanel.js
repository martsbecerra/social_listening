// --------------------------------------------------------------------
// Panel del Monitoreo de Instagram (diseño v4, design/social-listening-v4.html):
// los cuatro KPI del período, las cajas de fuentes (búsquedas, palabras
// clave, hashtags y cuentas seguidas), el pulso del tono, el pipeline de la
// última corrida y las alertas. Estilos en public/css/styles.css.
//
// Lo carga SOLO instagram.html, después de monitoring.js, monitoringFeed.js,
// monitoringFeedPopup.js y kpi.js (las tarjetas KPI, compartidas con
// Estadísticas), y se apoya en lo que ya definen: los posteos
// salen de la tabla (monitoringTable), el período de monitorPeriodStart /
// postInPeriod, el filtro por fuente de setSourceFilter, y agregar o sacar
// una fuente usa las mismas funciones y endpoints de siempre (addSearch,
// removeKeyword, ...). Todo es del lado del cliente salvo el pipeline, que
// lee lastRun de GET /api/monitoring/status. Todo dato entra por
// textContent: términos, cuentas y títulos los escriben personas.
// --------------------------------------------------------------------
const panelKpisEl = document.getElementById('monKpis');
const panelReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PANEL_TZ = 'America/Argentina/Buenos_Aires';
const PANEL_TIME = new Intl.DateTimeFormat('es-AR', { timeZone: PANEL_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const PANEL_DATE = new Intl.DateTimeFormat('es-AR', { timeZone: PANEL_TZ, day: '2-digit', month: '2-digit' });
const PANEL_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: PANEL_TZ, hour: '2-digit', hourCycle: 'h23' });
const PANEL_INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const PANEL_ONE = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PANEL_USD = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Los de kpi.js, con el nombre de siempre en este archivo.
const panelNode = kpiNode;
const panelSvg = kpiSvg;

// Doce tramos iguales entre "from" y "to": cuántas publicaciones (o la suma
// de "weight") cayeron en cada uno, por fecha de publicación.
function panelBuckets(posts, from, to, weight = () => 1, n = 12) {
  const out = Array(n).fill(0);
  const span = Math.max(1, to - from);
  for (const post of posts) {
    const ms = postPostedMs(post);
    if (ms === null || ms < from) continue;
    const k = Math.min(n - 1, Math.floor(((ms - from) / span) * n));
    out[k] += weight(post);
  }
  return out;
}

// Tono de una lista: proporción de positivos, neutrales y negativos entre
// los clasificados (los sin clasificar no cuentan), y cuántos hay.
function panelTone(posts) {
  let pos = 0;
  let neu = 0;
  let neg = 0;
  for (const post of posts) {
    if (post.sentiment === 'positivo') pos++;
    else if (post.sentiment === 'neutral') neu++;
    else if (post.sentiment === 'negativo') neg++;
  }
  const n = pos + neu + neg;
  return n ? { n, pos: pos / n, neu: neu / n, neg: neg / n } : { n: 0, pos: 0, neu: 0, neg: 0 };
}

const panelPct = (share) => `${Math.round(share * 100)} %`;

// -------------------------------------------------------------------------
// KPI.
// -------------------------------------------------------------------------

// La tarjeta, el trazo, el anillo, countUp y la variación están en kpi.js.

function panelRenderKpis(posts, previous, from, now) {
  if (!panelKpisEl) return;
  const label = monitorPeriodLabel();

  const tone = panelTone(posts);
  const net = tone.n ? Math.round((tone.pos - tone.neg) * 100) : null;
  const toneDetail = tone.n
    ? (() => {
        const b = panelNode('b', tone.pos > tone.neg ? '' : 'neg', `${panelPct(tone.pos)} positivo`);
        return [b, ` · ${panelPct(tone.neg)} negativo`];
      })()
    : ['sin publicaciones clasificadas'];

  const altos = posts
    .map((post) => ({ post, top: highlightTop(post) }))
    .filter((entry) => entry.top)
    .sort((a, b) => b.top.ratio - a.top.ratio);
  // La razón lleva colchón: no se dice "N veces lo habitual".
  const altoDetail = altos.length
    ? (() => {
        const best = altos[0];
        const account = best.post.account && best.post.account !== 'N/D' ? `@${best.post.account}` : 'una cuenta sin identificar';
        return ['la mayor: ', panelNode('b', 'flat', `${formatBenchmarkRatio(best.top.ratio)}×`), ` en ${best.top.label}, de ${account}`];
      })()
    : ['ninguna por ahora'];

  const likes = posts.reduce((sum, post) => sum + (Number(post.likes) || 0), 0);
  const comments = posts.reduce((sum, post) => sum + (Number(post.comments) || 0), 0);

  panelKpisEl.replaceChildren(
    kpiCard({
      id: 'pubs',
      label: `Publicaciones ${label}`,
      value: posts.length,
      detail: kpiDelta(posts.length, previous === null ? null : previous.length),
      spark: panelBuckets(posts, from, now),
    }),
    kpiCard({
      id: 'tono',
      label: 'Tono neto',
      value: net,
      format: (n) => `${PANEL_INT.format(Math.round(n))} pts`,
      detail: toneDetail,
      ring: net === null ? null : { share: Math.min(1, Math.abs(net) / 100), color: net >= 0 ? 'var(--pos)' : 'var(--neg)' },
    }),
    kpiCard({
      id: 'altos',
      label: 'Se despegaron',
      value: altos.length,
      detail: altoDetail,
      spark: panelBuckets(altos.map((entry) => entry.post), from, now),
    }),
    kpiCard({
      id: 'conv',
      label: 'Conversación',
      value: likes + comments,
      detail: [`${PANEL_INT.format(likes)} likes · ${PANEL_INT.format(comments)} comentarios`],
      spark: panelBuckets(posts, from, now, (post) => (Number(post.likes) || 0) + (Number(post.comments) || 0)),
    })
  );
}

// -------------------------------------------------------------------------
// Fuentes: búsquedas, palabras clave, hashtags (chips) y cuentas seguidas
// (filas). Cada una con cuántas publicaciones del período trajo: una
// búsqueda, las que llegaron por ella (matched_reason); una palabra o un
// hashtag, las que la tienen escrita en el título o el texto. Un clic en un
// chip filtra la lista; la ✕ pide confirmación en el mismo lugar.
// -------------------------------------------------------------------------
const PANEL_SOURCES = {
  search: { listEl: 'searchList', countEl: 'searchCount', moreEl: null, show: Infinity, remove: (v) => removeSearch(v), word: ['término', 'términos'] },
  keyword: { listEl: 'keywordList', countEl: 'keywordCount', moreEl: 'keywordMore', show: 8, remove: (v) => removeKeyword(v), word: ['palabra', 'palabras'] },
  hashtag: { listEl: 'hashtagList', countEl: 'hashtagCount', moreEl: 'hashtagMore', show: 6, remove: (v) => removeKeyword(v), word: ['hashtag', 'hashtags'] },
  account: { listEl: 'accountList', countEl: 'accountCount', moreEl: 'accountMore', show: 4, remove: (v) => removeAccount(v), word: ['cuenta', 'cuentas'] },
};
for (const source of Object.values(PANEL_SOURCES)) {
  source.listEl = document.getElementById(source.listEl);
  source.countEl = document.getElementById(source.countEl);
  source.moreEl = source.moreEl ? document.getElementById(source.moreEl) : null;
}

// La config de fuentes (undefined: todavía no llegó; null: falló). Puede
// haber llegado antes de que se cargara este archivo: se arranca con la de
// monitoring.js.
let panelConfig = monitoringConfig;
// Qué cajas están desplegadas ("Ver las N →").
const panelExpanded = { keyword: false, hashtag: false, account: false };
// La fuente que está pidiendo confirmación para salir: { kind, value }.
let panelAsking = null;
// Un pedido de sacar en camino (no se puede pedir otro hasta que termine).
let panelRemoving = false;

const panelFilterKind = (kind) => (kind === 'search' ? 'search' : 'keyword');

function panelIsActive(kind, value) {
  return sourceFilterKey(monitorSourceFilter) === sourceFilterKey({ kind: panelFilterKind(kind), term: value });
}

// La barrita de tono de un chip (sin clasificados, ninguna).
function panelToneBar(tone) {
  const bar = panelNode('span', 'bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const [key, cls] of [['pos', 'bg-pos'], ['neu', 'bg-neu'], ['neg', 'bg-neg']]) {
    const part = panelNode('i', cls);
    part.style.width = `${tone[key] * 100}%`;
    bar.appendChild(part);
  }
  return bar;
}

function panelCountText(n) {
  return `${n} ${n === 1 ? 'publicación' : 'publicaciones'} en el período`;
}

// El pedido de confirmación, en el lugar del chip o de la fila de la cuenta.
function panelAskNode(tag, kind, value, label) {
  const node = panelNode(tag, `${kind === 'account' ? 'acct' : 'chip'} ask`);
  node.dataset.kind = kind;
  node.dataset.value = value;
  const q = panelNode('span', 'q', `¿Sacar «${label}»?`);
  const yes = panelNode('button', 'yes', 'Sí');
  yes.type = 'button';
  yes.dataset.act = 'yes';
  const no = panelNode('button', 'no', 'No');
  no.type = 'button';
  no.dataset.act = 'no';
  if (panelRemoving) yes.disabled = no.disabled = true;
  node.append(q, yes, no);
  return node;
}

function panelChip(kind, value, posts) {
  if (panelAsking && panelAsking.kind === kind && panelAsking.value === value) return panelAskNode('span', kind, value, value);
  const tone = panelTone(posts);
  const chip = panelNode('span', `chip${panelIsActive(kind, value) ? ' on' : ''}`);
  chip.dataset.kind = kind;
  chip.dataset.value = value;
  chip.tabIndex = 0;
  chip.setAttribute('role', 'button');
  chip.setAttribute('aria-pressed', String(panelIsActive(kind, value)));
  chip.dataset.tipTitle = value;
  chip.dataset.tip =
    panelCountText(posts.length) +
    (tone.n ? ` · ${panelPct(tone.pos)} positivo · ${panelPct(tone.neg)} negativo` : '') +
    '\nClic: filtrar la lista · ✕: sacar';
  chip.append(panelNode('span', 'w', value), panelNode('span', 'n', PANEL_INT.format(posts.length)));
  if (tone.n) chip.appendChild(panelToneBar(tone));
  const x = panelNode('button', 'x', '✕');
  x.type = 'button';
  x.dataset.act = 'ask';
  x.setAttribute('aria-label', `Sacar «${value}»`);
  chip.appendChild(x);
  return chip;
}

// Una cuenta seguida: inicial, @cuenta, publicaciones del período y ✕. Un
// clic la elige en el filtro de Cuenta; la que está elegida se marca como un
// chip activo.
function panelAccountRow(account, posts) {
  if (panelAsking && panelAsking.kind === 'account' && panelAsking.value === account) {
    return panelAskNode('div', 'account', account, `@${account}`);
  }
  const active = fAccValue === account;
  const row = panelNode('div', `acct${active ? ' on' : ''}`);
  row.dataset.kind = 'account';
  row.dataset.value = account;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-pressed', String(active));
  const followers = posts.reduce((max, post) => (Number.isFinite(Number(post.followers)) && post.followers != null ? Math.max(max, Number(post.followers)) : max), -1);
  row.dataset.tipTitle = `@${account}`;
  row.dataset.tip =
    (followers >= 0 ? `${PANEL_INT.format(followers)} seguidores · ` : '') + `${panelCountText(posts.length)}\nClic: filtrar la lista · ✕: sacar`;
  const av = panelNode('span', 'av', account[0] ? account[0].toUpperCase() : '?');
  av.style.background = accountColor(account);
  av.setAttribute('aria-hidden', 'true');
  const x = panelNode('button', 'x', '✕');
  x.type = 'button';
  x.dataset.act = 'ask';
  x.setAttribute('aria-label', `Sacar @${account}`);
  row.append(av, panelNode('span', 'nm', `@${account}`), panelNode('span', 'm', `${posts.length} publ.`), x);
  return row;
}

function panelEmptyNote(text) {
  return panelNode('p', 'empty', text);
}

// "Ver las 63 →" / "Ver menos" debajo de una caja que tiene más de las que
// muestra. Desplegada, la lista lleva "expanded" (con columnas, se desplaza
// adentro en lugar de estirar la fila).
function panelMore(kind, total) {
  const source = PANEL_SOURCES[kind];
  if (!source.moreEl) return;
  const hidden = total <= source.show;
  source.moreEl.classList.toggle('hidden', hidden);
  source.listEl.classList.toggle('expanded', !hidden && panelExpanded[kind]);
  if (hidden) return;
  const plural = kind === 'hashtag' ? 'los' : 'las';
  source.moreEl.textContent = panelExpanded[kind] ? 'Ver menos' : `Ver ${plural} ${total} →`;
  source.moreEl.setAttribute('aria-expanded', String(panelExpanded[kind]));
}

function panelRenderSources(periodPosts) {
  const searchBox = PANEL_SOURCES.search;
  if (!searchBox.listEl) return;
  if (panelConfig === undefined) return; // todavía no llegó la config
  if (panelConfig === null) {
    for (const source of Object.values(PANEL_SOURCES)) {
      source.listEl.replaceChildren(panelEmptyNote('No se pudo cargar. Reiniciá el servidor y recargá la página.'));
    }
    return;
  }

  // Texto de cada posteo, ya plegado, para buscar palabras una sola vez.
  const folded = new Map(periodPosts.map((post) => [post.id, normalizeSearch(`${post.title || ''} ${post.caption || ''}`)]));
  const bySearch = new Map();
  for (const post of periodPosts) {
    const reason = postReasonParts(post.matched_reason);
    if (reason.text !== 'búsqueda' || !reason.term) continue;
    const key = normalizeSearch(reason.term).trim();
    if (!bySearch.has(key)) bySearch.set(key, []);
    bySearch.get(key).push(post);
  }
  const containing = (word) => {
    const term = normalizeSearch(word).trim();
    return term ? periodPosts.filter((post) => folded.get(post.id).includes(term)) : [];
  };

  // Búsquedas, en el orden de la config.
  const searches = panelConfig.searches || [];
  searchBox.countEl.textContent = `${searches.length} ${searches.length === 1 ? 'término' : 'términos'}`;
  searchBox.listEl.replaceChildren(
    ...(searches.length
      ? searches.map((term) => panelChip('search', term, bySearch.get(normalizeSearch(term).trim()) || []))
      : [panelEmptyNote('Ninguna todavía.')])
  );

  // Palabras clave y hashtags: las que más trajeron primero.
  const keywords = panelConfig.keywords || [];
  for (const kind of ['keyword', 'hashtag']) {
    const source = PANEL_SOURCES[kind];
    const items = keywords
      .filter((word) => (kind === 'hashtag') === word.startsWith('#'))
      .map((word, i) => ({ word, posts: containing(word), i }))
      .sort((a, b) => b.posts.length - a.posts.length || a.i - b.i);
    const [one, many] = source.word;
    source.countEl.textContent = `${items.length} ${items.length === 1 ? one : many}`;
    const shown = panelExpanded[kind] ? items : items.slice(0, source.show);
    source.listEl.replaceChildren(
      ...(items.length ? shown.map(({ word, posts }) => panelChip(kind, word, posts)) : [panelEmptyNote(kind === 'hashtag' ? 'Ninguno todavía.' : 'Ninguna todavía.')])
    );
    panelMore(kind, items.length);
  }

  // Cuentas seguidas: las de más publicaciones del período primero.
  const accountsBox = PANEL_SOURCES.account;
  const byAccount = new Map();
  for (const post of periodPosts) {
    if (!byAccount.has(post.account)) byAccount.set(post.account, []);
    byAccount.get(post.account).push(post);
  }
  const accounts = (panelConfig.accounts || [])
    .map((account, i) => ({ account, posts: byAccount.get(account) || [], i }))
    .sort((a, b) => b.posts.length - a.posts.length || a.i - b.i);
  accountsBox.countEl.textContent = `${accounts.length} ${accounts.length === 1 ? 'cuenta' : 'cuentas'}`;
  const shownAccounts = panelExpanded.account ? accounts : accounts.slice(0, accountsBox.show);
  accountsBox.listEl.replaceChildren(
    ...(accounts.length ? shownAccounts.map(({ account, posts }) => panelAccountRow(account, posts)) : [panelEmptyNote('Ninguna todavía.')])
  );
  panelMore('account', accounts.length);
}

// El foco vuelve a la fuente (chip o fila) después de redibujar.
function panelFocusSource(kind, value, act) {
  const source = PANEL_SOURCES[kind];
  const node = [...source.listEl.children].find((el) => el.dataset.kind === kind && el.dataset.value === value);
  if (!node) return;
  const target = act ? node.querySelector(`[data-act="${act}"]`) : node;
  (target || node).focus({ preventScroll: true });
}

// Después de sacar una fuente, el foco pasa a la que quedó en su lugar (o
// al "+" de la caja, si era la única): cuando llega la config nueva la lista
// se redibuja sin ella y el foco quedaba en <body>. Solo si nadie lo movió.
let panelFocusAfter = null;

function panelRestoreFocus() {
  if (!panelFocusAfter) return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  const { kind, index } = panelFocusAfter;
  const source = PANEL_SOURCES[kind];
  const nodes = [...source.listEl.children].filter((el) => el.dataset.kind === kind);
  const box = source.listEl.closest('.srcbox');
  const target = nodes[Math.min(index, nodes.length - 1)] || (box && box.querySelector('.plus'));
  if (target) target.focus({ preventScroll: true });
}

// Pide confirmación (ask), la cancela (no) o saca la fuente (yes).
async function panelSourceAction(kind, value, act) {
  if (act === 'ask') {
    panelAsking = { kind, value };
    panelRenderSourcesNow();
    panelFocusSource(kind, value, 'no');
    return;
  }
  if (act === 'no') {
    panelAsking = null;
    panelRenderSourcesNow();
    panelFocusSource(kind, value);
    return;
  }
  if (act !== 'yes' || panelRemoving) return;
  const index = [...PANEL_SOURCES[kind].listEl.children].findIndex((el) => el.dataset.kind === kind && el.dataset.value === value);
  panelRemoving = true;
  panelRenderSourcesNow();
  // Si era el filtro de la lista, el filtro sale con ella.
  if (kind !== 'account' && panelIsActive(kind, value)) setSourceFilter(null);
  if (kind === 'account' && fAccValue === value) selectAccount('', ACC_ALL_LABEL, { focus: false });
  await PANEL_SOURCES[kind].remove(value);
  panelRemoving = false;
  panelAsking = null;
  // La config nueva llega por el aviso { config } y redibuja; por las dudas
  // (si falló) se redibuja igual. Hasta que llegue, el foco queda en la
  // misma fuente.
  panelRenderSourcesNow();
  panelFocusAfter = { kind, index: Math.max(0, index) };
  panelRestoreFocus();
}

// Un clic en un chip (no en la ✕): filtra la lista por esa fuente, o saca
// el filtro si ya era ese. En una cuenta, la elige en el filtro de Cuenta.
// Las fuentes se redibujan (cambia cuál está activa): el foco vuelve a la
// misma, sin mover la página.
function panelToggleFilter(kind, value) {
  if (kind === 'account') {
    selectAccount(fAccValue === value ? '' : value, fAccValue === value ? ACC_ALL_LABEL : `@${value}`, { focus: false });
  } else {
    setSourceFilter(panelIsActive(kind, value) ? null : { kind: panelFilterKind(kind), term: value });
  }
  panelFocusSource(kind, value);
}

for (const [kind, source] of Object.entries(PANEL_SOURCES)) {
  if (!source.listEl) continue;
  source.listEl.addEventListener('click', (e) => {
    const node = e.target.closest('[data-kind]');
    if (!node || !source.listEl.contains(node)) return;
    const button = e.target.closest('button[data-act]');
    if (button) {
      e.stopPropagation();
      panelSourceAction(kind, node.dataset.value, button.dataset.act);
      return;
    }
    if (!node.classList.contains('ask')) panelToggleFilter(kind, node.dataset.value);
  });
  source.listEl.addEventListener('keydown', (e) => {
    const node = e.target.closest('[data-kind]');
    if (!node) return;
    if (e.key === 'Escape' && node.classList.contains('ask')) {
      e.preventDefault();
      panelSourceAction(kind, node.dataset.value, 'no');
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === node && !node.classList.contains('ask')) {
      e.preventDefault();
      panelToggleFilter(kind, node.dataset.value);
    }
    if (e.key === 'Delete' && e.target === node && !node.classList.contains('ask')) {
      e.preventDefault();
      panelSourceAction(kind, node.dataset.value, 'ask');
    }
  });
  if (source.moreEl) {
    source.moreEl.addEventListener('click', () => {
      panelExpanded[kind] = !panelExpanded[kind];
      panelRenderSourcesNow();
    });
  }
}

// El "+" de cada caja abre (o cierra) su campo de agregar. También lo usa
// main.js al llegar desde un enlace del pie (#fuentes-…).
function panelOpenAdd(box, { toggle = false } = {}) {
  const plus = box.querySelector('.plus');
  const open = toggle ? !box.classList.contains('adding') : true;
  box.classList.toggle('adding', open);
  if (plus) plus.setAttribute('aria-expanded', String(open));
  const input = box.querySelector('.kw-add input');
  if (open && input) input.focus({ preventScroll: true });
  else if (!open && plus) plus.focus();
}

for (const box of document.querySelectorAll('.srcbox')) {
  const plus = box.querySelector('.plus');
  if (plus) plus.addEventListener('click', () => panelOpenAdd(box, { toggle: true }));
  const input = box.querySelector('.kw-add input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        panelOpenAdd(box, { toggle: true });
      }
    });
  }
}

// -------------------------------------------------------------------------
// Pulso del tono: publicaciones por hora del día (en hora de Argentina) de
// los últimos 7 días, apiladas por tono (negativo abajo, neutral, positivo
// arriba), suavizadas como en la maqueta. Al pasar el mouse por una hora,
// sus números de verdad (sin suavizar). La línea marca el pico.
// -------------------------------------------------------------------------
const panelPulseEl = document.getElementById('pulse');

function panelRenderPulse(all, now) {
  if (!panelPulseEl) return;
  const W = Math.max(200, Math.round(panelPulseEl.clientWidth || 300));
  const H = 150;
  panelPulseEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const hours = 24;
  const counts = { positivo: Array(hours).fill(0), neutral: Array(hours).fill(0), negativo: Array(hours).fill(0), sin: Array(hours).fill(0) };
  const from = now - 7 * DAY_MS;
  for (const post of all) {
    const ms = postPostedMs(post);
    if (ms === null || ms < from || ms > now) continue;
    const hour = Number(PANEL_HOUR.format(new Date(ms))) % 24;
    (counts[post.sentiment] || counts.sin)[hour] += 1;
  }
  const total = counts.positivo.map((v, h) => v + counts.neutral[h] + counts.negativo[h] + counts.sin[h]);
  const sum = total.reduce((a, b) => a + b, 0);

  const nodes = [];
  if (!sum) {
    const text = panelSvg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' });
    text.style.fill = 'var(--muted)';
    text.textContent = 'Sin publicaciones en los últimos 7 días';
    panelPulseEl.replaceChildren(text);
    return;
  }

  const smooth = (a) => a.map((v, i) => (a[(i + hours - 1) % hours] + 2 * v + a[(i + 1) % hours]) / 4);
  const neg = smooth(counts.negativo);
  const neu = smooth(counts.neutral);
  const pos = smooth(counts.positivo);
  const l1 = neg;
  const l2 = neg.map((v, i) => v + neu[i]);
  const l3 = l2.map((v, i) => v + pos[i]);
  const max = Math.max(...l3) * 1.08 || 1;
  const x = (i) => (i / (hours - 1)) * W;
  const y = (v) => H - 14 - (v / max) * (H - 26);
  const area = (top, bottom) =>
    `M${top.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}L${bottom
      .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .reverse()
      .join('L')}Z`;
  const zero = Array(hours).fill(0);
  const layer = (top, bottom, color) => {
    const path = panelSvg('path', { d: area(top, bottom), opacity: 0.85 });
    path.style.fill = color;
    return path;
  };
  const group = panelSvg('g');
  group.style.animation = 'fadeIn 1.2s both';
  group.append(layer(l1, zero, 'var(--neg)'), layer(l2, l1, 'var(--neu)'), layer(l3, l2, 'var(--pos)'));

  for (const h of [0, 6, 12, 18, 23]) {
    const label = panelSvg('text', { x: x(h), y: H - 2, 'text-anchor': h === 0 ? 'start' : h === 23 ? 'end' : 'middle' });
    label.style.fill = 'var(--muted)';
    label.textContent = `${h} h`;
    group.appendChild(label);
  }

  const peak = total.indexOf(Math.max(...total));
  const peakLine = panelSvg('line', { x1: x(peak), x2: x(peak), y1: 8, y2: H - 14, 'stroke-dasharray': '3 3', opacity: 0.6 });
  peakLine.style.stroke = 'var(--fg)';
  const peakText = panelSvg('text', { x: peak > 12 ? x(peak) - 4 : x(peak) + 4, y: 14, 'text-anchor': peak > 12 ? 'end' : 'start' });
  peakText.style.fill = 'var(--fg)';
  peakText.textContent = `pico ${peak} h`;
  group.append(peakLine, peakText);
  nodes.push(group);

  // Una franja por hora para el tooltip (tip.js lo arma con data-tip).
  const band = W / hours;
  for (let h = 0; h < hours; h++) {
    const rect = panelSvg('rect', { class: 'hr', x: Math.max(0, x(h) - band / 2), y: 0, width: band, height: H - 12 });
    const perDay = PANEL_ONE.format(total[h] / 7);
    rect.dataset.tipTitle = `${String(h).padStart(2, '0')}:00 h`;
    rect.dataset.tip =
      `${perDay} publicaciones por día\n${counts.positivo[h]} positivas · ${counts.neutral[h]} neutrales · ${counts.negativo[h]} negativas en 7 días` +
      (counts.sin[h] ? ` · ${counts.sin[h]} sin clasificar` : '');
    nodes.push(rect);
  }
  panelPulseEl.replaceChildren(...nodes);
}

// -------------------------------------------------------------------------
// Pipeline: la última corrida terminada (lastRun de /api/monitoring/status,
// src/lastRun.js): traídas por las búsquedas, nuevas que clasificó el modelo
// y relevantes guardadas; abajo, cuántas se despegaron y el costo. Sin
// corridas: "todavía no corrió".
// -------------------------------------------------------------------------
const panelPipe = {
  root: document.querySelector('.pipe'),
  hint: document.getElementById('pipeHint'),
  fetched: document.getElementById('pipeFetched'),
  fresh: document.getElementById('pipeNew'),
  saved: document.getElementById('pipeSaved'),
  model: document.getElementById('pipeModel'),
  note: document.getElementById('pipeNote'),
};
// undefined: todavía no se leyó; null: no hay respuesta del servidor.
let panelStatus;

function panelDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min} min ${rest} s` : `${min} min`;
}

// "claude-sonnet-4-5-20250929" o "anthropic/claude-sonnet-4.5" -> "Sonnet
// 4.5": sin proveedor, sin fecha y sin "claude-", para que entre en la
// columna; el nombre completo va en el tooltip.
function panelModelName(model) {
  const name = String(model || '')
    .replace(/^[^/]+\//, '')
    .replace(/-\d{8}$/, '')
    .replace(/^claude-/, '')
    .replace(/-/g, ' ')
    .replace(/(\d) (\d)/g, '$1.$2')
    .trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : '—';
}

function panelCountOrDash(value) {
  return Number.isFinite(value) ? PANEL_INT.format(value) : '—';
}

function panelRenderPipeline() {
  if (!panelPipe.root) return;
  const status = panelStatus;
  const run = status && status.lastRun;
  const model = status && status.model;
  panelPipe.model.textContent = model ? panelModelName(model) : 'modelo';
  if (model) {
    panelPipe.model.dataset.tipTitle = 'Modelo que clasifica';
    panelPipe.model.dataset.tip = model;
  }
  panelPipe.root.classList.toggle('idle', !run);
  if (!run) {
    panelPipe.hint.textContent = status === undefined ? '—' : status === null ? 'sin respuesta del servidor' : 'todavía no corrió';
    for (const el of [panelPipe.fetched, panelPipe.fresh, panelPipe.saved]) el.textContent = '—';
    panelPipe.note.textContent = '';
    return;
  }
  const finished = new Date(run.finishedAt);
  const today = AR_DAY.format(finished) === AR_DAY.format(new Date());
  const when = Number.isFinite(finished.getTime()) ? (today ? PANEL_TIME.format(finished) : `${PANEL_DATE.format(finished)} ${PANEL_TIME.format(finished)}`) : '—';
  const duration = panelDuration(run.durationSec);
  panelPipe.hint.textContent = `última corrida ${when}${duration ? ` · ${duration}` : ''}`;
  panelPipe.fetched.textContent = panelCountOrDash(run.fetched);
  panelPipe.fresh.textContent = panelCountOrDash(run.newCandidates);
  panelPipe.saved.textContent = panelCountOrDash(run.saved);
  panelPipe.fetched.closest('.st').dataset.tip = 'Resultados de las búsquedas de esa corrida.';
  panelPipe.fresh.closest('.st').dataset.tip =
    run.newCandidates === null ? 'Esta corrida es anterior al conteo de nuevas.' : 'Las que no estaban guardadas ni evaluadas: las clasificó el modelo.';
  panelPipe.saved.closest('.st').dataset.tip = 'Las relevantes, guardadas en la base.';
  const parts = [];
  if (Number.isFinite(run.highlighted)) parts.push(`${run.highlighted} ${run.highlighted === 1 ? 'se despegó' : 'se despegaron'}`);
  if (Number.isFinite(run.usd)) parts.push(`costo US$ ${PANEL_USD.format(run.usd)}`);
  panelPipe.note.textContent = parts.join(' · ');
}

async function panelLoadStatus() {
  try {
    const resp = await fetch(withPlataforma('/api/monitoring/status'));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    panelStatus = await resp.json();
  } catch (err) {
    if (panelStatus === undefined) panelStatus = null;
    console.error('Error leyendo la última corrida:', err);
  }
  panelRenderPipeline();
}

// -------------------------------------------------------------------------
// Alertas de hoy (en hora de Argentina), reglas simples sobre lo cargado:
//   - el volumen de hoy llega a 1,5 veces la mediana diaria de los 30 días
//     anteriores (días con publicaciones);
//   - la publicación de hoy que más se despegó de lo habitual de su cuenta;
//   - un tema con 2 o más publicaciones negativas hoy.
// Un clic filtra la lista (período Hoy) y baja a ella.
// -------------------------------------------------------------------------
const panelAlertsEl = document.getElementById('alerts');
const panelAlertsCountEl = document.getElementById('alertsCount');

function panelMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function panelGoToList() {
  const card = document.querySelector('.pubs-card');
  if (!card) return;
  const top = card.getBoundingClientRect().top + window.scrollY - feedBarBottom() - 12;
  window.scrollTo({ top, behavior: panelReducedMotion.matches ? 'auto' : 'smooth' });
}

// Deja la lista con los filtros de una alerta, en el período Hoy.
function panelApplyAlert(filters) {
  resetFilters();
  if (filters.q) qEl.value = filters.q;
  if (filters.sentiment) fSentEl.value = filters.sentiment;
  if (filters.tema && fTemaEl) fTemaEl.value = filters.tema;
  // Hoy, aunque hubiera un rango de Estadísticas (setMonitorPeriod lo saca
  // también si el período guardado ya era Hoy).
  setMonitorPeriod(1);
  applyFilters();
  panelGoToList();
  // Las alertas se rehacen con el período nuevo: la que tenía el foco ya no
  // está.
  focusMonitoringList();
}

function panelRenderAlerts(all, now) {
  if (!panelAlertsEl) return;
  const todayStart = argentinaDayStart(now, 0);
  const today = all.filter((post) => {
    const ms = postPostedMs(post);
    return ms !== null && ms >= todayStart && ms <= now;
  });
  const perDay = new Map();
  for (const post of all) {
    const ms = postPostedMs(post);
    if (ms === null || ms >= todayStart || ms < todayStart - 30 * DAY_MS) continue;
    const day = AR_DAY.format(new Date(ms));
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const median = panelMedian([...perDay.values()]);

  const alerts = [];
  if (perDay.size >= 3 && median > 0 && today.length >= 1.5 * median) {
    alerts.push({
      color: 'var(--c5)',
      title: `Hoy hay ${PANEL_ONE.format(today.length / median)}× lo habitual`,
      detail: `${today.length} publicaciones · lo habitual son ${PANEL_ONE.format(median).replace(/,0$/, '')} por día`,
      filters: {},
    });
  }
  const best = today
    .map((post) => ({ post, top: highlightTop(post) }))
    .filter((entry) => entry.top)
    .sort((a, b) => b.top.ratio - a.top.ratio)[0];
  if (best) {
    const account = best.post.account && best.post.account !== 'N/D' ? `@${best.post.account}` : 'una cuenta sin identificar';
    const title = best.post.title || '(sin título)';
    alerts.push({
      color: 'var(--accent)',
      title: `Se despegó ${account}`,
      // La razón lleva colchón: no se dice "N veces lo habitual".
      detail: `${title.length > 60 ? `${title.slice(0, 60)}…` : title} · ${formatBenchmarkRatio(best.top.ratio)}× en ${best.top.label}`,
      filters: { q: best.post.title || '' },
    });
  }
  const negByTema = new Map();
  for (const post of today) {
    if (post.sentiment !== 'negativo' || !post.tema) continue;
    negByTema.set(post.tema, (negByTema.get(post.tema) || 0) + 1);
  }
  const worst = [...negByTema.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 2) {
    alerts.push({
      color: 'var(--neg)',
      title: `«${worst[0]}» en negativo`,
      detail: `${worst[1]} publicaciones negativas hoy sobre ${worst[0]}`,
      filters: { sentiment: 'negativo', tema: worst[0] },
    });
  }

  panelAlertsCountEl.textContent = `${alerts.length} hoy`;
  if (!alerts.length) {
    panelAlertsEl.replaceChildren(panelNode('div', 'empty', 'Nada fuera de lo habitual hoy.'));
    return;
  }
  panelAlertsEl.replaceChildren(
    ...alerts.map((alert) => {
      const button = panelNode('button', 'al');
      button.type = 'button';
      const dot = panelNode('i');
      dot.style.background = alert.color;
      dot.setAttribute('aria-hidden', 'true');
      const body = panelNode('span');
      body.append(panelNode('b', '', alert.title), panelNode('small', '', alert.detail));
      button.append(dot, body);
      button.addEventListener('click', () => panelApplyAlert(alert.filters));
      return button;
    })
  );
}

// -------------------------------------------------------------------------
// Dibujo. Se rehace cuando cambian los datos (posteos, sentimientos,
// métricas) o el período; si solo cambió el filtro por fuente, solo las
// fuentes. Un cambio de los otros filtros no toca el panel.
// -------------------------------------------------------------------------
let panelLastData = null;
let panelLastSources = null;

// Las 00:00 (Argentina) del día del primer posteo cargado; Infinity sin
// ninguno.
function panelFirstDayStart(all) {
  let first = Infinity;
  for (const post of all) {
    const ms = postPostedMs(post);
    if (ms !== null && ms < first) first = ms;
  }
  return Number.isFinite(first) ? argentinaDayStart(first, 0) : Infinity;
}

function panelDataKey(all, from, to) {
  return `${from}-${to}|${all.map((p) => `${p.id}:${p.sentiment || ''}:${p.likes}:${p.comments}`).join(',')}`;
}

function panelRenderSourcesNow() {
  const periodPosts = monitorPeriodPosts();
  panelLastSources = null;
  panelRenderSources(periodPosts);
}

function panelRender() {
  if (!monitoringTable) return;
  const now = Date.now();
  const from = monitorPeriodStart(now);
  const to = monitorPeriodEnd();
  const all = monitoringTable.getData();
  const dataKey = panelDataKey(all, from, to);
  const sourcesKey = `${dataKey}|${sourceFilterKey(monitorSourceFilter)}|${fAccValue}|${panelConfig === undefined ? 'u' : panelConfig === null ? 'n' : 'c'}`;
  if (dataKey !== panelLastData) {
    panelLastData = dataKey;
    const posts = all.filter((post) => postInPeriod(post, from, to));
    // El anterior, del mismo largo: con Hoy / 7 / 30, lo que va del período;
    // con un rango de Estadísticas, sus días enteros (el mismo anterior que
    // allá). Los tramos del trazo llegan hasta ahora o hasta el fin del rango.
    const length = (to === null ? now : to) - from;
    const previous = all.filter((post) => {
      const ms = postPostedMs(post);
      return ms !== null && ms >= from - length && ms < from;
    });
    // Con un rango cuyo anterior arranca antes del primer posteo cargado, no
    // hay con qué comparar ("sin datos", null), como en Estadísticas.
    const complete = to === null || from - length >= panelFirstDayStart(all);
    panelRenderKpis(posts, complete ? previous : null, from, to === null ? now : Math.min(to, now));
    panelRenderPulse(all, now);
    panelRenderAlerts(all, now);
  }
  if (sourcesKey !== panelLastSources) {
    panelLastSources = sourcesKey;
    panelRenderSources(all.filter((post) => postInPeriod(post, from, to)));
  }
}

monitoringViewListeners.push((change) => {
  if (change && 'config' in change) {
    panelConfig = change.config;
    panelLastSources = null;
    panelRender();
    if (!monitoringTable) panelRenderSources([]);
    panelRestoreFocus();
    panelFocusAfter = null;
    return false;
  }
  if (change && change.run === 'end') {
    panelLoadStatus();
    return false;
  }
  if (change && (change.run || change.goToId !== undefined)) return false;
  panelRender();
  return false;
});

// El pulso se dibuja al ancho real (los textos no se estiran): se rehace si
// cambia, por ejemplo al pasar de tres columnas a dos.
if (panelPulseEl && typeof ResizeObserver === 'function') {
  let pulseWidth = 0;
  new ResizeObserver(() => {
    const width = Math.round(panelPulseEl.clientWidth);
    if (!width || width === pulseWidth || !monitoringTable) return;
    pulseWidth = width;
    panelRenderPulse(monitoringTable.getData(), Date.now());
  }).observe(panelPulseEl);
}

// Los posteos o la config pudieron llegar antes de que se cargara este
// archivo.
panelRender();
if (!monitoringTable) panelRenderSources([]);
panelRenderPipeline();
panelLoadStatus();
setInterval(panelLoadStatus, 5 * 60 * 1000);
