# config/monitoring.json

Define qué se monitorea. Se puede editar a mano (respetando el formato
JSON) o desde los botones "Agregar" / "Quitar" de la solapa "Monitoreo en
vivo": cada solapa (Instagram, X) escribe su propia sección.

## Formato: una sección por red

El archivo tiene una clave por plataforma registrada en `src/platforms/`,
cada una con sus propias cuentas y keywords:

```json
{
  "instagram": { "accounts": ["..."], "keywords": ["...", "#hashtag"], "searches": ["jorge macri"] },
  "x": { "accounts": ["..."], "keywords": ["Jorge Macri"] }
}
```

`searches` es opcional y hoy solo tiene sentido en Instagram (ver abajo);
aparece en el archivo recién cuando se agrega el primer término.

Es el único formato que el código escribe; los anteriores se migran solos
(ver al final).

## `accounts`

Usuarios de esa red a trackear (sin `@`). Todo lo que publiquen se scrapea
(Instagram: el perfil, vía Apify; X: la búsqueda `from:usuario`, vía Grok) y
después cada posteo se evalúa igual que cualquier otra fuente (ver
`evaluateRelevance` en `src/monitor.js`).

## `keywords`

Una sola lista plana por red. Un hashtag se escribe con el `#` adelante,
dentro de esta misma lista (`"#JorgeMacri"`). Lo que significa cada entrada
cambia según la red:

- **Instagram**
  - Un **hashtag** es una **fuente de descubrimiento**: dispara una corrida
    del actor de Apify contra la página del hashtag
    (`instagram.com/explore/tags/...`) y **tiene costo** — se paga por cada
    resultado que trae, haya coincidencia real o no. Lo que trae se filtra
    después (coincidencia literal con alguna keyword, o el clasificador).
  - Una **keyword sin `#`** es un **filtro de texto gratuito**: se busca como
    substring (sin distinguir mayúsculas) dentro del caption de los posteos
    que ya se scrapearon por otra vía (cuenta trackeada o hashtag). No
    dispara ninguna corrida de Apify por sí sola.
- **X**
  - **Cada keyword es una búsqueda**, tenga `#` o no: Grok la busca
    literalmente en cada corrida (en X un hashtag no es una página que se
    recorre, es un término más), así que agregar keywords en X **sí tiene
    costo**. Un posteo que aparece por una de esas búsquedas se considera
    relevante sin pasar por el clasificador de relevancia; solo se le ponen
    título y sentimiento.

Sobre la lista de Instagram: además del nombre del Jefe de Gobierno y sus
variantes formales (título, abreviaturas, cargos anteriores), incluye
términos y apodos que circulan en la conversación pública real — algunos
informales y con connotación peyorativa/racial. Se registran **para poder
detectar** posteos que los usan, no porque sean "objetivo" de nada: es una
lista de términos de búsqueda, no de personas.

## `searches` (Instagram)

Búsquedas por palabra clave, la cuarta fuente de detección. Es una lista
**distinta** de `keywords`: las keywords son filtros de texto gratis sobre
lo que ya se scrapeó; cada término de `searches` dispara **una consulta
cobrada por ciclo** a la búsqueda nativa de Instagram (actor
`apidojo/instagram-scraper-api`: 0,015 usd con 20 posteos incluidos, hasta
`SEARCH_RESULTS_LIMIT`). Por eso va corta y elegida a mano: buscar las 60 y
pico keywords sería carísimo. Lo que trae **no entra directo**: Instagram
asocia al término mucho contenido ajeno, así que se filtra igual que un
hashtag (coincidencia literal con alguna keyword, o el clasificador) y
queda con el motivo `Búsqueda: <término>`. Un posteo sin texto se descarta.

Se administra desde la caja "Búsquedas por palabra clave" de la solapa de
Instagram (o `POST`/`DELETE /api/monitoring/searches`), sin verificación
contra Apify al agregar. Con `IG_ACTOR=apify` (el actor anterior) no hay
búsqueda: los términos quedan guardados pero el ciclo avisa y los ignora,
y agregar uno nuevo se rechaza con ese mensaje. X no usa esta lista: allá
cada keyword ya es una búsqueda.

## Lo que las keywords NO cubren

Ni las keywords ni los hashtags de Instagram detectan una mención que no use
ninguno de esos términos literalmente (por ejemplo, un anuncio de gestión
que no lo nombra). Para eso existe una capa aparte, semántica, en
`src/classifier.js` (`classifyRelevance`): le pregunta al clasificador si el
contenido igual habla de él o de su gestión, sin necesitar coincidencia de
texto. Las keywords son un filtro rápido y gratuito; la capa semántica es
la red de contención para lo que las keywords no anticiparon. (En X esa
capa solo interviene para los posteos de cuentas trackeadas: lo que llega
por búsqueda ya entra como relevante.)

## Formatos anteriores

El archivo tuvo dos formatos antes de este: uno plano (`accounts` y
`keywords` en la raíz, todo Instagram implícito) y uno anidado con
`hashtags` aparte (sin `#`) y las `keywords` agrupadas por categoría. Los
dos se migran solos al formato actual la primera vez que arranca el server
(las categorías se pierden: estaban solo para leer el archivo a mano). El
`config/monitoring-x.json` que tenía X cuando era un módulo aparte se
absorbe como sección `x` y queda renombrado a `.migrado`.

## `config/x-influencers/`

Padrón ANTIK-PRO para el análisis de X. `antik-pro.csv` (seguidores
enteros) se mergea con `antik-pro-extra.csv` (formato "Mil") al arrancar
si `x_influencers` está vacía, o con `npm run import-x-influencers`.
