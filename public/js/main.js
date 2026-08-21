// Cambio de solapas (tabs) y dropdown del header. Sin lógica de negocio.

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));

    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');

    if (btn.dataset.tab === 'claims-map' && typeof window.refreshClaimsMap === 'function') {
      window.refreshClaimsMap();
    }
  });
});

// Dropdown de usuario: solo visual, sin autenticación real todavía.
// El dropdown vive en la barra de tabs (Análisis / Monitoreo / Mapa de reclamos).
document.querySelectorAll('.user-btn').forEach((btn) => {
  const dropdown = document.getElementById(btn.dataset.dropdown);
  if (!dropdown) return;

  btn.addEventListener('click', () => {
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
});

// Atajos del pie de página: si la URL trae #tab-analysis / #tab-monitoring /
// #tab-claims-map, abre esa solapa al cargar. Dispara el mismo click que ya
// usa el usuario — no es un camino de navegación nuevo.
if (location.hash.startsWith('#tab-')) {
  const targetTab = location.hash.slice('#tab-'.length);
  document.querySelector(`.tab-btn[data-tab="${targetTab}"]`)?.click();
}
