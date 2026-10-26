# Proposal: geo-pro

## Intent

Fase H. Hoy el análisis saca la dirección de un reclamo como texto libre y
se la manda al normalizador de USIG, que solo entiende "calle altura" o
"calle y calle": Instagram tiene 0 de 5 reclamos ubicados y X 126 de 257.
Esta fase trae la metodología del proyecto
`martsbecerra/georreferenciacion` (Python, `SPEC.md`), portada a Node sin
librerías nuevas: el modelo extrae la ubicación ESTRUCTURADA (tipo, calle,
altura, cruce, nombre del lugar, barrio) y el servidor la resuelve con
villas, USIG, un índice de lugares con nombre armado con los datos
abiertos del GCBA y los barrios, con una precisión y, si no la ubica, un
motivo. El Mapa muestra la precisión, la vista por comunas y los reclamos
sin ubicar, que el equipo puede corregir a mano.

## Scope

### In Scope

- El modelo (la tanda de Instagram) devuelve por reclamo una `ubicacion`
  con `tipo` (`calle_altura`, `cruce`, `lugar`, `villa`, `barrio`,
  `lineal`, `ninguna`), los campos de cada tipo, el tramo exacto del texto
  y la confianza. Un reclamo es un problema con algún lugar nombrado; sin
  lugar no hay reclamo (sigue contando como pedido). Recibe el caption y,
  si lo hay, el lugar de la publicación. No da coordenadas.
- El resolver (`src/geo/`): villa, calle y altura o cruce (USIG), lugar
  (índice local), barrio (mención territorial, sin punto), sin ubicar con
  motivo (`lineal`, `fuera_de_caba`, `ambigua`, `no_encontrada`,
  `sin_direccion`, `descartado`). Comuna y barrio de todo punto.
- Las listas en `config/geo-config.json` (versionado), pisadas por
  `data/geo/geo-config.json` si existe; los datasets cacheados en
  `data/geo/` y refrescados cada 30 días.
- Columnas nuevas en `reclamos` y la tabla `lugar_cache`; `precision` pasa
  a `puntual` | `cruce` | `lugar` | `area` | `ninguna`.
- Mapa (Instagram y X, el mismo componente): el pin según la precisión, la
  vista "Por comunas", el panel "Sin ubicar (N)" con "Corregir dirección" y
  "Descartar", y el filtro "Precisión". El mapita del análisis, con la
  misma precisión y la misma lista.
- UNA pasada autorizada del modelo sobre los reclamos sin punto (Instagram
  y X) para extraer la ubicación estructurada, sobre una copia de la base;
  el piloto la aplica una sola vez al arrancar.

### Out of Scope

- El prompt, el análisis y la pantalla de X (salvo el mapa compartido); su
  extracción sigue en texto y pasa por el mismo resolver.
- Librerías nuevas o Python. Coordenadas pedidas al modelo.
- Volver a clasificar tono o temas de lo ya analizado.

## Approach

Ver `design.md`.

## Affected Areas

| Archivo | Impacto | Descripción |
|---------|---------|-------------|
| `src/geo/*.js` | New | Texto, proyecciones, configuración, datasets, villas, lugares, USIG y el resolver |
| `config/geo-config.json` | New | Las listas (villas, lugares extra, barrios informales, exclusiones, patrones) |
| `src/geocode.js`, `src/geoWorker.js`, `src/territorios.js` | Modified | El worker resuelve con `src/geo/resolver.js` |
| `src/db.js` | Modified | Columnas nuevas, `lugar_cache`, la precisión nueva, corregir y descartar |
| `src/analysisSchema.js`, `src/prompt.js`, `src/userPrompt.js`, `src/validateAnalysis.js`, `src/apify.js` | Modified | La ubicación estructurada y el lugar de la publicación |
| `src/reclamosFromAnalysis.js`, `src/x/reclamosFromAnalysis.js`, `src/reportBuilder.js` | Modified | Las filas y el CSV de reclamos |
| `server.js`, `src/reclamosQuery.js`, `src/analysisRoutes.js`, `src/analysisMetrics.js` | Modified | Filtro de precisión, corregir, descartar, comunas, la aplicación del reproceso |
| `public/js/claimsMap.js`, `public/instagram.html`, `public/x.html`, `public/js/analysisBlocks.js`, `public/css/styles.css` | Modified | Precisión, comunas, sin ubicar, el mapita |
| `scripts/geo-reprocesar.js` | New | La pasada del modelo sobre los reclamos sin punto |
| `test/` | Modified/New | Cada pieza, con recortes de los datasets reales |

## Risks

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| Un dataset cambia de forma o de sistema de coordenadas | Media | El caché crudo guarda lo que bajó; un archivo que no se entiende no pisa el caché bueno; la conversión se verifica contra USIG en los tests |
| El índice de lugares da falsos positivos | Media | Las reglas de `SPEC.md`: dos palabras y 8 letras mínimas, exclusiones, frases comunes solo con indicador, conjunto de palabras y nunca un pedazo |
| USIG devuelve varias opciones | Alta en calles repetidas | Más de 2: "ambigua", sin elegir |
| El modelo inventa una altura | Media | Reglas del prompt y del servidor (patrones inválidos, altura menor a 10 solo pegada a la calle) |
| Un reclamo se ubica mal y queda para siempre | Baja | "Corregir dirección" y "Descartar" en el Mapa |

## Rollback Plan

Revertir el merge. Las columnas nuevas quedan sin uso y la migración no
borra nada; con la versión anterior, los pines de un lugar o una villa se
ven sólidos (solo conocía `aproximada` para el punteado).
