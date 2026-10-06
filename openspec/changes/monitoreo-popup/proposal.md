# Proposal: monitoreo-popup

## Intent

Reemplazar el "Ver más" del feed del Monitoreo de Instagram, que abría la
fila de tarjetas, por un **pop-up** con el posteo completo: la foto a la
izquierda y, a la derecha, el texto, las métricas contra la mediana de la
cuenta y las acciones. Desde el pop-up se pasa al posteo anterior y al
siguiente sin volver a la lista.

La maqueta aprobada por el dueño es `design/monitoreo-popup.html`. Lo que la
maqueta no resuelve se decidió con el dueño y quedó en `design.md`.

## Scope

### In Scope

- Pop-up que se abre con "Ver más" y con un clic en la foto de la tarjeta
- Cierre con la ✕, con Esc y con un clic afuera; foco al abrir y al cerrar;
  sin scroll de fondo; pantalla completa en celular
- Navegación por la lista filtrada: flechas en pantalla, ← → y contador
- Sentimiento e ignorar dentro del pop-up, con las funciones que ya usan la
  tabla y las tarjetas; la confirmación de ignorar va adentro
- Lado de la foto: recuadro "Imagen no disponible" con el tipo, y un único
  punto donde enchufar la imagen cuando exista
- Sacar el código y los estilos de la fila desplegada

### Out of Scope

- Backend, base de datos y Apify: el pop-up usa los datos que el feed ya tiene
- La imagen del posteo (cambio siguiente: fotos)
- La tabla y X
- `public/js/monitoring.js`: no se toca

## Capabilities

### New Capabilities

- `monitoreo-popup`: pop-up del posteo en el feed de Instagram

### Modified Capabilities

- `monitoreo-feed`: REQ-FEED-09 ("Ver más" por fila visual) se reemplaza por
  el pop-up

## Approach

Un `<dialog>` del navegador abierto con `showModal()`: trae el foco atrapado
adentro, el fondo inactivo y Esc. Todo el pop-up vive en un archivo nuevo,
`public/js/monitoringFeedPopup.js`, que carga solo `instagram.html` después
del feed. El feed le avisa cuando cambia la lista de tarjetas. Detalle en
`design.md`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `public/js/monitoringFeedPopup.js` | New | El pop-up completo (solo Instagram) |
| `public/js/monitoringFeed.js` | Modified | "Ver más" y la foto abren el pop-up; sale la fila desplegada; aviso de cambios en la lista |
| `public/instagram.html` | Modified | Esqueleto del pop-up y carga del script |
| `public/css/styles.css` | Modified | Sección del pop-up (`feed-pop-*`); salen los estilos de la fila desplegada |
| `design/monitoreo-popup.html` | New | Maqueta aprobada |
| `public/js/monitoring.js`, `public/x.html` | Unchanged | |
| `src/`, `server.js`, `data/`, `test/` | Unchanged | Sin backend; la suite no cubre el frontend |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Texto de Instagram interpretado como HTML | Low | Todo dato del posteo entra por `textContent`, como en el feed |
| El pop-up queda mostrando un posteo que ya no está en la lista | Low | El feed avisa cada cambio de la lista; si el posteo no está, el pop-up se cierra |
| Ignorar desde el pop-up sin tocar `monitoring.js` | Med | Usa `confirmIgnore` tal como está; se prueba el caso de éxito y el de fallo |
| Estilos globales (`button`) que pisan los del pop-up | Med | Clases propias con la misma especificidad que ya usa el feed |

## Rollback Plan

Revertir los commits de la rama. No hay cambios de datos, de esquema ni de
configuración.

## Success Criteria

- [ ] "Ver más" y la foto abren el pop-up; cierra con ✕, Esc y clic afuera
- [ ] Foco al abrir y al cerrar; sin scroll de fondo; pantalla completa en celular
- [ ] Navegación con flechas y ← →, con contador
- [ ] Sentimiento e ignorar con las funciones de la tabla
- [ ] Sin foto: recuadro con el tipo; un único punto para la imagen
- [ ] La tabla y `x.html` no cambian; `monitoring.js` no se toca
- [ ] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify`
