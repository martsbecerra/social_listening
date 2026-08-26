// Pie de página (las 3 páginas): año dinámico + datos reales de
// /api/footer-stats. Mismo criterio que dashboard.js con .plat-state: si un
// dato no está disponible, se oculta la línea en vez de inventarlo.

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

async function loadFooterStats() {
  const pulseEl = document.getElementById('footerPulse');
  try {
    const resp = await fetch('/api/footer-stats');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const stats = await resp.json();

    const plataformasEl = document.getElementById('footerPlataformas');
    const corridasEl = document.getElementById('footerCorridas');
    const tematicasEl = document.getElementById('footerTematicas');
    if (plataformasEl) plataformasEl.textContent = stats.plataformaCount;
    if (corridasEl) corridasEl.textContent = stats.corridasPorDia;
    if (tematicasEl) tematicasEl.textContent = stats.categoriaCount;

    if (pulseEl) {
      if (stats.lastRunAt) {
        const hora = new Date(stats.lastRunAt).toLocaleTimeString('es-AR', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const textEl = document.getElementById('footerPulseText');
        if (textEl) textEl.textContent = `Escuchando · última corrida ${hora}`;
        pulseEl.classList.remove('hidden');
      } else {
        pulseEl.classList.add('hidden');
      }
    }
  } catch (err) {
    if (pulseEl) pulseEl.classList.add('hidden');
    console.error('Error cargando los datos del pie:', err);
  }
}

loadFooterStats();
