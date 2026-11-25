// ==========================================================================
// llm/imagenes.js — Imágenes en el mensaje de usuario (noviembre 2026, rama
// clasificacion-foto-y-exclusiones: la portada de una publicación como
// respaldo del clasificador, ver src/classifier.js).
// --------------------------------------------------------------------------
// Entrada de los dos proveedores: `images`, una lista de
// { mediaType: 'image/jpeg' | 'image/png' | 'image/webp', data: <base64> }.
// Lo que no tiene esa forma se descarta (nunca un link: la app baja la
// imagen y la manda en base64, así el modelo no sale a buscar nada).
// ==========================================================================

const TIPOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Las imágenes válidas de la lista (hasta 4), o [] si no hay. */
function normalizarImagenes(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((i) => i && TIPOS.has(i.mediaType) && typeof i.data === 'string' && i.data.length > 0 && BASE64_RE.test(i.data))
    .slice(0, 4)
    .map((i) => ({ mediaType: i.mediaType, data: i.data }));
}

/** El contenido del mensaje de usuario para OpenRouter (formato de OpenAI). */
function contenidoOpenRouter(userPrompt, images) {
  const imgs = normalizarImagenes(images);
  if (imgs.length === 0) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    ...imgs.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })),
  ];
}

/** El contenido del mensaje de usuario para Anthropic (las imágenes primero, como recomienda). */
function contenidoAnthropic(userPrompt, images) {
  const imgs = normalizarImagenes(images);
  if (imgs.length === 0) return userPrompt;
  return [
    ...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
    { type: 'text', text: userPrompt },
  ];
}

module.exports = { normalizarImagenes, contenidoOpenRouter, contenidoAnthropic };
