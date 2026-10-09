# Design: alcance-colchon

## Technical Approach

El alcance de un posteo ya se calculaba en un solo punto del backend
(`accountStats.classifyValue`, una vez por métrica, al armar el listado de
`/api/monitoring/posts`) y no se guarda en la base. El cambio reemplaza la
cuenta de ese punto por una regla configurable y deja todo lo demás como
está: las medianas, los motivos de "sin referencia", la forma del
`benchmark` (con campos de más) y la combinación de las dos métricas, que
sigue haciendo el frontend.

## Architecture Decisions

- **La regla, en un módulo puro (`src/reachRule.js`).** Sin dependencias:
  no carga `src/db.js`, así que se prueba sin base y `server.js` puede
  validarlo antes de cargar nada. Calcado de `refreshMode.js` y
  `igActor.js`: `resolveReachRule(env)` tira con `userMessage` si un valor
  no es válido.
- **Razón con colchón.** `ratio = (valor + colchón) / (mediana + colchón)`.
  El colchón pesa mucho cuando la mediana es chica y casi nada cuando es
  grande: una cuenta con mediana 3.000 de likes se mide casi igual que
  antes; una con mediana 2 necesita 200 likes de más para llegar a medio.
  Con colchón 0 y mediana 0 la razón se calcula contra 1, como antes.
- **Piso solo para el alto.** `alto` exige `ratio >= REACH_HIGH_RATIO` y
  `valor >= piso`. Una métrica que pasa el corte sin llegar al piso queda
  en `normal`, nunca en `bajo`. Con los valores por defecto el piso no
  actúa (alto ya exige 1,5 × mediana + medio colchón, y el piso es
  justamente medio colchón): queda como resguardo si el colchón se achica.
- **Un corte de medio y uno de alto, iguales para las dos métricas.** Lo
  que cambia por métrica es el colchón y el piso. Los cortes se comparan
  con la razón tal cual sale de la división: `2200 / 2000` da exactamente
  el mismo número que `1.1`, así que el borde cae del lado de medio.
- **Comentarios: colchón 300 y piso 150.** Equivalentes a los de likes por
  el lugar que ocupan entre los posteos: 2.000 likes dejan por debajo al
  95 % de los posteos, igual que 336 comentarios; 1.000 likes, al 91 %,
  igual que 134. Redondeado, y con la misma proporción (el piso es la
  mitad del colchón). Así ninguna métrica pesa más: 26 posteos dan alto
  por likes y 32 por comentarios.
- **Corte de medio en 1,1.** Elegido por el dueño entre 1,05, 1,1, 1,2 y
  1,3: deja 42 posteos en medio (contra 41 en alto) y pide una diferencia
  que se nota (200 likes o 30 comentarios sobre lo normal de la cuenta).
- **Los seis números, del `.env`.** Se leen una vez, al cargar
  `accountStats.js`. Colchones y pisos: enteros sin separador de miles
  (`2.000` se leería como 2 y se rechaza). Cortes: mayores que 0, con punto
  o coma decimal, y el de medio menor que el de alto. Un valor inválido
  aborta el arranque: es el mismo criterio que `IG_ACTOR` y `REFRESH_MODE`,
  porque un typo cambiaría en silencio qué se destaca.
- **Nada se recalcula.** El alcance se arma en cada pedido del listado: un
  cambio en el `.env` vale desde el próximo arranque. `account_stats` no
  se toca.
- **El `benchmark` de cada métrica lleva `cushion` y `floor`.** La razón ya
  no se entiende sola (229 likes contra una mediana de 21 dan 1,10): la
  pantalla muestra al lado el valor, la mediana real y el colchón, sin
  tener esos números repetidos en el frontend.
- **`benchmark.top` elige por nivel y devuelve `level`.** Antes elegía la
  métrica de mayor razón y el frontend aplicaba el corte de 1,5. Con piso,
  una métrica puede tener la razón más alta sin ser `alto`: ahora gana la
  de mejor nivel y, a igual nivel, la de mayor razón (empate: comentarios).
  "Se despegaron" filtra `top.level === 'alto'`. Es la misma combinación
  que `postReach` en el frontend.
- **La razón se corta a dos decimales, no se redondea.** Con cortes de dos
  decimales, cortar garantiza que el número que se ve quede del mismo lado
  del corte que la etiqueta. Caso real: 32 comentarios contra una mediana
  de 3 dan 1,0957, que redondeado es "1,10" y es bajo; cortado es "1,09".
  Se hace en `formatBenchmarkRatio`; el backend manda la razón exacta, que
  es la que ordena.
- **"Mayor alcance" ordena por etiqueta y después por razón.** Con los
  valores por defecto da lo mismo que ordenar por razón; con otro piso, un
  medio podría tener más razón que un alto.
- **`normal` se sigue llamando así en el backend** y se muestra "medio".
  Renombrarlo tocaba clases de CSS y la forma de la API sin ganar nada.

## Data Flow

```
.env (REACH_*) ─► reachRule.resolveReachRule() ─► accountStats.REACH_RULE
                                                        │
GET /api/monitoring/posts                               ▼
  server.js ─► classifyPostAgainstBenchmark ─► classifyValue(métrica, valor, mediana)
                                                 └► reachLevel ─► { level, ratio, cushion, floor }
                                             └► highlightOf ─► top { metric, level, ratio }
  respuesta: post.benchmark = { likes, comments, top }
                │
                ├─► postReach (monitoring.js): etiqueta, filtro "Alcance", orden
                ├─► renderHighlightCards: "Se despegaron" (top.level === 'alto')
                ├─► buildBenchLine: detalle de la tabla
                └─► feed y pop-up: razón, mediana real y colchón
```

## Números del análisis (copia de la base del 9/10/2026, 473 posteos)

| | Alto | Medio | Bajo | Sin etiqueta |
|---|---|---|---|---|
| Regla anterior | 202 | 220 | 39 | 12 |
| Regla nueva | 41 | 42 | 378 | 12 |

Ningún posteo pasa a alto sin serlo antes. De los 202 alto anteriores, 41
siguen, 42 pasan a medio y 119 a bajo; los 220 medio anteriores pasan a
bajo.
