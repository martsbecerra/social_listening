# Design: geo-pro

Metodología de `martsbecerra/georreferenciacion` (`SPEC.md`, `config.json`,
`app/pipeline/gazetteer.py`, `villas.py`, `texto.py`, `geocoding.py`,
`direcciones.py`), portada a Node. Lo que allá hace el normalizador local
sobre el texto entero (detectar la dirección) acá lo hace el modelo, que
devuelve la ubicación ya separada en campos; el resto (villas, USIG, el
índice de lugares, las exclusiones, comuna y barrio) es el mismo
criterio.

## Los datos de partida (25/10/2026)

- Instagram: 5 reclamos, ninguno ubicado ("cancha de Huracán", "plaza
  constitución", "locales de Once", "cruce peatonal de Ruiz de los Llanos y
  Bacacay", "pasos de Donato Álvarez y boyaca").
- X: 257, 126 ubicados. De los 130 no encontrados, casi todos vienen del
  Excel importado: su `direccion_detectada` es la PISTA del archivo, que el
  modelo ya había rechazado ("hasta las 18h" → "Carreras, Santiago de las
  18"); el reintento del PR #31 se las volvió a mandar a USIG porque tenían
  texto. El reproceso lee `texto_original`, nunca esa columna.

## Fuentes (CDN de datos abiertos del GCBA)

| Fuente | Registros | Coordenadas | Nombre | Dirección |
|---|---|---|---|---|
| Barrios populares | 966 manzanas, 136 nombres | Gauss-Krüger BA, sin CRS declarado | `NOMBRE`, `NOM_MAP` | — |
| Espacios verdes (CSV) | — | WGS84, polígono en WKT | `nombre` (+ `clasificac`) | — |
| Estaciones de subte | 90 | WGS84 | "Estación " + `estacion` | — |
| Estaciones de tren | 230 (29 en la Ciudad, por polígono: `partido` vacío no quiere decir la Ciudad) | WGS84 | "Estación " + `nombre` | — |
| Hospitales | 36 | EPSG:9498 | "Hospital " + `nam` | `dir` |
| Clubes | 310 | WGS84 | `nombre` | `direccion` |
| Espacios culturales | 3.031 | WGS84 | `ESTABLECIM` | `DIRECCION` |
| Escuelas | 2.778 | EPSG:9498 (el archivo se llama "WGS84") | `nam` | `dir` |
| Barrios y comunas | 48 y 15 | WGS84 | `nombre`, `comuna` | — |

Los de barrios y comunas ya están en `data/geo/` (`src/territorios.js`).
El buscador del catálogo rechaza los pedidos; el CDN, no.

## Proyecciones (`src/geo/proyecciones.js`, sin red)

- **Gauss-Krüger Buenos Aires** (villas): Mercator transversa con origen
  -34,6297166 / -58,4627, k = 1, falso este y norte 100.000, elipsoide
  Internacional 1924, datum Campo Inchauspe → WGS84 con el corrimiento
  -148, 136, 90 (el `crs_local` de `villas.py`).
- **EPSG:9498** (POSGAR 2007 / CABA 2019: hospitales y escuelas): el mismo
  origen, k = 0,999998, falso este 20.000 y norte 70.000, GRS80 (WGS84 a
  los fines del mapa, sin corrimiento).
- Inversa de la Mercator transversa (serie de Snyder) más el corrimiento
  geocéntrico de tres parámetros. Un test la compara contra
  `convertir_coordenadas` de USIG en tres puntos (valores tomados una vez
  del servicio y fijados en el test).

## Configuración (`config/geo-config.json`)

Versionada, como `config/categorias-reclamos.json`. Si existe
`data/geo/geo-config.json`, cada clave que traiga reemplaza a la del
versionado (edición sin commit). Las listas de `config.json` del proyecto
original, adaptadas:

- `gazetteer`: fuentes, `refresco_dias` (30), `minimo_tokens_nombre` (2),
  `longitud_minima_nombre` (8), `nombres_excluidos`, `nombres_genericos`.
- `villas`: fuente, `tipos_incluidos`, `dataset_excluidos`, `grupos` (con
  sus variantes: "la 31", "1 11 14", "once catorce", "ciudad oculta"…).
- `indicadores_de_lugar` (los que validan un nombre ambiguo: plaza,
  parque, estación…) e `indicadores_a_quitar` (lo que se le saca al nombre
  antes de buscarlo: "cancha de", "cruce peatonal de", "pasos de",
  "locales de", "esquina de", "plaza", "estación"…).
- `entidades_lineales`, `lugares_fuera_de_caba`,
  `barrios_y_comunas_excluidos`, `patrones_direccion_invalida`,
  `altura_minima_direccion` (10).
- `barrios_informales`: nombre de uso → barrio oficial ("once" →
  Balvanera, "congreso", "tribunales", "primera junta", "barrio chino",
  "villa freud", "barrio norte", "microcentro", "bajo flores", "las
  cañitas"…).
- `lugares_extra`: lugares que ningún dataset trae con ese nombre (los
  estadios por su apodo, "cancha de Huracán"; unos 30 hitos: Obelisco,
  Congreso, Casa Rosada, Luna Park, Abasto, Alto Palermo, Parque de la
  Ciudad, Costanera Sur, Ciudad Universitaria…), cada uno con sus
  variantes, una dirección (o la entrada de un dataset) y el barrio en el
  que tiene que caer: si el punto no cae ahí, la entrada no se usa y se
  avisa por log.

## Villas (`src/geo/villas.js`)

Port de `villas.py`: se filtran los tipos incluidos, se disuelve por
`NOMBRE` (centroide de área de todos sus polígonos, en metros) y se
convierte a WGS84; barrio y comuna por punto en polígono. Los grupos de la
configuración unen varios nombres del dataset bajo uno (promedio de
centroides); lo que no está en ningún grupo entra con su nombre oficial y
su nombre de mapa. La búsqueda es una regex tolerante (mayúsculas,
acentos, separadores "-", ".", "/") por variante, la más larga primero.
Caché crudo `data/geo/villas.json`. Precisión `area`.

## Lugares con nombre (`src/geo/gazetteer.js`)

- Caché CRUDO en `data/geo/gazetteer.json` (`{ version, fetchedAt, filas:
  [{ nombre, tipo, x, y, direccion, barrio? }] }`); se vuelve a bajar si
  tiene más de `refresco_dias`. Los filtros se aplican al cargar, leyendo la
  configuración: cambiar una lista vale sin volver a bajar nada.
- Espacios verdes: centroide del polígono WKT; se indexan el nombre y
  "<clasificación> <nombre>" ("Plaza Constitución", no solo "Constitución",
  que con una palabra quedaría afuera). Subte y tren con el prefijo
  "Estación"; hospitales con "Hospital". Trenes: solo los de la Ciudad.
  Escuelas: solo matchean precedidas por un indicador ("escuela",
  "colegio", "jardín", "instituto"): sus nombres son siglas ("JIN C DE
  01").
- Filtros (al cargar): menos de 2 palabras, nombre genérico, excluido,
  entidad lineal, fuera de la Ciudad, menos de 8 letras. Una frase común
  ("La Ventana") queda marcada: solo vale con un indicador delante.
- Búsqueda del `nombre_lugar` del modelo: normalizado (`normalizarLugar`:
  minúsculas, sin acentos, abreviaturas expandidas) y comparado por nombre
  exacto o por conjunto de palabras (tolera "9 DE JULIO AV."), nunca por un
  pedazo del texto. Se prueba con y sin los `indicadores_a_quitar`; gana el
  nombre más largo. Un barrio o comuna suelto no es un lugar.
- La dirección para mostrar: la del dataset si la trae; si no, la
  geocodificación inversa de USIG (`ws…/geocoder/2.2/reversegeocoding`, la
  puerta o la esquina), cacheada para siempre en `lugar_cache`; con USIG
  caído, el nombre del lugar (sin caché). Precisión `lugar`.
- Las variantes de los `lugares_extra` se buscan también sin el artículo
  de adelante ("la estación Villa Pueyrredón").

## USIG (`src/geo/usig.js`, sale de `src/geocode.js`)

Lo que se vio el 25/10/2026: `servicios.usig…/normalizar` con
`geocodificar=true` (y la geocodificación inversa por lat/lng) se colgaba
sin responder en 30 s; sin `geocodificar` respondía (de 0,1 a 30 s) con los
candidatos y sus códigos de calle, y un cruce traía su punto.
`ws.usig.buenosaires.gob.ar` respondía en menos de medio segundo. El
reintento del PR #31 corrió esa mañana con el `geocode.js` de antes: los
"0 de 135 ubicados" y las 54 "no encontrada" que quedaron en la caché
fueron por la falla, no por las direcciones ("Estados Unidos 75", "Portela
200" o "Copahue 2019" sí existen). Entonces:

- Calle y altura: `ws…/rest/normalizar_y_geocodificar_direcciones`
  (`calle`, `altura`, `desambiguar=0`): un resultado con su punto, o la
  ambigüedad con las opciones; la elegida se ubica con
  `ws…/geocoder/2.2/geocoding` (código de calle y altura).
- Cruce y texto libre: el normalizador SIN `geocodificar` para los
  candidatos (", CABA" una sola vez, abreviaturas expandidas como en
  `texto.py`); el punto, el de la respuesta o el de `geocoder/2.2` con los
  dos códigos.
- Inversa: `ws…/geocoder/2.2/reversegeocoding` (la puerta o la esquina).
- Las coordenadas de ws son Gauss-Krüger: `proyecciones.js`.
- Más de 2 candidatos distintos (dos con los mismos códigos son uno): 
  `ambigua`, sin elegir; con 2, el del nombre buscado ("SAN MARTIN" antes
  que "ESCALADA DE SAN MARTIN, R."). Un candidato sin punto o en el (0,0)
  no es un punto.
- Reintentos con backoff, tope de tiempo y limitador propio (`geoLimiter`;
  nunca el de Apify). Una respuesta que no es 200, un corte o un tiempo
  agotado es pasajero: no se cachea; el reclamo queda `pendiente`.
- `geocode_cache` sigue siendo la caché por consulta, con claves `usig2:`
  (las `usig:` de antes no se reusan). `geocode.js` queda como envoltorio
  de `textoLibre` para el importador.

## El resolver (`src/geo/resolver.js`)

Entrada: la `ubicacion` del modelo (o, para X y el importador, el texto
libre de siempre con su tipo) y el texto del reclamo. En orden:

1. `villa` (o el texto nombra una villa): `villas.js`.
2. `calle_altura` / `cruce`: USIG. Antes, los `patrones_direccion_invalida`
   sobre el texto entero y la altura mínima (una altura menor a 10 vale
   solo si en el texto aparece pegada a su calle). Una calle sola o una
   entidad lineal sin cruce ni altura → `lineal`.
3. `lugar`: `gazetteer.js` (más `lugares_extra`).
4. `barrio`: sin punto; `comuna` y `barrio` oficiales (con los
   `barrios_informales`); es una mención territorial.
5. `lineal` / `ninguna` / lo que no se resolvió: sin ubicar, con
   `motivo_sin_ubicar` (`lineal`, `fuera_de_caba`, `ambigua`,
   `no_encontrada`, `sin_direccion`).

Todo punto lleva comuna y barrio por punto en polígono (`territorios.js`,
que ya usa `@turf`, dependencia existente). Un punto fuera de la Ciudad es
`fuera_de_caba`. Salida: `ubicacionTipo`, `precision` (`puntual` | `cruce`
| `lugar` | `area` | `ninguna`), `x`, `y`, `direccionNormalizada` (lo que
se muestra: la calle, el cruce, la dirección del lugar o el nombre de la
villa), `calle`, `altura`, `cruce`, `nombreLugar`, `comuna`, `barrio`,
`motivoSinUbicar` y el `geoStatus` de siempre (`ok`, `pendiente`,
`no_encontrada`, `sin_direccion`, `fuera_caba`, `invalida`: el CHECK no
cambia; el motivo fino va en `motivo_sin_ubicar`).

## Base (`src/db.js`)

- `reclamos` suma `ubicacion_tipo`, `nombre_lugar`, `motivo_sin_ubicar`,
  `ubicacion_json` (lo que devolvió el modelo), `corregida_por` (correo de
  quien corrigió; no sale a la API) y `descarte_motivo`. Migración por
  `ALTER TABLE`, sin tocar lo existente.
- `precision`: `exacta` → `cruce` si hay cruce, si no `puntual`;
  `aproximada` → `lugar`; sin punto → `ninguna`. Una sola vez, al migrar.
- `lugar_cache` (nombre normalizado del lugar → dirección y punto, fuente,
  fecha).
- `conservarGestion` al re-analizar sigue igual (con la misma ubicación
  detectada, no se pierde lo resuelto ni lo corregido).

## El modelo (Instagram; `src/analysisSchema.js`, `src/prompt.js`)

- Un reclamo es un problema con algún lugar nombrado (calle, cruce, plaza,
  estación, villa, barrio, avenida, un lugar fuera de la Ciudad). Sin
  ningún lugar no hay entrada: el comentario sigue contando como pedido.
- `ubicacion`: `tipo`, `calle`, `altura` (0 sin altura), `calle2`,
  `nombre_lugar` (tal como lo escribió la persona), `barrio_o_comuna`,
  `texto_original` (el tramo exacto), `confianza` (alta | media | baja) y
  `fuera_de_caba`. Sin `null` (el proveedor va en modo estricto): un campo
  vacío es `""`.
- Reglas del prompt (las de `SPEC.md`): no inventar altura ni cruce; una
  avenida o autopista sola es `lineal`; un barrio o comuna solos es
  `barrio`; fuera de la Ciudad es `ninguna` con `fuera_de_caba`; un número
  que es fecha, ley, horario o cantidad no es altura (los
  `patrones_direccion_invalida` como ejemplos); una altura menor a 10 solo
  con la calle explícita al lado.
- El contexto: el caption (ya va) y, si Instagram lo trae, el lugar de la
  publicación (`locationName`), para "acá en la plaza".
- `validateAnalysis`: tipo válido, altura entera positiva, nada de texto en
  campos que el tipo no usa; lo que no valida queda `ninguna`.
- X no cambia su prompt: su `direccionDetectada` y su `tipoUbicacion` pasan
  por el resolver como texto libre.

## API

- `GET /api/reclamos`: el filtro `precision` y los campos nuevos
  (`ubicacionTipo`, `precision`, `nombreLugar`, `motivoSinUbicar`,
  `corregida`, `descarteMotivo`). Los `fuera_caba` vuelven a venir, para el
  panel "Sin ubicar"; nunca tienen pin ni cuentan en las comunas.
- `POST /api/reclamos/:id/corregir` `{ texto }`: lo resuelve el mismo
  resolver (dirección, cruce, lugar o villa) y lo marca `corregida_por`.
- `POST /api/reclamos/:id/descartar` `{ motivo }`: `motivo_sin_ubicar =
  'descartado'` y `descarte_motivo`.
- `GET /api/geo/comunas`: los polígonos de las comunas (del caché).

## Mapa (`public/js/claimsMap.js`, `instagram.html`, `x.html`)

- El pin según la precisión: `puntual` / `cruce` sólido; `lugar` con halo;
  `area` con halo grande. Tooltip y pop-up dicen la precisión en una línea
  ("Lugar con nombre · ubicación aproximada").
- "Puntos / Por comunas": las 15 comunas como polígonos, coloreadas por
  cantidad (los ubicados más las menciones territoriales); un clic lista los
  reclamos de esa comuna.
- "Sin ubicar (N)": texto, motivo y fecha, agrupados por motivo (las
  menciones de solo un barrio, en su grupo). "Corregir dirección" y
  "Descartar" con motivo.
- El filtro "Precisión". Sigue sin estado.

## Mapita del análisis (`public/js/analysisBlocks.js`)

Sólido o con halo según la precisión, y la lista de "sin ubicar" con su
motivo; "Corregir" lleva al Mapa.

## Reproceso (`scripts/geo-reprocesar.js`)

Sobre una COPIA de la base: los reclamos sin punto (Instagram y X), por
tandas, con un prompt propio que solo extrae la `ubicacion` (no vuelve a
clasificar tono ni temas), con el texto del reclamo y el caption de su
publicación si se conoce. `--costo` cuenta los tokens de los prompts y no
llama a nada; `--simulado` prueba el script; `--si` corre (una sola vez:
se niega si ya hay una hecha). Lo extraído queda en
`data/geo/reproceso-ubicaciones.json` (id → `ubicacion`). Al arrancar, el
piloto lo aplica una sola vez (marca en `refresh_state`): guarda la
`ubicacion` de cada reclamo y los pasa por el resolver; los que ya tienen
punto lo conservan.

## Lo que salió de la corrida y las capturas (25/10/2026)

La corrida autorizada (136 reclamos, 10 llamadas, US$ 0,262) y su
aplicación sobre la copia mostraron siete cosas, cada una con su commit y
su test:

- La migración de la precisión le ponía "sin dirección" a una mención de
  solo el barrio ya resuelta en el arranque siguiente: ahora la salta.
- "Barrio Norte" se buscaba como "Norte" (se sacaba "barrio" antes de mirar
  los nombres de uso); "la Ciudad" o "CABA" quedaban como "no encontrada":
  ahora sin dirección (`nombres_de_la_ciudad`).
- "la estación Villa Pueyrredón" no llegaba a la variante "estacion villa
  pueyrredon" de su lugar extra: se busca también sin el artículo.
- Corregir con "Plaza Irlanda" tardaba 37 s: un texto sin altura ni dos
  calles va primero al índice de lugares.
- Un 502 de USIG al armar los lugares extra tiraba el índice entero (5
  quedaron pendientes): esos extras se saltean y el índice se rearma a los
  10 min; un lugar sin su puerta queda ubicado con su nombre.
- El filtro de precisión mostraba todo si la primera respuesta volvía
  última: vale solo la del último pedido; "Ninguna" no muestra nada.
- "Se leyó" mostraba la dirección del Excel de X: `GET /api/reclamos` suma
  `leido`, lo que extrajo el modelo.
