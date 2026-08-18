# config/monitoring.json

Define qué se monitorea. Se puede editar a mano (respetando el formato
JSON) o desde los botones "Agregar" de la solapa "Monitoreo en vivo" —
con el aviso importante que está más abajo.

## `accounts`

Nombres de usuario de Instagram a trackear (sin `@`). Todo lo que publiquen
se scrapea; después se evalúa igual que cualquier otra fuente (ver
`evaluateRelevance` en `src/monitor.js`).

## `hashtags`

Hashtags a trackear, **sin el `#`**. A diferencia de `keywords`, un hashtag
es una **fuente de descubrimiento**: cada uno dispara una corrida del actor
de Apify contra esa página (`instagram.com/explore/tags/...`), y **tiene
costo** — se paga por cada resultado que trae, haya coincidencia real o no.

## `keywords`

Agrupadas por categoría, solo para que el archivo se pueda leer y mantener
a mano — el código no le presta atención a los nombres de los grupos, los
junta todos en una sola lista antes de usarlos (`loadConfig()` en
`src/monitor.js`).

A diferencia de un hashtag, una keyword es un **filtro de texto gratuito**:
se busca como substring (sin mayúsculas/minúsculas) dentro del caption de
los posteos que ya se scrapearon por otra vía (cuenta trackeada o hashtag).
No dispara ninguna corrida de Apify por sí sola, así que agregar keywords
no tiene costo adicional.

- **`nombre_y_cargo`**: el nombre del Jefe de Gobierno y sus variantes
  formales/de cargo (título, abreviaturas, cargos anteriores).
- **`apodos_observados`**: términos y apodos que circulan en la
  conversación pública real — incluye variantes informales y algunas con
  connotación peyorativa/racial. Se registran **para poder detectar**
  posteos que los usan, no porque sean "objetivo" de nada — es una lista de
  términos de búsqueda, no de personas.

## Lo que las keywords NO cubren

Ni las keywords ni los hashtags detectan una mención que no use ninguno de
esos términos literalmente (por ejemplo, un anuncio de gestión que no lo
nombra). Para eso existe una capa aparte, semántica, en
`src/classifier.js` (`classifyRelevance`): le pregunta a Claude si el
contenido igual habla de él o de su gestión, sin necesitar coincidencia de
texto. Las keywords son un filtro rápido y gratuito; la capa semántica es
la red de contención para lo que las keywords no anticiparon.

## ⚠️ Aviso: agregar desde la interfaz reordena el archivo

Los botones "Agregar" de cuenta/keyword en la web siguen funcionando, pero
escriben el archivo en un formato plano (sin las categorías de arriba). Si
usás esos botones, la próxima vez que se guarde el archivo vas a perder el
agrupamiento visual (ninguna keyword se pierde, solo el orden/las
categorías). Por ahora, si querés mantener la categorización prolija,
conviene agregar keywords nuevas editando este archivo a mano, en el grupo
que corresponda.
