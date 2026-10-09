# Proposal: alcance-colchon

## Intent

Que la etiqueta de alcance (alto / medio / bajo) y "Se despegaron" dejen de
premiar a las cuentas chicas. La regla anterior dividía el valor del posteo
por la mediana de su cuenta y cortaba en 1,5 y en 0,5: contra una mediana
de 2 likes, 100 likes eran 50 veces lo habitual. Con los posteos del
9/10/2026, 202 de 473 salían "alto" y "Se despegaron" lo ocupaban posteos
de cuentas con medianas de 0 a 5.

La regla nueva la decidió el dueño sobre los datos reales (análisis hecho
con una copia de la base): likes y comentarios por separado, sin que
ninguno pese más que el otro, con un colchón que se suma arriba y abajo de
la razón y un piso absoluto para llegar a alto.

## Scope

### In Scope

- Razón con colchón por métrica: likes 2000, comentarios 300
- Piso para el alto: 1000 likes, 150 comentarios
- Cortes: alto desde 1,5 y medio desde 1,1; bajo el resto ("no se despega
  de lo normal de su cuenta")
- Los seis números en el `.env`, con esos valores por defecto, validados al
  arrancar y documentados en `.env.example`
- "Se despegaron" con la regla nueva
- En pantalla: la razón nueva con dos decimales junto a la etiqueta, y la
  mediana real y el colchón en el pop-up y en el detalle de la tabla
- Tests de piso, colchón, mediana 0 y bordes (1,09 / 1,10 / 1,50)

### Out of Scope

- Cómo se calculan y cuándo se recalculan las medianas (`account_stats`)
- La combinación de las dos métricas en una etiqueta: sigue igual (alto si
  alguna da alto, bajo solo si las dos dan bajo)
- Los motivos de "sin referencia"
- Base de datos, Apify y X
- Los estilos del alcance y las maquetas de `design/`

## Capabilities

### New Capabilities

- `alcance-colchon`: regla del alcance de una métrica, configurable por
  `.env`

### Modified Capabilities

- `monitoreo-feed`: la etiqueta de alcance y el orden "Mayor alcance" usan
  los niveles nuevos; la razón se muestra con dos decimales
- `monitoreo-popup`: la razón junto a la etiqueta; mediana real y colchón
  en cada métrica

## Approach

Un módulo puro, `src/reachRule.js`, lee los seis números del entorno y da
la razón y el nivel de una métrica. `accountStats.classifyValue` lo usa en
lugar de sus cortes fijos; el resto del backend no cambia, porque el
alcance se calcula al armar el listado y no se guarda. El frontend sigue
sin conocer cortes: muestra lo que manda el backend. Detalle en `design.md`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/reachRule.js` | New | La regla: lectura del `.env`, razón y nivel |
| `src/accountStats.js` | Modified | `classifyValue` usa la regla; `highlightOf` elige por nivel y devuelve `level`; salen `RATIO_LOW` y `RATIO_HIGH` |
| `server.js` | Modified | Valida `REACH_*` al arrancar y muestra los números en uso |
| `scripts/recalc-account-stats.js` | Modified | Cuenta los candidatos a "Se despegaron" por alcance alto |
| `.env.example` | Modified | Las seis variables |
| `public/js/monitoring.js` | Modified | Razón con dos decimales cortados; detalle de la tabla; "Se despegaron" |
| `public/js/monitoringFeed.js` | Modified | Cartelito de la razón; orden "Mayor alcance" |
| `public/js/monitoringFeedPopup.js` | Modified | Razón junto a la etiqueta; mediana y colchón por métrica |
| `public/instagram.html` | Modified | El subtítulo de "Se despegaron" ya no habla de promedio |
| `public/css/styles.css` | Modified | Ajuste aparte, en la misma rama: en el pie de la tarjeta del feed, el sentimiento y "Abrir ↗" van juntos a la izquierda |
| `test/reachRule.test.js` | New | La regla, pura |
| `test/accountStats.test.js`, `test/likesNull.test.js` | Modified | Niveles y destacado con la regla nueva |
| `README.md`, `CLAUDE.md` | Modified | La regla y sus variables |
| `data/`, `src/db.js`, adapters, X | Unchanged | Sin cambios de datos ni de esquema |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Un número mal escrito en el `.env` cambia en silencio lo que se destaca | Med | Validación al arrancar con mensaje claro; "2.000" se rechaza; línea de arranque con los números en uso |
| La razón nueva se lee como "veces la mediana" | Med | Dos decimales, y al lado el valor, la mediana real y el colchón (pop-up, detalle de la tabla, "Se despegaron", cartelito de la tarjeta) |
| El número redondeado contradice a la etiqueta en el borde (1,096 → "1,10" con "bajo") | Med | La razón se corta a dos decimales, no se redondea |
| "Bajo" se lee como "le fue mal" | Med | Documentado: es "no se despega de lo normal"; es la mayoría de los posteos |
| El frontend y el backend combinan las métricas cada uno por su lado | Low | Misma regla en los dos (mejor nivel, después mayor razón); test del lado del backend |

## Rollback Plan

Revertir los commits de la rama. No hay cambios de datos ni de esquema:
las medianas guardadas son las mismas. Sin tocar código, la regla anterior
se reproduce desde el `.env`: `REACH_LIKES_CUSHION=0`,
`REACH_COMMENTS_CUSHION=0`, `REACH_LIKES_FLOOR=0`, `REACH_COMMENTS_FLOOR=0`
y `REACH_MID_RATIO=0.5` (razón = valor / mediana, alto desde 1,5 y bajo por
debajo de 0,5). Lo cubre un caso de `test/reachRule.test.js`. La pantalla
igual mostraría la razón con dos decimales.

## Success Criteria

- [x] Con la copia de la base del 9/10/2026: 41 alto, 42 medio, 378 bajo y
      12 sin etiqueta, los mismos números del análisis aprobado
- [x] Los seis números se leen del `.env`; un valor inválido no deja arrancar
- [x] "Se despegaron" muestra solo posteos con alcance alto
- [x] La razón se muestra con dos decimales y nunca contradice a su etiqueta
- [x] El pop-up muestra la mediana real de la cuenta
- [x] Suite verde con `IG_ACTOR=apidojo` y con `IG_ACTOR=apify`
