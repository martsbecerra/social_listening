// Tema claro u oscuro (diseño v4). La app arranca SIEMPRE clara, aunque el
// sistema esté en oscuro; el botón de la barra superior ([data-theme-toggle])
// la pasa a oscura y vuelve. La elección se recuerda en este navegador
// (localStorage "sl.tema": "oscuro" | "claro"); sin almacenamiento (modo
// privado, bloqueado) vale la clara y no se recuerda nada.
//
// Se carga en el <head>, antes que styles.css pinte nada: así una página en
// oscuro no aparece un instante en claro. Las páginas del login no tienen
// botón, pero respetan lo elegido.

const THEME_KEY = 'sl.tema';
const THEME_COLOR = { claro: '#f3f5fb', oscuro: '#0b1020' };

function themeRead() {
  try {
    return localStorage.getItem(THEME_KEY) === 'oscuro' ? 'oscuro' : 'claro';
  } catch {
    return 'claro';
  }
}

function themeSave(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* sin persistencia: vale para esta página nada más */
  }
}

// Siempre "light" o "dark", nunca sin marcar: así ninguna regla que mire el
// tema del sistema puede pintar la página en oscuro sin el botón.
function themeApply(theme) {
  const dark = theme === 'oscuro';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"][data-follow-theme]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Pasar al tema claro' : 'Pasar al tema oscuro');
    btn.dataset.tipTitle = dark ? 'Tema oscuro' : 'Tema claro';
    btn.dataset.tip = dark ? 'Click: volver al claro.' : 'Click: pasar al oscuro.';
  });
}

themeApply(themeRead());

document.addEventListener('DOMContentLoaded', () => {
  themeApply(themeRead());
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'claro' : 'oscuro';
      themeSave(next);
      themeApply(next);
    });
  });
});
