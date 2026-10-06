# Proposal: monitoreo-feed

## Intent

Sumar a la solapa "Monitoreo en vivo" de Instagram una segunda forma de ver
las publicaciones detectadas: un **Feed** de tarjetas, además de la tabla
que ya existe. La tabla sirve para ordenar y comparar números; el feed,
para leer de un vistazo qué se publicó, quién, con qué tono y si se despegó
de lo habitual de esa cuenta.

La maqueta aprobada por el dueño es `design/monitoreo-feed.html`: es la
base de estructura, estilos, textos y comportamiento. Lo que la maqueta no
resuelve (porque usa datos de ejemplo) se decidió con el dueño y quedó
anotado en `design.md`.

## Scope

### In Scope

- Interruptor "Tabla / Feed" arriba de los resultados, que recuerda la
  última vista en `localStorage`
- Feed de tarjetas con los posteos reales que ya trae la solapa, sin
  paginar, con la foto chica fija (variante compacta de la maqueta)
- Los mismos filtros para las dos vistas: los que ya había (sentimiento,
  cuenta, fechas, buscador) más "Alcance"; "Desde" / "Hasta" con su texto a
  la vista
- Etiqueta de alcance (alto / medio / bajo) por posteo, a partir del
  benchmark que ya calcula el backend
- Selector de orden del feed: más recientes, mayor alcance, más likes
- Las mismas acciones de la fila de la tabla (corregir sentimiento,
  ignorar), con los mismos endpoints
- "Ver más" / "Ver menos" por fila visual, con el texto completo y los
  datos de la tabla desplegada
- "Se despegaron" lleva a la tarjeta cuando el feed es la vista activa
- Documentación (README, CLAUDE.md, este SDD)

### Out of Scope

- Backend, base de datos y Apify: no se toca nada; el feed no pide nada
  nuevo al servidor
- La imagen del posteo: la base no guarda fotos. La tarjeta muestra siempre
  el recuadro de reemplazo y queda lista para mostrar la imagen cuando el
  posteo traiga el dato (segunda etapa)
- X: `x.html` no cambia y no carga el feed
- Cambiar el cálculo del benchmark (cortes 1,5× y 0,5×, medianas)
- Paginación o carga progresiva del feed
- Selector de tamaño de foto (la maqueta tiene dos tamaños; se usa el chico)
- Rediseñar la tabla (no suma columna de alcance)

## Capabilities

### New Capabilities

- `monitoreo-feed`: vista de tarjetas del Monitoreo de Instagram

### Modified Capabilities

- Filtros del Monitoreo de Instagram: suman "Alcance" y las etiquetas
  "Desde" / "Hasta"; la condición pasa a una función compartida por la
  tabla y el feed
- "Se despegaron": con el feed activo, el destacado lleva a la tarjeta

## Approach

1. Separar de Tabulator la condición de la barra de filtros
   (`readFilterValues` + `postMatchesFilters` en `public/js/monitoring.js`)
   y sumar `postReach`, sin cambio visible.
2. Estilos del feed calcados de la maqueta, con los tokens que ya tiene
   `public/css/styles.css` y el prefijo `feed-` (los nombres de la maqueta
   ya existen ahí con otro uso).
3. `public/js/monitoringFeed.js`, cargado solo por `instagram.html`: dibuja
   `monitoringTable.getData()` filtrado con la función compartida.
   `monitoring.js` le avisa los cambios por una lista de vistas anotadas.
4. Acciones de la tarjeta delegadas en el contenedor, reusando
   `updateSentiment`, `openIgnoreModal` y `confirmIgnore`.
5. "Ver más" por fila visual; el detalle se arma recién al abrir.
6. Filtro "Alcance" dentro del predicado compartido.

Un commit por paso, cada uno probado en el navegador contra un servidor de
prueba fuera del repo.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `public/js/monitoringFeed.js` | New | La vista Feed completa (solo Instagram) |
| `public/js/monitoring.js` | Modified | Filtro compartido, `postReach`, filtro "Alcance", aviso a las vistas, selector de sentimiento reusable, formateadores armados una vez |
| `public/instagram.html` | Modified | Interruptor, selector de alcance, selector de orden, etiquetas de fecha, contenedor del feed |
| `public/css/styles.css` | Modified | Sección "vista Feed" (`feed-*`, `.view-seg`, `.f-date`, `.frow-end`) |
| `design/monitoreo-feed.html` | New | Maqueta aprobada |
| `public/x.html` | Unchanged | Comparte `monitoring.js`; se verifica en cada paso que no cambie |
| `src/`, `server.js`, `data/`, `config/` | Unchanged | Sin cambios de backend |
| `test/` | Unchanged | La suite no cubre el frontend |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Romper la solapa de X al tocar `monitoring.js`, que comparte | Med | El predicado se comparó contra el anterior con los posteos reales y cientos de combinaciones de filtros; los controles que solo existen en Instagram se tratan como null en X; `x.html` se abre en cada paso |
| Que la tabla y el feed muestren conjuntos distintos | Med | Una sola función de filtro para las dos vistas |
| Texto de Instagram interpretado como HTML | Low | Todo dato del posteo entra por `textContent`; como HTML solo van constantes propias (íconos) |
| Cientos de tarjetas sin paginar traban el buscador | High | `content-visibility: auto`, redibujo con espera de 150 ms, formateadores `Intl` armados una vez, detalle de "Ver más" armado al abrir |
| Etiqueta de alcance que no coincide con el backend | Med | `postReach` no recalcula: combina los niveles que manda el backend; verificado contra `benchmark.top` en los posteos reales |
| `localStorage` bloqueado | Low | try/catch: la vista cambia igual, solo no se recuerda |
| Cambio en formateadores usados por las dos redes | Med | Comparación antes / después con miles de valores; se encontró y corrigió una diferencia con valores que no son números |

## Rollback Plan

Revertir los commits de la rama. No hay cambios de datos, de esquema ni de
configuración. La clave `sl.monitoreo.vista` que quede en el navegador no
molesta a la versión anterior.

## Dependencies

- Tabulator 6.3.0 (ya cargado): el feed lee los posteos de la tabla
- El campo `benchmark` de `GET /api/monitoring/posts` (ya existía)
- Ninguna dependencia nueva

## Success Criteria

- [x] El interruptor cambia entre Tabla y Feed y recuerda la última vista
- [x] La vista Tabla queda igual que antes, salvo el filtro "Alcance" y el
  texto "Desde" / "Hasta"
- [x] Las dos vistas muestran el mismo conjunto con cualquier combinación
  de filtros, y "Mostrando N de M" coincide
- [x] La etiqueta de alcance sigue la regla del dueño y coincide con el
  benchmark del backend
- [x] Corregir sentimiento e ignorar desde la tarjeta usan los mismos
  endpoints, con `?plataforma=instagram`
- [x] "Ver más" abre y cierra juntas las tarjetas de la fila visual
- [x] `x.html` no cambia de comportamiento
- [x] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify`
- [ ] Imagen del posteo (segunda etapa, fuera de este cambio)
