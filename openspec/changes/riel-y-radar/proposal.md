# Proposal: riel-y-radar

## Intent

Llevar a `public/instagram.html` el rediseño aprobado en
`design/riel-radar-v3.html`. En lugar de las solapas va un riel lateral
oscuro. Arriba del Monitoreo va una franja oscura con el radar de las
publicaciones del día, y el resto de la página queda en claro. Las fuentes
del monitoreo (búsquedas, cuentas, palabras) dejan de ocupar la parte de
arriba de la página y se abren en un panel desde el riel. El pie nuevo vale
para todas las páginas con sesión.

Es la fase 1 de seis del rediseño. Las decisiones que la maqueta dejaba
abiertas las tomó el dueño el 20 de octubre de 2026 y están en `design.md`.

## Scope

### In Scope

- Riel: Monitoreo, Estadísticas (deshabilitado hasta la fase 3), Mapa y
  Análisis; debajo, Fuentes con sus contadores; al pie, "DGAYD 2026"
- Monitoreo como solapa por defecto, y la solapa en el hash de la URL
- Panel de fuentes con las tres listas completas, con los mismos ids y la
  misma lógica de `monitoring.js`
- Franja del Monitoreo: estado real de la escucha (última y próxima
  corrida), "Actualizar ahora", el radar, la leyenda y el recuadro de
  progreso de siempre (mismos ids, mismo polling)
- El radar: las publicaciones de hoy de la tabla ya filtrada, en canvas
- `GET /api/monitoring/status` con `lastRunAt` y `runHours`;
  `GET /api/footer-stats` con `runHours`
- "Se despegaron" en tiras (hasta 4) con selector de sentimiento
- Fila de herramientas como la maqueta, Feed primero y por defecto, y el
  título "Publicaciones detectadas" con "N de M"
- Medidor de alcance de cinco barras en el pie de la tarjeta del feed y en
  una columna nueva "Alcance" de la tabla (solo Instagram)
- Pie armado por `public/js/footer.js` en `instagram.html`, `x.html` y
  `dashboard.html`: DGAYD y las columnas Secciones, Fuentes, Plataformas y
  Cuenta

### Out of Scope

- `x.html` (solo cambia el pie), `dashboard.html` (solo cambia el pie; se
  rehace en la fase 4), `index.html` y `login-verify.html` (fase 4)
- La pantalla de Estadísticas (fases 2 y 3), Análisis (fase 5) y el Mapa
- El pop-up, ignorar, cambiar sentimiento, el orden y la paginación de la
  tabla
- Librerías nuevas o cualquier cosa por CDN

## Capabilities

### New Capabilities

- `riel-y-radar`: navegación por riel, panel de fuentes y radar del día en
  el Monitoreo de Instagram

### Modified Capabilities

- Ninguna de las registradas en `openspec/`. El feed, el pop-up y el
  progreso tienen sus propios cambios (`monitoreo-feed`, `monitoreo-popup`,
  `monitoreo-progreso-lista`) y siguen valiendo.

## Approach

Se porta de la maqueta el CSS, el marcado y las funciones de dibujo, sin
sus datos simulados. Los datos salen de lo que ya existe:

- la tabla filtrada (`monitoringTable.getData('active')`);
- `benchmark.top` del listado;
- `/api/monitoring/status`, que suma la última corrida guardada en
  `monitoring_runs` y las horas de `MONITOR_CRON`.

`monitoring.js` sigue siendo el dueño de la configuración, la tabla y
"Actualizar ahora". Los archivos nuevos (`rail.js`, `monitoringRadar.js`)
dibujan y escuchan. Detalle en `design.md`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/scheduler.js` | Modified | `getRunHours()` con las horas de `MONITOR_CRON` |
| `src/db.js` | Modified | `getLastFinishedRunAt(plataforma)` sobre `monitoring_runs` |
| `server.js` | Modified | `/api/monitoring/status` y `/api/footer-stats` suman sus campos |
| `public/instagram.html` | Modified | Riel, franja, panel de fuentes, contenido claro, lugar del pie |
| `public/x.html`, `public/dashboard.html` | Modified | Solo el lugar del pie |
| `public/css/styles.css` | Modified | Riel, franja, radar, panel, tiras, medidor y pie nuevo |
| `public/js/main.js` | Modified | Solapas por `[data-tab]`, hash, nombre y "Cerrar sesión" del pie |
| `public/js/footer.js` | Modified | Arma el pie entero |
| `public/js/rail.js` | New | Panel de fuentes |
| `public/js/monitoringRadar.js` | New | Radar y línea de estado |
| `public/js/monitoring.js` | Modified | Cambios mínimos: listas completas en el panel, contadores, tiras, columna Alcance, porcentaje, avisos de la corrida |
| `public/js/monitoringFeed.js` | Modified | Medidor en el pie de la tarjeta, Feed por defecto |
| `test/schedulerCron.test.js`, `test/ultimaCorrida.test.js` | Modified / New | Horas de corrida y última corrida por plataforma |
| `README.md`, `CLAUDE.md` | Modified | El riel y el radar |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| El piloto sirve `public/` desde la carpeta del repo y ve el trabajo a medias | High | Se trabaja en un worktree aparte |
| Clases de la maqueta que chocan con las de hoy (`.status`, `.chip`, `.add-row`, `.btn-ghost`, `.btn`, `.sec-head`) | High | Las versiones oscuras van con alcance (`.src-panel`, `.sky`) o con nombre propio |
| `x.html` comparte `monitoring.js` y se rompe | Med | Todo lo nuevo chequea que su elemento exista; `x.html` se prueba en cada paso |
| El canvas anima todo el tiempo y gasta | Med | Solo los posteos de hoy; la animación se frena con la solapa oculta, la pestaña en segundo plano o sin nada que animar |
| Un dato del posteo interpretado como HTML | Low | Tiras, tooltip, panel y pie entran por `textContent` |
| El medidor le suma alto a la tarjeta | Med | Va en el pie, al lado del selector; se mide en la tarjeta de 240 px |

## Rollback Plan

Revertir los commits de la rama. No hay cambios de datos ni de esquema.

## Success Criteria

- [ ] El riel reemplaza a las solapas; Monitoreo abre por defecto y la solapa queda en el hash
- [ ] El panel de fuentes agrega y quita igual que las cajas de antes, con las listas completas
- [ ] La franja muestra la última y la próxima corrida reales y el progreso de siempre
- [ ] El radar dibuja los posteos de hoy de la tabla filtrada, con hover cruzado y clic al pop-up
- [ ] "Actualizar ahora" barre el radar y los posteos nuevos entran con ondas
- [ ] Sin movimiento con `prefers-reduced-motion`
- [ ] "Se despegaron" en tiras y el medidor de alcance en tarjetas y tabla
- [ ] El pie nuevo en Instagram, X e inicio
- [ ] `x.html` y el inicio siguen andando
- [ ] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify`
