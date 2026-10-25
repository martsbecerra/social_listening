# Design: analisis-pro (F1)

## Technical Approach

El trabajo de la fase E (`src/analysisJob.js`) no cambia de forma: trae la
publicación y los comentarios, llama a `analyzeComments` y deja la fila.
Lo que cambia es qué pide al modelo y qué se guarda.

1. **Clasificar** (`analyzeComments`): la muestra en tandas de 50 (eran
   100 hasta la corrida real: ver "Lo que mostró la corrida real"). La
   tanda 1 va sola: clasifica y define la lista de temas de la
   publicación. Las tandas 2..n van de a 5 en paralelo con esa lista;
   cada una puede devolver temas nuevos, que se unen a la lista global por
   nombre normalizado (sin acentos ni mayúsculas). Por comentario: tono
   (positivo / neutral / negativo / ruido), postura (favor / neutra /
   critica), tema (el número de la lista; 0 = ninguno), sobre_posteo,
   pedido y reclamosGeo (como hoy). Lo que el modelo no devuelve queda sin
   clasificar.
2. **Verificados**: los que comentaron con `owner.is_verified`, más todo
   el que comentó y está en `figuras_publicas` (se cruzan todos los
   usuarios).
3. **Reclamos**: como hoy (subcategoría y `upsertReclamo` con
   `conservarGestion`).
4. **Informe** (síntesis): recibe los números ya contados (tono, postura,
   temas con cantidades y tonos, el tema principal de los que no hablan
   del posteo), los verificados y una muestra; devuelve la lectura, el
   hecho dominante (o ninguno), los pedidos agrupados con los números de
   sus comentarios, qué mirar y sugerencias de rol y alineación para
   verificados que no están en la tabla. Las sugerencias se guardan como
   `origen = sugerida`.

Al leer (`GET /api/analisis/:id`), `src/analysisMetrics.js` arma la forma
completa desde la fila: los comentarios guardados (con sus campos v2), el
`resultado` (lo que dijo el modelo), los temas (con renombres), las
figuras al día, los reclamos del posteo al día y los análisis anteriores
de la cuenta. Así un análisis v1 muestra todo lo que se puede contar con
sus comentarios (tono, temas con su conteo, verificados, etiquetas,
emojis, los que más pegaron, el tiempo, la comparación) y los bloques que
necesitan campos v2 dicen que no están disponibles.

## Architecture Decisions

- **Métricas al leer, no guardadas** (decisión del dueño, 24/10/2026). El
  `resultado` v2 guarda solo lo que dijo el modelo; las cuatro columnas
  nuevas (`pct_neg`, `tiene_hecho`, `n_verificados`, `tema_estrella`) se
  escriben al terminar (y `tema_estrella` al renombrar) para listar y
  ordenar sin abrir el JSON. La migración las completa en los v1.
- **El modelo no cuenta.** Ningún número de la pantalla sale del modelo.
  La síntesis recibe los números del servidor y solo puede citar esos.
- **Sin tipo de cuenta en Instagram** (decisión del dueño). Etiquetaba de
  "opositor" a cualquier comentarista y alimentaba el porcentaje
  ponderado del informe institucional; la postura del comentario lo
  reemplaza y el informe de 8 puntos usa cantidades simples. Instagram
  deja de leer y escribir `data/account-types.json` (X no lo usa).
- **Ponderado por likes**: peso = likes + 1, así un comentario sin likes
  cuenta.
- **Base de las proporciones**: los clasificados sin el ruido (bots, spam,
  repetidos), que va aparte, como en la fase E. Lo sin clasificar (una
  tanda caída) tampoco entra.
- **Hecho dominante**: solo si la síntesis lo marca sobre el tema principal
  de los comentarios que no hablan del posteo Y ese tema junta al menos el
  20 % de los analizados (decisión del dueño). Si no, la tarjeta calma.
- **Temas**: `temas` v2 = `{ version: 2, lista: [{ id, nombre, manual?,
  texto?, unidoA? }] }`. Renombrar cambia el nombre; si coincide con otro,
  se unen (`unidoA`, sin reescribir los comentarios). "+ tema" agrega uno a
  mano, sin conteo, que entra en el informe.
- **Figuras públicas**: se cruzan todos los que comentaron; el modelo
  sugiere solo para verificados; la alineación (oficialismo / oposición)
  solo vale para legislador/a, funcionario/a, partido, junta comunal,
  periodista y medio (lo valida el servidor). Una sugerencia nunca pisa
  una fila `origen = equipo`.
- **Reclamos del análisis**: los de `reclamos` con el `post_url` del
  análisis (no hace falta columna nueva), con la regla del mapa para el
  pin.
- **Compatibilidad hasta la F2**: `GET /api/analisis/:id` sigue mandando
  los campos que usa la solapa de la fase E (`temas` con títulos y números
  de comentarios, `reporteAntes` = el informe nuevo, `csv`,
  `comentarios`); el PATCH viejo de temas se traduce a renombres y temas a
  mano.

## Data Flow

    POST /api/analyze ─→ analysisJob.run
       ├─ Apify: publicación + comentarios (como en E)
       └─ analyzeComments
            ├─ tanda 1 (define temas) ─→ tandas 2..n (de a 5, reusan y suman)
            ├─ verificados (figuras_publicas)
            ├─ reclamos (subcategoría, upsert)
            └─ síntesis (números del servidor) ─→ sugerencias → figuras
       ─→ db.finishAnalisis (resultado v2, temas v2, comentarios v2, columnas)

    GET /api/analisis/:id ─→ analysisMetrics.buildAnalysisView(fila,
       figuras, reclamos del posteo, anteriores de la cuenta) ─→ forma completa

## Lo que mostró la corrida real (24/10/2026)

Una publicación de @jorgemacri con 385 comentarios según Instagram: Apify
devolvió 155 ítems (150 comentarios con texto: solo los de primer nivel,
como en la E). La tanda 1 (100 comentarios) se cortó en el tope de salida
de 12.000 tokens, dos veces: el modelo razona antes de contestar y ese
razonamiento cuenta para el tope (la tanda de 50 que anduvo gastó 10.653
tokens de salida para un JSON de unos 2.000). El proveedor la reintentaba
igual, y lo gastado en los dos intentos no quedaba en el costo del
análisis. Quedaron 50 de 150 analizados. Cambios:

- Tandas de 50 con 16.000 de tope, hasta 5 a la vez (los mismos ~250
  comentarios en vuelo que antes con 3 × 100).
- `SALIDA_CORTADA` (`src/llm/errors.js`): una respuesta cortada no se
  reintenta igual; la tanda se parte en dos mitades, una después de la
  otra, una sola vez.
- Todo error de `requestStructuredAnalysis` lleva lo ya gastado y el
  análisis lo suma, también en la síntesis.
- El punto 1 del informe decía "la conversación responde al posteo" con
  el 57 % desviado: ahora lo dice solo si la mayoría habla del posteo.
- El modelo armó un tema "Comentarios de spam o ruido" que quedó con 0: un
  tema del modelo sin comentarios no se muestra, y el prompt pide no
  armarlo. Agrupó 8 pedidos, 6 de un solo comentario y varios irónicos: el
  prompt pide dejar afuera las preguntas retóricas o en chiste.
- El modelo no marcó hecho dominante sobre el tema principal fuera del
  posteo (ataques personales, 30 % de los analizados): bien, no es un
  hecho. No sugirió a los dos verificados sin ficha. La postura salió casi
  igual que el tono (2 de 46 distintos).

**La repetición solo del modelo** (autorizada, 24/10/2026): los mismos 150
comentarios (las respuestas de Apify guardadas, sin llamar a Apify) con
las tandas de 50. Clasificó los 150 en 3 tandas, ninguna cortada: 8.978,
7.027 y 9.186 tokens de salida contra el tope de 16.000, con unos 8.800 de
entrada cada una. La partición no hizo falta: la cubren los tests. Costo
registrado US$ 0,357 (3 tandas US$ 0,305, la síntesis US$ 0,048, la
subcategoría de 5 reclamos US$ 0,004), igual a la suma de lo que informó
OpenRouter por llamada. Sin hecho dominante (el 63 % se desvía, repartido
en varios temas), 8 pedidos (5 de un comentario, ya sin los irónicos),
ninguna figura sugerida para los 2 verificados sin ficha, la postura
distinta del tono en 5 de 145.

## F2: la pantalla

La solapa 3 de la maqueta en `instagram.html`, todo bajo `.ana4` (X no
cambia). Dos vistas con el selector de la maqueta: **Analizar** (el link,
los pasos con su porcentaje, la tira de recientes y el resultado) y
**Publicaciones analizadas** (la galería). El navegador no cuenta nada:
cada bloque lee `vista` de `GET /api/analisis/:id` y, si no tiene el dato
(un v1), lo dice ("No disponible en análisis anteriores") en vez de
ocultarse. Scripts clásicos con prefijo `ana`, en tres archivos: el flujo
(`analysis.js`: analizar, pasos, recientes, galería, hash), los bloques del
resultado (`analysisBlocks.js`) y las figuras (`analysisFiguras.js`: la
tarjeta y el diálogo "Lista de figuras").

- **Figuras descartadas**: la misma tabla, `origen = descartada`
  (`POST /api/figuras/:username/descartar`, solo para una sugerida). La
  vista la trata como sin ficha (sin rol), la síntesis no la recibe como
  verificado sin ficha y `upsertFiguraSugerida` no la toca. Agregarla o
  editarla la pasa al equipo; quitarla la borra.
- **Mapita**: el contorno de la Ciudad y los centros de las comunas de la
  maqueta, en SVG; un punto por reclamo con `enMapa` (la regla del Mapa),
  agrupados si quedan cerca, con el color de su categoría (`temaColor`).
  Los que no están ubicados van en la lista, sin punto.
- **Temas**: en un v2, ✎ manda `renombrar` (une si el nombre coincide),
  "+ tema" `agregar` y "Quitar" (solo a mano) `quitar`; la respuesta es el
  análisis entero. En un v1, la lista vieja, como en la fase E, y después
  se vuelve a leer el análisis.
- **Hash**: `#analisis-<id>` abre ese análisis; `#analisis-galeria`, la
  galería.

## Testing Strategy

| Capa | Qué | Cómo |
|------|-----|------|
| Métricas | Cada bloque, v1 y v2, bordes | `test/analisisMetricas.test.js`, puro |
| Modelo | Tanda 1 sola, temas reusados y unidos, validación, síntesis, umbral | `test/analisisModelo.test.js`, LLM stubeado |
| Trabajo y rutas | v2 de punta a punta, galería, `:id`, compatibilidad, PATCH | `test/analisisTrabajo.test.js` |
| Figuras | Tabla, rutas, validación, sugerencias | `test/figuras.test.js` |
| Base | Migración y relleno de los v1 | `test/analisisBase.test.js` |
| Real | La forma del actor y la respuesta del modelo | `test/analisisFixtureReal.test.js` con los fixtures anonimizados |
