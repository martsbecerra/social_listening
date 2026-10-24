# Proposal: analisis-pro

## Intent

Fase F del rediseño v4: la solapa "Análisis de publicación" de Instagram
pasa a la maqueta nueva (`design/social-listening-v4.html`, solapa 3 v5).
La fase E dejó el análisis corriendo en el servidor, guardado en la tabla
`analisis`, en tandas de 100 con progreso real. Esta fase lo amplía: cada
comentario trae además su postura hacia la gestión, su tema, si habla del
posteo y si pide algo; la síntesis marca el hecho dominante (si lo hay),
agrupa los pedidos y sugiere qué mirar; el servidor cuenta todo (tono,
postura, desvío, temas con tono, verificados, etiquetas, emojis, los que
más pegaron, la comparación con la cuenta) y la pantalla lo dibuja bloque
por bloque, con una galería de los análisis hechos. Una tabla nueva,
`figuras_publicas`, le pone rol y alineación a quien comentó, sin que el
modelo etiquete a vecinos comunes.

Va en dos PR (decisión del dueño, 24/10/2026): **F1** modelo + servidor +
figuras públicas (este registro, con la corrida real autorizada al final)
y **F2** pantalla + inicio + edición de figuras. Tags `v4-fase-f1` y
`v4-fase-f` al mergear cada uno.

## Scope

### In Scope (F1)

- Tanda (`src/prompt.js`, `src/analysisSchema.js`, `src/userPrompt.js`,
  `src/validateAnalysis.js`): por comentario tono, `postura` (favor /
  neutra / crítica: qué dice de la gestión), `tema` (de la lista que define
  la primera tanda), `sobre_posteo` y `pedido`, además de los reclamos con
  ubicación. Sin tipo de cuenta: Instagram deja de escribir
  `data/account-types.json`.
- La primera tanda va sola y define los temas; las demás (hasta 3 a la
  vez) los reutilizan y pueden sumar nuevos, que se unen por nombre.
- Síntesis: lectura estratégica, hecho dominante (o ninguno), pedidos
  agrupados con los ids de sus comentarios, "qué conviene mirar" y
  sugerencias de rol para verificados que no están en la tabla de figuras.
- `src/analysisMetrics.js`: todo lo numérico, al leer, desde los
  comentarios guardados (los análisis anteriores muestran lo que se pueda).
- `src/reportBuilder.js`: el informe de 8 puntos (reemplaza al
  institucional, solo en Instagram) y el CSV de comentarios; el de reclamos
  sigue.
- Tabla `figuras_publicas` y `/api/figuras` (GET/POST/PATCH/DELETE); las
  sugerencias del modelo quedan como `origen = sugerida` y nunca pisan una
  fila del equipo.
- Columnas nuevas de `analisis`: `pct_neg`, `tiene_hecho`,
  `n_verificados`, `tema_estrella` (completadas también en los viejos).
- `GET /api/analisis` con búsqueda, filtros y orden (la galería) y
  `GET /api/analisis/:id` con la forma completa; los pasos renombrados.
- La solapa de la fase E sigue funcionando hasta la F2.
- UNA corrida real autorizada al final, para validar el schema y guardar
  la respuesta del modelo anonimizada como fixture.

### Out of Scope

- La pantalla nueva, el inicio y la edición de figuras (F2).
- X: ni su análisis ni su informe cambian.
- Respuestas a comentarios ("debates", "la cuenta respondió"): el actor no
  las trae.
- Otras tablas además de `figuras_publicas`.

## Approach

Ver `design.md`.

## Affected Areas

| Archivo | Impacto | Descripción |
|---------|---------|-------------|
| `.gitignore` | Modified | `data.rar` y `*.rar` |
| `design/social-listening-v4.html` | Modified | La maqueta nueva |
| `src/db.js` | Modified | Columnas, `figuras_publicas`, galería, anteriores de la cuenta, reclamos de un posteo, temas v2 |
| `src/prompt.js`, `src/analysisSchema.js`, `src/userPrompt.js` | Modified | Tanda y síntesis v2 (lo que usa X no cambia) |
| `src/validateAnalysis.js`, `src/classificationHeuristics.js` | Modified | Validación v2, sin tipo de cuenta |
| `src/analyzeComments.js` | Modified | Primera tanda sola, temas, verificados, síntesis v2 |
| `src/analysisMetrics.js` | New | Las métricas, al leer |
| `src/commentTimeline.js` | Modified | Primer comentario, 50 %, últimas 24 h |
| `src/reportBuilder.js` | Modified | Informe de 8 puntos y CSV de comentarios |
| `src/figuras.js`, `src/figurasRoutes.js` | New | Figuras públicas |
| `src/analysisProgress.js`, `src/analysisJob.js`, `src/analysisRoutes.js`, `server.js` | Modified | Pasos, el trabajo, las rutas |
| `test/` | Modified/New | Métricas, modelo v2, trabajo y rutas, figuras, migración, fixture |

## Risks

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| La salida por tanda crece y choca con el tope | Media | Campos cortos, tope de salida a 12.000; una tanda caída queda sin clasificar |
| Temas duplicados entre tandas en paralelo | Media | Unión por nombre normalizado y tope de temas |
| La lectura cita números inventados | Media | La síntesis recibe los números calculados y la orden de citar solo esos |
| La pantalla de la fase E con datos v2 | Media | `GET /api/analisis/:id` conserva los campos viejos hasta la F2 |
| El modelo etiqueta a vecinos | Baja | Sugerencias solo para verificados; alineación solo para roles públicos (lo valida el servidor) |

## Rollback Plan

Revertir el merge. Las columnas y la tabla nuevas no molestan al código
anterior; los análisis v2 quedan en la tabla con `resultado.version = 2`.

## Success Criteria

- [ ] Suite en verde con `IG_ACTOR=apidojo` y `apify`
- [ ] Un análisis v2 de punta a punta con fetch y modelo simulados
- [ ] Los análisis v1 siguen abriéndose
- [ ] La corrida real valida el schema y deja su fixture anonimizado
- [ ] Revisor independiente: altos y medios corregidos
