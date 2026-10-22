// Tooltip global (diseño v4, .tip en styles.css). Cualquier elemento con
// data-tip lo muestra al pasar el mouse o al recibir el foco: el título en
// data-tip-title (opcional) y el texto en data-tip, con "\n" para cortar
// renglones. Todo entra por textContent, nunca como HTML: hay tooltips con
// datos de los posteos y de las cuentas.

const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.setAttribute('role', 'tooltip');
tipEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(tipEl);

let tipOwner = null;

function tipFill(owner) {
  const title = owner.dataset.tipTitle || '';
  const text = owner.dataset.tip || '';
  const parts = [];
  if (title) {
    const b = document.createElement('b');
    b.textContent = title;
    parts.push(b);
  }
  if (text) parts.push(document.createTextNode(text));
  tipEl.replaceChildren(...parts);
}

// Al lado del puntero y sin salirse de la ventana.
function tipMove(x, y) {
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let left = x + 14;
  let top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, top)}px`;
}

function tipShow(owner, x, y) {
  if (!owner.dataset.tip && !owner.dataset.tipTitle) return;
  tipOwner = owner;
  tipFill(owner);
  tipEl.classList.add('on');
  tipMove(x, y);
}

function tipHide() {
  tipOwner = null;
  tipEl.classList.remove('on');
}

document.addEventListener('mouseover', (e) => {
  const owner = e.target instanceof Element ? e.target.closest('[data-tip], [data-tip-title]') : null;
  if (owner && owner !== tipOwner) tipShow(owner, e.clientX, e.clientY);
});
document.addEventListener('mousemove', (e) => {
  if (tipOwner && tipOwner.contains(e.target)) tipMove(e.clientX, e.clientY);
});
document.addEventListener('mouseout', (e) => {
  if (!tipOwner) return;
  const to = e.relatedTarget;
  if (!to || !tipOwner.contains(to)) tipHide();
});
// Con el teclado: debajo del elemento enfocado.
document.addEventListener('focusin', (e) => {
  const owner = e.target instanceof Element ? e.target.closest('[data-tip], [data-tip-title]') : null;
  if (!owner) return;
  const rect = owner.getBoundingClientRect();
  tipShow(owner, rect.left, rect.bottom);
});
document.addEventListener('focusout', tipHide);
document.addEventListener('scroll', tipHide, { passive: true, capture: true });
