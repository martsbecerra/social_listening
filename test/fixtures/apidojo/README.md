# Fixtures del actor apidojo/instagram-scraper-api

Salida REAL del actor, de una corrida chica autorizada el 2026-09-18
(cinco runs, US$ 0,045), usada por `test/apidojoProvider.test.js` para
probar la normalización (`src/platforms/instagramApidojo.js`), el mapeo de
`post_type` y la ventana de fecha sin llamar a Apify.

| Archivo | Input | Items |
|---|---|---|
| `profile.json` | `{ startUrls: ["https://www.instagram.com/clavescom/"], maxItems: 10 }` | 10 |
| `hashtag.json` | `{ startUrls: [".../explore/tags/JorgeMacri/"], maxItems: 10, until: "2026-09-17" }` | 7 |
| `search.json` | `{ keywords: ["jorge macri"], maxItems: 10, until: "2026-09-17" }` | 2 |
| `not-found.json` | `{ startUrls: [".../cuenta_que_no_existe_123456/"], maxItems: 1 }` | 0 |

Las URLs firmadas del CDN (imágenes, videos, fotos de perfil) se
reemplazaron por `https://cdn.invalid/...`: vencen a los pocos días y pesan.
Todo lo demás está tal cual vino.

## Lo que se verificó con esta corrida

- `id` y `url` son los mismos que guardó el actor oficial en
  `detected_posts` (coincidencia exacta por id y por url en los posteos ya
  conocidos de `@clavescom` y de los hashtags), así que el dedupe y el
  refresco de métricas siguen matcheando.
- Indicadores: `isCarousel` + `carouselMedia[]`, `isVideo` + `video
  { playCount, duration }`, `isPinned`, `isPaidPartnership`,
  `isLikeAndViewCountsDisabled`; `type` es siempre `"post"`.
- Los posteos de un perfil vienen del más nuevo al más viejo.
- `owner.followerCount` (con `followingCount` y `postCount`) viene SOLO en la
  consulta de perfil; en hashtag y búsqueda el `owner` llega sin seguidores.
- Un perfil inexistente devuelve `[]`, no un item de error.
- La corrida de perfil con `until: "2026-09-17"` devolvió los mismos 10
  ids que sin `until` (los 10 posteos más nuevos de `@clavescom` son de ese
  día), y la cuenta no tiene posteos fijados: cómo se lleva `until` con un
  posteo fijado viejo queda para verlo en el ciclo completo.
- Ciclo real completo del 2026-09-18 (29 llamadas, US$ 0,1945): `until`
  convive con posteos fijados (`@nuncavasaverlo` devolvió 5 posteos, 3
  fijados); el refresco matcheó por id 16 de 21 posteos calientes (los
  otros 5 quedaron fuera de los 15 más nuevos de cuentas que publican mucho
  o de la ventana); `owner.followerCount` es el del perfil CONSULTADO
  incluso en posteos en colaboración con otro owner (no se le atribuye al
  autor); la consulta de perfil cobró posteos extra recién desde el 13; la
  búsqueda se cobra como `tag-query`; "jorge macri" devolvió 1 item y
  "macri ciudad" 0, otra vez sin caption ni contadores.
- En la búsqueda los dos items vinieron con `caption`, `likeCount` y
  `commentCount` en `null` (dos reels de cuentas de fans). Pocos datos para
  saber si es lo normal de la búsqueda o de esos dos posteos; a mirar en
  el ciclo real de la Fase 2.

## Detalle de un posteo (2026-09-18, US$ 0,0073)

El reel que la búsqueda "jorge macri" devolvió sin caption ni contadores
(`3988633620029857812`, `/p/DdaeSUND2AU/`), pedido por URL a los dos actores:

- `post.json` (este directorio): apidojo, `{ startUrls: [url], maxItems: 1 }`,
  consulta de posteo suelto (0,005 usd).
- `../apify/post-detail.json`: apify/instagram-scraper,
  `{ directUrls: [url], resultsType: 'posts', resultsLimit: 1 }` (0,0023 usd).

Los dos devuelven el mismo id y traen lo que la búsqueda recorta: caption
("Jorge Macri impulsa darle un FIN AL KIRCHNERISMO #jorgemacri2027
#buenosaires #caba"), 2 likes, 0 comentarios y 225 reproducciones. Es decir:
el posteo SÍ tiene texto y era relevante; la búsqueda devuelve un objeto
reducido. Ninguno de los dos trae seguidores en esta consulta.

`search.json` y `../apify/post-detail.json` son la entrada de
`test/searchEnrichment.test.js`: el detalle de los resultados de búsqueda
sin caption se pide al actor oficial (`fetchPostDetails`), que es el más
barato de los dos para esta consulta.
