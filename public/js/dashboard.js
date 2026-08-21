// Línea de estado de cada tarjeta de plataforma: cuántas menciones se
// detectaron en los últimos 7 días. Si el fetch falla directamente, se
// oculta la línea en vez de mostrar un dato inventado; si la plataforma
// todavía no tiene monitoreo implementado (no viene en la respuesta), se
// avisa en texto en vez de mostrar "0".

async function loadPlatformCounts() {
  const cards = document.querySelectorAll('.plat[data-platform]');
  if (cards.length === 0) return;

  try {
    const resp = await fetch('/api/monitoring/counts');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const counts = await resp.json();

    cards.forEach((card) => {
      const stateEl = card.querySelector('.plat-state');
      if (!stateEl) return;
      const platform = card.dataset.platform;
      const count = counts[platform];
      if (Number.isFinite(count)) {
        stateEl.innerHTML = `<b>${count.toLocaleString('es-AR')}</b> menciones esta semana`;
      } else {
        stateEl.textContent = 'Sin datos todavía';
      }
    });
  } catch (err) {
    cards.forEach((card) => {
      const stateEl = card.querySelector('.plat-state');
      if (stateEl) stateEl.classList.add('hidden');
    });
    console.error('Error cargando el resumen de menciones:', err);
  }
}

loadPlatformCounts();
