// El medidor: barras de amplitud que dan la señal de "hay actividad".
// Recorre .meter[data-meter], genera N barras <i> con pico/duración/
// desfasaje aleatorios para que el conjunto no lata al unísono. Se anima
// con transform:scaleY (compone en GPU, no dispara layout/repaint en cada
// frame), nunca con height.

document.querySelectorAll('.meter[data-meter]').forEach((m) => {
  const n = Number(m.dataset.meter) || 5;
  for (let i = 0; i < n; i++) {
    const bar = document.createElement('i');
    bar.style.setProperty('--peak', (0.34 + Math.random() * 0.62).toFixed(3));
    bar.style.setProperty('--dur', (1.05 + Math.random() * 1.5).toFixed(2) + 's');
    bar.style.setProperty('--delay', (-Math.random() * 2).toFixed(2) + 's');
    m.appendChild(bar);
  }
});
