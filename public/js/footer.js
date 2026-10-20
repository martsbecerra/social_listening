// Pie de página de las páginas con sesión (instagram.html, x.html y
// dashboard.html). Lo arma este archivo, una sola vez, en el
// <footer id="siteFooter"> vacío de cada página: antes el marcado estaba
// repetido en cada HTML. Es el pie de design/riel-radar-v3.html.
//
// - El marcado es fijo y propio. Lo que cambia entra por textContent: las
//   corridas del día (/api/footer-stats) y el nombre del usuario.
// - El nombre y "Cerrar sesión" los atiende main.js, con la misma sesión
//   del encabezado ([data-user-name], [data-logout]).
// - Los enlaces navegan de verdad: a una solapa (instagram.html#tab-…), al
//   panel de fuentes (instagram.html#fuentes-…, lo abre rail.js), a la página
//   de cada plataforma. Facebook y TikTok todavía no tienen página: van sin
//   enlace. Estadísticas va deshabilitado, como en el riel, hasta que exista
//   su pantalla.
// - Si un dato no está, su línea no se muestra: nunca se inventa.
//
// Las páginas sin sesión (index.html, login-verify.html) tienen su pie chico:
// acá solo se les completa el año.

const FOOTER_HTML = `
  <div class="foot-in">
    <div class="foot-about">
      <a class="brand" href="dashboard.html">
        <div class="meter" data-meter="5"></div>
        <span class="brand-name"><span>social</span> <b>listening</b></span>
      </a>
      <p>Una herramienta de DGAYD para escuchar lo que se dice en redes, medir cómo se dice y convertir los reclamos en un punto del mapa.</p>
      <p class="foot-meta hidden" id="footerRuns"></p>
    </div>
    <div>
      <h4>Secciones</h4>
      <ul>
        <li><a href="instagram.html#tab-monitoring">Monitoreo en vivo</a></li>
        <li><span class="foot-off" aria-disabled="true" title="Pronto">Estadísticas</span></li>
        <li><a href="instagram.html#tab-claims-map">Mapa de reclamos</a></li>
        <li><a href="instagram.html#tab-analysis">Análisis de publicación</a></li>
      </ul>
    </div>
    <div>
      <h4>Fuentes</h4>
      <ul>
        <li><a href="instagram.html#fuentes-busquedas">Búsquedas por palabra clave</a></li>
        <li><a href="instagram.html#fuentes-cuentas">Cuentas trackeadas</a></li>
        <li><a href="instagram.html#fuentes-palabras">Palabras clave y hashtags</a></li>
      </ul>
    </div>
    <div>
      <h4>Plataformas</h4>
      <ul>
        <li><a href="instagram.html">Instagram</a></li>
        <li><a href="x.html">X</a></li>
        <li><span>Facebook</span></li>
        <li><span>TikTok</span></li>
        <li><a href="dashboard.html">Elegir plataforma</a></li>
      </ul>
    </div>
    <div>
      <h4>Cuenta</h4>
      <ul>
        <li><span data-user-name></span></li>
        <li><button type="button" class="foot-logout" data-logout>Cerrar sesión</button></li>
      </ul>
    </div>
  </div>`;

// [8, 12, 16, 20] -> "8, 12, 16 y 20"
function footerHoursText(hours) {
  const list = hours.map(String);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`;
}

// "4 corridas por día, a las 8, 12, 16 y 20."
function footerRunsText(stats) {
  const perDay = Number(stats.corridasPorDia);
  if (!Number.isFinite(perDay) || perDay <= 0) return '';
  const hours = Array.isArray(stats.runHours) ? stats.runHours : [];
  const base = `${perDay} ${perDay === 1 ? 'corrida' : 'corridas'} por día`;
  // Con muchas corridas la lista de horas no se lee: queda solo el número.
  if (hours.length === 0 || hours.length > 8) return `${base}.`;
  return `${base}, a ${hours.length === 1 && hours[0] === 1 ? 'la' : 'las'} ${footerHoursText(hours)}.`;
}

async function loadFooterStats() {
  const runsEl = document.getElementById('footerRuns');
  if (!runsEl) return;
  try {
    const resp = await fetch('/api/footer-stats');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = footerRunsText(await resp.json());
    runsEl.textContent = text;
    runsEl.classList.toggle('hidden', !text);
  } catch (err) {
    runsEl.classList.add('hidden');
    console.error('Error cargando los datos del pie:', err);
  }
}

function renderSiteFooter() {
  const footerEl = document.getElementById('siteFooter');
  if (!footerEl) return;
  footerEl.classList.add('foot', 'foot-site');
  // Constante propia, sin ningún dato de afuera: se puede insertar como HTML.
  footerEl.innerHTML = FOOTER_HTML;
  if (typeof fillMeters === 'function') fillMeters(footerEl);
  loadFooterStats();
}

const footerYearEl = document.getElementById('footerYear');
if (footerYearEl) footerYearEl.textContent = new Date().getFullYear();

renderSiteFooter();
