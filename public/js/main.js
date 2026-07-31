// Cambio de solapas (tabs) y dropdown del header. Sin lógica de negocio.

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));

    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// Dropdown de usuario: solo visual, sin autenticación real todavía.
// Hay una instancia por solapa (Análisis / Monitoreo), cada una con su botón
// y su dropdown propios.
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
