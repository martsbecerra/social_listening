// ==========================================================================
// platforms/index.js — Registro de adapters de plataforma.
// --------------------------------------------------------------------------
// Cada plataforma soportada por el monitoreo se registra acá con su adapter.
// El orquestador (src/monitor.js), el benchmark (src/accountStats.js), el
// refresco de métricas (src/metricsRefresh.js) y server.js recorren este
// registro: sumar una red es agregar el módulo al objeto PLATFORMS.
//
// CONTRATO DEL ADAPTER (ver instagram.js y x.js):
//   id            'instagram' | 'x' | ... — es el valor que se guarda en la
//                 columna `plataforma` y la clave de sección en
//                 config/monitoring.json.
//   label         Nombre para mostrar y para los prompts del clasificador.
//   capabilities  { benchmark, followers, metricsRefresh }: qué sabe hacer
//                 la plataforma ADEMÁS de detectar posteos. Quien orquesta
//                 decide por acá, nunca por el nombre de la plataforma.
//   isConfigured() true si están las credenciales que necesita su fuente.
//                 Sin ellas, el ciclo la saltea con un aviso en vez de
//                 fallar fuente por fuente.
//   validateAccount(account), validateHashtag(tag)
//                 Tiran un Error con userMessage si no vale la pena guardar.
//   scrapeAccount(username, { resultsLimit, lookback })
//   scrapeHashtag(tag, { resultsLimit, lookback })
//   scrapeKeyword(keyword, { resultsLimit, lookback })   [opcional]
//   scrapeSearch(term, { resultsLimit, lookback })        [opcional]
//                 Búsqueda por palabra clave de la lista `searches` del
//                 config (Instagram con apidojo). Si el adapter no la
//                 expone, el orquestador avisa e ignora los términos.
//                 Devuelven posteos normalizados (ver normalizePost). Los
//                 dos parámetros son sugerencias del orquestador; cada
//                 adapter los traduce a su fuente o los pisa con su propio
//                 tope. Si la fuente devuelve cuota agotada / rate limit /
//                 credenciales inválidas, el error sale con `code` (ver
//                 platforms/errors.js): el orquestador lo trata como error
//                 de la plataforma entera, no de esa fuente.
//   normalizePost(raw, { account, sourceType, sourceQuery })
//                 → { id, account, url, caption, hashtagsText, likes,
//                     comments, postedAt, postType, followers, sourceType,
//                     sourceQuery, ...métricas propias (retweets, views) }
//                 `followers`: seguidores del autor si la fuente los trae en
//                 el mismo posteo (Instagram con apidojo), si no null. El
//                 orquestador los usa como snapshot del posteo nuevo y para
//                 actualizar la caché account_followers (rememberFollowers).
//                 `id` tiene que ser único ENTRE plataformas (X usa el
//                 prefijo "x:").
//                 sourceType le dice al orquestador cómo evaluar relevancia:
//                   'account'  posteo de una cuenta trackeada.
//                   'hashtag'  página/feed de descubrimiento (Instagram):
//                              trae todo lo que usa el tag, hay que filtrar.
//                   'keyword'  resultado de una búsqueda por término: la
//                              fuente ya lo validó, relevante sin pasar por
//                              classifyRelevance. En X vale tanto para las
//                              keywords como para los hashtags (allá un
//                              hashtag es una búsqueda más), con el término
//                              en sourceQuery.
//                   'search'   búsqueda por palabra clave de Instagram
//                              (lista `searches`, scrapeSearch): Instagram
//                              asocia al término mucho contenido ajeno, así
//                              que se filtra como un hashtag (literal o
//                              semántica), con el término en sourceQuery.
//   buildProfileUrl(username)
//   fetchAccountFollowers(username) → number | null. Nunca tira. Es el
//                 camino de respaldo cuando los posteos no traen
//                 `followers`; un adapter cuya fuente los trae en cada
//                 posteo puede devolver null sin consultar nada.
//   metrics       [{ key, label, primary }]: qué métricas del posteo expone
//                 la plataforma. El orquestador guarda y refresca solo esas
//                 claves; el frontend va a armar las columnas leyendo de acá.
// ==========================================================================

const instagram = require('./instagram');
const x = require('./x');

const PLATFORMS = { instagram, x };

const DEFAULT_PLATFORM_ID = 'instagram';

function getPlatform(id) {
  const platform = PLATFORMS[id];
  if (!platform) {
    const e = new Error(
      `Plataforma desconocida: "${id}". Soportadas: ${Object.keys(PLATFORMS).join(', ')}.`
    );
    e.userMessage = e.message;
    throw e;
  }
  return platform;
}

function listPlatformIds() {
  return Object.keys(PLATFORMS);
}

module.exports = { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID };
