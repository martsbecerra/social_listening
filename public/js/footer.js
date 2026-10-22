// Pie de página de las páginas con sesión (instagram.html, x.html y
// dashboard.html), el de design/social-listening-v4.html. Lo arma este
// archivo, una sola vez, en el <footer id="siteFooter"> vacío de cada página.
//
// - El marcado es fijo y propio. Lo que cambia entra por textContent: las
//   corridas del día (/api/footer-stats), el año y el nombre del usuario.
// - El nombre y "Cerrar sesión" los atiende main.js, con la misma sesión
//   de la barra superior ([data-user-name], [data-logout]).
// - Los enlaces navegan de verdad: a una solapa (instagram.html#tab-…), a
//   una caja de fuentes del Monitoreo (instagram.html#fuentes-…, lo atiende
//   main.js), a la página de cada plataforma. Estadísticas, Facebook y
//   TikTok todavía no tienen pantalla: van sin enlace, con "pronto".
// - Si un dato no está, su línea no se muestra: nunca se inventa.

const FOOTER_HTML = `
  <div class="foot-in">
    <div class="about">
      <a class="brand" href="dashboard.html"><span class="logo" aria-hidden="true">◎</span><span>Social Listening<small>DGAYD · GCBA</small></span></a>
      <p>Una herramienta de la Dirección General de Análisis y Datos para escuchar lo que se dice en redes, medir cómo se dice y convertir los reclamos en un punto del mapa.</p>
      <div class="runs hidden" id="footerRuns"><i aria-hidden="true"></i><span></span></div>
    </div>
    <div>
      <h4>Secciones</h4>
      <ul>
        <li><a href="instagram.html#tab-monitoring">Monitoreo</a></li>
        <li><a href="instagram.html#tab-claims-map">Mapa de reclamos</a></li>
        <li><a href="instagram.html#tab-analysis">Análisis de publicación</a></li>
        <li><span class="off" title="Pronto">Estadísticas · pronto</span></li>
      </ul>
    </div>
    <div>
      <h4>Fuentes</h4>
      <ul>
        <li><a href="instagram.html#fuentes-busquedas">Búsquedas</a></li>
        <li><a href="instagram.html#fuentes-palabras">Palabras clave</a></li>
        <li><a href="instagram.html#fuentes-hashtags">Hashtags</a></li>
        <li><a href="instagram.html#fuentes-cuentas">Cuentas seguidas</a></li>
      </ul>
    </div>
    <div>
      <h4>Plataformas</h4>
      <ul>
        <li><a href="instagram.html">Instagram</a></li>
        <li><a href="x.html">X</a></li>
        <li><span class="off">Facebook · pronto</span></li>
        <li><span class="off">TikTok · pronto</span></li>
      </ul>
    </div>
    <div>
      <h4>Cuenta</h4>
      <ul>
        <li><span data-user-name></span></li>
        <li><button type="button" class="foot-logout" data-logout>Cerrar sesión</button></li>
        <li><a href="dashboard.html">Elegir plataforma</a></li>
      </ul>
    </div>
    <div class="copy">
      <span>DGAYD · Subsecretaría de Comunicación Digital · GCBA · <span id="footerYear"></span></span>
      <span>Instagram vía Apify · clasificación con Claude</span>
    </div>
  </div>`;

// [8, 12, 16, 20] -> "8, 12, 16 y 20"
function footerHoursText(hours) {
  const list = hours.map(String);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
}

// "4 corridas por día · 8, 12, 16 y 20 h"
function footerRunsText(stats) {
  const perDay = Number(stats.corridasPorDia);
  if (!Number.isFinite(perDay) || perDay <= 0) return '';
  const hours = Array.isArray(stats.runHours) ? stats.runHours : [];
  const base = `${perDay} ${perDay === 1 ? 'corrida' : 'corridas'} por día`;
  // Con muchas corridas la lista de horas no se lee: queda solo el número.
  if (hours.length === 0 || hours.length > 8) return base;
  return `${base} · ${footerHoursText(hours)} h`;
}

async function loadFooterStats() {
  const runsEl = document.getElementById('footerRuns');
  if (!runsEl) return;
  try {
    const resp = await fetch('/api/footer-stats');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = footerRunsText(await resp.json());
    runsEl.querySelector('span').textContent = text;
    runsEl.classList.toggle('hidden', !text);
  } catch (err) {
    runsEl.classList.add('hidden');
    console.error('Error cargando los datos del pie:', err);
  }
}

function renderSiteFooter() {
  const footerEl = document.getElementById('siteFooter');
  if (!footerEl) return;
  footerEl.classList.add('foot');
  // Constante propia, sin ningún dato de afuera: se puede insertar como HTML.
  footerEl.innerHTML = FOOTER_HTML;
  footerEl.querySelector('#footerYear').textContent = String(new Date().getFullYear());
  // Si la sesión ya llegó antes que el pie, el nombre se completa acá.
  if (typeof fillUserNames === 'function') fillUserNames(footerEl);
  loadFooterStats();
}

renderSiteFooter();
