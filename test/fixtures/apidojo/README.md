# Fixtures del actor apidojo/instagram-scraper-api

Salida del actor para cada tipo de consulta, usada por
`test/apidojoProvider.test.js` para probar la normalización
(`src/platforms/instagramApidojo.js`), el mapeo de `post_type` y la ventana
de fecha sin llamar a Apify.

- `profile.json`: consulta de perfil (`startUrls` con la URL del perfil).
- `hashtag.json`: consulta de hashtag (`startUrls` con `/explore/tags/`).
- `search.json`: búsqueda por palabra clave (`keywords`).
- `not-found.json`: respuesta para un perfil inexistente (`maxItems: 1`).

**Estado: PROVISORIAS.** Están armadas a mano con la forma documentada en
el README del actor (id, code, url, createdAt, caption, likeCount,
commentCount, isVideo, video, owner.followerCount). Los nombres de los
indicadores de carrusel y de fijado (`isCarousel`, `isPinned`) y la forma
del item sin resultados (`noResults`) NO están documentados: se reemplazan
por la salida real de una corrida chica autorizada por el dueño, y
`derivePostType` / `isNoResults` se ajustan a lo que se vea ahí.
