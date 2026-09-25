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

**En una línea** (Instagram, desde septiembre 2026): `searches` es **lo
único que busca publicaciones** (una consulta real a la búsqueda de
Instagram, con costo por término); `accounts` y `keywords` no le piden nada
a Apify en la detección: son guía para el clasificador (ver el detalle de
cada una más abajo).

## `accounts`

Usuarios de esa red a trackear (sin `@`). En **X** todo lo que publiquen se
busca (`from:usuario`, vía Grok) y cada posteo se evalúa como cualquier
otra fuente. En **Instagram** el perfil ya NO se consulta en la detección
(el adapter lo declara con `capabilities.detectAccounts: false`): la cuenta
queda como guía para el clasificador y como universo del benchmark y del
refresco de métricas, que sí consultan el perfil cuando la cuenta aparece
en `detected_posts`. Al agregar una cuenta se sigue validando contra Apify
que exista.

## `keywords`

Una sola lista plana por red. Un hashtag se escribe con el `#` adelante,
dentro de esta misma lista (`"#JorgeMacri"`). Lo que significa cada entrada
cambia según la red:

- **Instagram**
  - Ni las keywords ni los hashtags disparan corridas de Apify: desde
    septiembre 2026 la página del hashtag ya NO se recorre
    (`capabilities.detectHashtags: false`). Lo único que trae publicaciones
    es `searches` (abajo).
  - Una **coincidencia literal** con una keyword (con `#` o sin él, como
    substring, sin distinguir mayúsculas) en el caption de un resultado de
    búsqueda viaja como **pista** al clasificador ("el texto contiene el
    término X de nuestra lista"), que decide por el contenido. No es un
    veredicto: un posteo de otra ciudad con el término igual se descarta.
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

Búsquedas por palabra clave (la "lupita" de la solapa): desde septiembre
2026, **la única fuente de detección de Instagram**. Es una lista
**distinta** de `keywords`: las keywords son guía para el clasificador;
cada término de `searches` dispara **una consulta cobrada por ciclo** a la
búsqueda nativa de Instagram (actor `apidojo/instagram-scraper-api`: 0,015
usd con 20 posteos incluidos, 0,0005 por cada uno de más hasta
`SEARCH_RESULTS_LIMIT`). Por eso va corta y elegida a mano: buscar las 60 y
pico keywords sería carísimo. Lo que trae **no entra directo**: Instagram
asocia al término mucho contenido ajeno, así que lo decide el clasificador
(con la pista de la búsqueda y de la coincidencia literal si la hay) y
queda con el motivo `Búsqueda: <término>`. Un posteo sin texto se descarta.

La búsqueda devuelve los posteos **recortados** (sin caption ni contadores),
así que a cada resultado nuevo se le pide el detalle antes de filtrarlo: un
solo run por ciclo de `apify/instagram-scraper` con todas las URLs (0,0023
usd por posteo en Starter), hasta `SEARCH_ENRICH_LIMIT` posteos por ciclo
(default 100; `0` lo apaga y los resultados sin texto se descartan). Cada
posteo se consulta una sola vez: lo que se descartó queda anotado en la
tabla `search_seen` y no se vuelve a pagar ni a evaluar, aunque la búsqueda
lo siga trayendo. Ojo con eso al sumar keywords: un posteo ya descartado no
se re-evalúa con las keywords nuevas.

Se administra desde la caja "Búsquedas por palabra clave" de la solapa de
Instagram (o `POST`/`DELETE /api/monitoring/searches`), sin verificación
contra Apify al agregar. Con `IG_ACTOR=apify` (el actor anterior) no hay
búsqueda: los términos quedan guardados pero el ciclo avisa y los ignora,
y agregar uno nuevo se rechaza con ese mensaje. X no usa esta lista: allá
cada keyword ya es una búsqueda.

## Lo que las keywords NO cubren

Las keywords no detectan nada por sí solas: la relevancia de cada resultado
de búsqueda la decide el clasificador de `src/classifier.js`
(`clasificarPosteo`) por el contenido, con la coincidencia literal como
pista. Así entra un anuncio de gestión que no lo nombra y se descarta un
posteo de otra ciudad que usa el mismo término. (En X la decisión del
clasificador solo interviene para los posteos de cuentas trackeadas: lo
que llega por búsqueda ya entra como relevante.)

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
