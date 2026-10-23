// --------------------------------------------------------------------
// Tarjetas KPI del diseño v4 (design/social-listening-v4.html), las mismas
// en el Monitoreo (monitoringPanel.js) y en Estadísticas (stats.js): el
// rótulo, el número que sube de 0, el detalle y, en la esquina, el trazo de
// los tramos o el anillo. Estilos (.kpi) en public/css/styles.css.
//
// Lo carga SOLO instagram.html, antes de monitoringPanel.js y stats.js.
// Script clásico: todo lo suyo lleva prefijo kpi / KPI_. Todo dato entra
// por textContent.
// --------------------------------------------------------------------
const KPI_SVG = 'http://www.w3.org/2000/svg';
const KPI_INT = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const kpiReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function kpiNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function kpiSvg(tag, attrs = {}) {
  const node = document.createElementNS(KPI_SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

// Sube de 0 al número en un instante, como en la maqueta (sin movimiento:
// directo al final).
function kpiCountUp(el, target, format) {
  if (kpiReducedMotion.matches) {
    el.textContent = format(target);
    return;
  }
  const started = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - started) / 1000);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = format(target * eased);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// El trazo chico de la esquina, con su relleno en degradé. Un tramo en null
// (un porcentaje sin publicaciones) no es un cero: no lleva punto y el trazo
// une los vecinos. Con menos de dos tramos con dato no hay trazo.
function kpiSparkline(values, id) {
  const w = 92;
  const h = 34;
  const known = values.map((v, i) => [i, v]).filter(([, v]) => v !== null && Number.isFinite(v));
  if (known.length < 2) return null;
  const max = Math.max(...known.map(([, v]) => v));
  const min = Math.min(...known.map(([, v]) => v));
  const points = known.map(([i, v]) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / (max - min || 1)) * (h - 8)]);
  const d = `M${points.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L')}`;
  const svg = kpiSvg('svg', { class: 'sp', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const gradient = kpiSvg('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(
    kpiSvg('stop', { offset: 0, 'stop-color': 'var(--accent)', 'stop-opacity': 0.45 }),
    kpiSvg('stop', { offset: 1, 'stop-color': 'var(--accent)', 'stop-opacity': 0 })
  );
  const defs = kpiSvg('defs');
  defs.appendChild(gradient);
  const first = points[0];
  const last = points[points.length - 1];
  const area = kpiSvg('path', { d: `${d}L${last[0].toFixed(1)},${h}L${first[0].toFixed(1)},${h}Z`, fill: `url(#${id})` });
  const line = kpiSvg('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', pathLength: 1 });
  line.style.stroke = 'var(--accent)';
  line.style.strokeDasharray = '1';
  line.style.strokeDashoffset = '1';
  line.style.animation = 'draw 1.4s ease forwards';
  const dot = kpiSvg('circle', { cx: last[0], cy: last[1], r: 3 });
  dot.style.fill = 'var(--accent)';
  svg.append(defs, area, line, dot);
  return svg;
}

// El anillo del tono neto: qué parte de 100 puntos ocupa, en verde o rojo.
function kpiRing(share, color) {
  const svg = kpiSvg('svg', { class: 'ring', viewBox: '0 0 52 52', 'aria-hidden': 'true' });
  const track = kpiSvg('circle', { cx: 26, cy: 26, r: 21, fill: 'none', 'stroke-width': 6 });
  track.style.stroke = 'var(--line)';
  const value = kpiSvg('circle', {
    cx: 26,
    cy: 26,
    r: 21,
    fill: 'none',
    'stroke-width': 6,
    'stroke-linecap': 'round',
    'stroke-dasharray': 132,
    'stroke-dashoffset': 132,
    transform: 'rotate(-90 26 26)',
  });
  value.style.stroke = color;
  value.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)';
  svg.append(track, value);
  requestAnimationFrame(() => requestAnimationFrame(() => value.setAttribute('stroke-dashoffset', String(132 - 132 * share))));
  return svg;
}

// "+12 % vs. período anterior" contra el período anterior del mismo largo.
// previous null: ese período no tiene datos (no es lo mismo que cero).
function kpiDelta(current, previous) {
  const b = kpiNode('b');
  if (previous === null) {
    b.className = 'flat';
    b.textContent = 'sin datos';
    return [b, ' del período anterior'];
  }
  if (!previous) {
    b.className = 'flat';
    b.textContent = current ? 'sin publicaciones' : '—';
    return [b, ' en el período anterior'];
  }
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) {
    b.className = 'flat';
    b.textContent = 'igual';
    return [b, ' que el período anterior'];
  }
  if (change < 0) b.className = 'neg';
  b.textContent = `${change > 0 ? '+' : ''}${change} %`;
  return [b, ' vs. período anterior'];
}

// Una tarjeta KPI: rótulo, número (sube de 0), detalle y, en la esquina, el
// trazo de los tramos o el anillo. value null: "—" (sin dato). `id` hace
// único el degradé del trazo en la página.
function kpiCard({ id, label, value, format = (n) => KPI_INT.format(Math.round(n)), detail, spark, ring }) {
  const sparkSvg = spark ? kpiSparkline(spark, `kpiSpark-${id}`) : null;
  const card = kpiNode('div', `card kpi${sparkSvg ? ' has-sp' : ''}`);
  const v = kpiNode('div', 'v num', value === null ? '—' : format(0));
  if (value === null) v.classList.add('na');
  const d = kpiNode('div', 'd');
  d.append(...detail);
  card.append(kpiNode('div', 'eyebrow', label), v, d);
  if (sparkSvg) card.appendChild(sparkSvg);
  if (ring) card.appendChild(kpiRing(ring.share, ring.color));
  if (value !== null) kpiCountUp(v, value, format);
  return card;
}
