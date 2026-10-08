// ==========================================================================
// postImages.js — Foto de cada posteo del monitoreo: una descarga, dos copias.
// --------------------------------------------------------------------------
// Los links de imagen de Instagram vencen a los pocos días, así que para
// mostrar la foto en el feed y en el pop-up hay que guardarla. Este módulo
// recibe el link que ya vino en una respuesta del scraper (nunca pide nada
// a Apify), baja la imagen con reglas estrictas y deja dos archivos JPEG
// hechos de esa única descarga (ver openspec/changes/monitoreo-fotos):
//   <media>/<plataforma>/<id>_thumb.jpg  miniatura de la tarjeta, 360 px de ancho
//   <media>/<plataforma>/<id>_full.jpg   imagen del pop-up, 900 px de lado largo
// <media> es data/media (data/ no se versiona ni se sirve como estático).
//
// No conoce la base: devuelve qué pasó y quien lo llama lo anota
// (db.markPostImageSaved / markPostImageFailed).
//
// Reglas de la descarga:
//   - solo https, solo hosts de la lista de la plataforma (IMAGE_HOSTS), sin
//     usuario, contraseña ni puerto en el link, y sin seguir redirecciones;
//   - la respuesta tiene que ser image/*;
//   - tope de tamaño (MAX_BYTES) y de tiempo (TIMEOUT_MS) por imagen;
//   - pocas a la vez, con limitador PROPIO (imageLimiter; nunca el
//     apifyLimiter ni los de benchmark/refresco: ver concurrencyLimiter.js);
//   - la tanda se corta tras MAX_NETWORK_FAILURES fallos de red seguidos
//     (la red no llega al servidor de imágenes: insistir solo demora el ciclo).
//
// NUNCA tira: todo fallo vuelve como resultado, para que una foto que no se
// pudo bajar no frene un ciclo de monitoreo. Un fallo tampoco toca las
// copias que ya estaban: se escribe a un temporal y se renombra recién con
// las dos copias listas.
//
// En los logs va el host, nunca el link: los links vienen firmados.
//
// POST_IMAGES=0 lo apaga (no baja nada; lo ya guardado se sigue sirviendo).
// MONITORING_MEDIA_DIR: solo para tests (carpeta temporal).
// ==========================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLimiter } = require('./concurrencyLimiter');

// sharp trae un binario por sistema operativo. Si no está (falta correr
// `npm install`, o se copió node_modules de otra máquina), las fotos quedan
// apagadas y el resto de la app sigue andando: este módulo lo van a cargar
// el monitoreo y el server, y una foto no puede impedir que arranquen.
let sharp = null;
try {
  sharp = require('sharp');
  // Es trabajo de fondo en la PC del piloto: una imagen por vez adentro de
  // sharp (aparte de cuántas descargas corren a la vez) y sin caché de archivos.
  sharp.concurrency(1);
  sharp.cache(false);
} catch (err) {
  console.error(
    '[imagenes] No se pudo cargar "sharp": las fotos de los posteos quedan apagadas. Corré `npm install`. Detalle:',
    err && err.message
  );
}

const MEDIA_DIR = process.env.MONITORING_MEDIA_DIR || path.join(__dirname, '..', 'data', 'media');

// Hosts de imágenes por plataforma: el nombre tiene que ser uno de estos o
// terminar en ".<uno de estos>". Una plataforma que no está acá no baja
// nada: no hay default.
const IMAGE_HOSTS = {
  instagram: ['cdninstagram.com', 'fbcdn.net'],
};

const SIZES = ['thumb', 'full'];
const THUMB_WIDTH = 360; // la tarjeta mide entre 250 y 300 px: cubre también Windows al 125 %
const THUMB_MAX_HEIGHT = 720; // resguardo para una imagen altísima; un reel (9:16) da 640
const FULL_LONG_SIDE = 900;
const THUMB_QUALITY = 72;
const FULL_QUALITY = 80;

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_INPUT_PIXELS = 50e6; // una imagen de más de 50 megapíxeles no es una foto de Instagram
const MAX_CONCURRENT = 3;
const MAX_NETWORK_FAILURES = 5;

// El servidor de imágenes dijo que ese link ya no sirve (venció, o el posteo
// se borró): no es un error nuestro ni de la red.
const EXPIRED_STATUSES = new Set([403, 404, 410]);

// Limitador PROPIO de las descargas de imágenes (ver el encabezado). Callado:
// son cientos de descargas cortas por ciclo y un renglón por cada una
// taparía el resto del log. Lo que falla se loguea acá abajo, foto por foto.
const imageLimiter = createLimiter(MAX_CONCURRENT, 'imagenes', { quiet: true });

/** ¿Se bajan fotos? No con POST_IMAGES=0, ni si sharp no cargó. */
function isEnabled() {
  return Boolean(sharp) && String(process.env.POST_IMAGES === undefined ? '' : process.env.POST_IMAGES).trim() !== '0';
}

/** El id va en el nombre del archivo: solo letras, números, guion y guion bajo. */
function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * Dónde van las dos copias de un posteo. null si la plataforma no tiene
 * imágenes o el id no sirve como nombre de archivo.
 * @returns {{ dir: string, thumb: string, full: string }|null}
 */
function imagePaths(plataforma, id, mediaDir = MEDIA_DIR) {
  if (!Object.prototype.hasOwnProperty.call(IMAGE_HOSTS, plataforma) || !isSafeId(id)) return null;
  const dir = path.join(mediaDir, plataforma);
  return { dir, thumb: path.join(dir, `${id}_thumb.jpg`), full: path.join(dir, `${id}_full.jpg`) };
}

/** Archivo de una copia ("thumb" | "full"), o null si algo no es válido. */
function imagePath(plataforma, id, size, mediaDir = MEDIA_DIR) {
  const paths = SIZES.includes(size) ? imagePaths(plataforma, id, mediaDir) : null;
  return paths ? paths[size] : null;
}

/** ¿Están las dos copias en disco? */
function hasLocalCopy(plataforma, id, mediaDir = MEDIA_DIR) {
  const paths = imagePaths(plataforma, id, mediaDir);
  return Boolean(paths) && fs.existsSync(paths.thumb) && fs.existsSync(paths.full);
}

/**
 * Valida el link contra las reglas de la plataforma.
 * @returns {{ ok: true, url: URL }|{ ok: false, reason: string, host: string|null }}
 */
function checkImageUrl(plataforma, rawUrl) {
  const hosts = Object.prototype.hasOwnProperty.call(IMAGE_HOSTS, plataforma) ? IMAGE_HOSTS[plataforma] : null;
  if (!hosts) return { ok: false, reason: 'plataforma-sin-imagenes', host: null };
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (err) {
    return { ok: false, reason: 'link-invalido', host: null };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return { ok: false, reason: 'no-es-https', host };
  if (url.username || url.password || url.port) return { ok: false, reason: 'link-invalido', host };
  const allowed = hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) return { ok: false, reason: 'host-no-permitido', host };
  return { ok: true, url };
}

function failure(status, reason, { network = false } = {}) {
  return { ok: false, status, reason, network };
}

/**
 * Baja el cuerpo de la respuesta con tope de tamaño. Tira con code
 * 'DEMASIADO_GRANDE' si se pasa; cualquier otro error es de la red.
 */
async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const e = new Error('la respuesta declara más bytes que el tope');
    e.code = 'DEMASIADO_GRANDE';
    throw e;
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      const e = new Error('la respuesta supera el tope de tamaño');
      e.code = 'DEMASIADO_GRANDE';
      throw e;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Pide la imagen. Nunca tira.
 * @returns {Promise<{ ok: true, buffer: Buffer }|{ ok: false, status: string, reason: string, network: boolean }>}
 */
async function download(url, { fetchFn, timeoutMs, maxBytes }) {
  // Un solo reloj para todo: conectar, recibir los encabezados y bajar el cuerpo.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFn(url.href, {
      method: 'GET',
      redirect: 'manual', // una redirección podría llevar a cualquier host: no se sigue
      signal: controller.signal,
      headers: { Accept: 'image/*' },
    });
    const status = Number(response.status);
    if (status >= 300 && status < 400) return failure('error', 'redireccion');
    if (EXPIRED_STATUSES.has(status)) return failure('vencido', `http-${status}`);
    if (status !== 200) return failure('error', `http-${status}`);
    const type = String(response.headers.get('content-type') || '').trim().toLowerCase();
    if (!type.startsWith('image/')) return failure('error', 'no-es-imagen');
    const buffer = await readBodyCapped(response, maxBytes);
    if (buffer.length === 0) return failure('error', 'respuesta-vacia');
    return { ok: true, buffer };
  } catch (err) {
    if (err && err.code === 'DEMASIADO_GRANDE') return failure('error', 'demasiado-grande');
    // No llegó al servidor, se cortó en el medio o tardó demasiado.
    return failure('error', timedOut ? 'tiempo-agotado' : 'fallo-de-red', { network: true });
  } finally {
    clearTimeout(timer);
    // Si se salió antes de terminar de leer (demasiado grande, no es imagen),
    // corta la conexión en vez de dejarla bajando.
    controller.abort();
  }
}

/**
 * De los bytes de la imagen, las dos copias JPEG y las medidas de la
 * original (ya con su orientación aplicada). Tira si sharp no la puede leer.
 */
async function buildCopies(buffer) {
  const options = { limitInputPixels: MAX_INPUT_PIXELS };
  const meta = await sharp(buffer, options).metadata();
  const oriented = meta.autoOrient || meta;
  // rotate() sin argumentos aplica la orientación EXIF (una foto de celular
  // puede venir "acostada"); flatten() pone fondo blanco donde había
  // transparencia, que JPEG no tiene. Los metadatos no se copian.
  const jpeg = (resize, quality) =>
    sharp(buffer, options)
      .rotate()
      .resize({ ...resize, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  const thumb = await jpeg({ width: THUMB_WIDTH, height: THUMB_MAX_HEIGHT }, THUMB_QUALITY);
  const full = await jpeg({ width: FULL_LONG_SIDE, height: FULL_LONG_SIDE }, FULL_QUALITY);
  return { thumb, full, width: oriented.width, height: oriented.height };
}

/**
 * Escribe las dos copias sin dejar nunca un archivo a medias: primero las
 * dos a temporales en la misma carpeta, y recién con las dos completas se
 * renombran sobre los nombres definitivos.
 */
async function writeCopies(paths, { thumb, full }) {
  await fs.promises.mkdir(paths.dir, { recursive: true });
  const suffix = `.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpThumb = paths.thumb + suffix;
  const tmpFull = paths.full + suffix;
  try {
    await fs.promises.writeFile(tmpThumb, thumb);
    await fs.promises.writeFile(tmpFull, full);
    await fs.promises.rename(tmpThumb, paths.thumb);
    await fs.promises.rename(tmpFull, paths.full);
  } finally {
    await fs.promises.rm(tmpThumb, { force: true }).catch(() => {});
    await fs.promises.rm(tmpFull, { force: true }).catch(() => {});
  }
}

function logFailure(plataforma, id, reason, host) {
  console.error(`[imagenes] (${plataforma}) ${id}: no se guardó la imagen (${reason}${host ? `, host ${host}` : ''}).`);
}

/**
 * Baja la imagen de un posteo y guarda sus dos copias. NUNCA tira.
 *
 * @param {{ plataforma: string, id: string, url: string }} post
 * @param {{ fetchFn?: typeof fetch, mediaDir?: string, timeoutMs?: number, maxBytes?: number }} [deps]
 *   Para los tests; por defecto fetch global, data/media y los topes de arriba.
 * @returns {Promise<
 *   { ok: true, status: 'ok', sourceUrl: string, width: number, height: number, savedAt: string } |
 *   { ok: false, status: 'vencido'|'error', reason: string, network: boolean, sourceUrl: string|null } |
 *   { ok: false, skipped: true, reason: string }
 * >} `status` es lo que va a detected_posts.image_status. `skipped`: no se
 *   intentó (apagado, o se cortó la tanda) y no hay nada que anotar.
 *   `network`: el fallo fue de la red, no del link.
 */
async function savePostImage({ plataforma, id, url } = {}, deps = {}) {
  const sourceUrl = typeof url === 'string' && url ? url : null;
  try {
    if (!isEnabled()) return { ok: false, skipped: true, reason: sharp ? 'apagado' : 'sin-sharp' };
    const mediaDir = deps.mediaDir || MEDIA_DIR;
    const checked = checkImageUrl(plataforma, url);
    const paths = imagePaths(plataforma, id, mediaDir);
    if (!checked.ok || !paths) {
      const reason = checked.ok ? 'id-invalido' : checked.reason;
      logFailure(plataforma, id, reason, checked.ok ? null : checked.host);
      return { ...failure('error', reason), sourceUrl };
    }
    const host = checked.url.hostname;

    const downloaded = await download(checked.url, {
      fetchFn: deps.fetchFn || fetch,
      timeoutMs: deps.timeoutMs || TIMEOUT_MS,
      maxBytes: deps.maxBytes || MAX_BYTES,
    });
    if (!downloaded.ok) {
      logFailure(plataforma, id, downloaded.reason, host);
      return { ...downloaded, sourceUrl };
    }

    let copies;
    try {
      copies = await buildCopies(downloaded.buffer);
    } catch (err) {
      logFailure(plataforma, id, 'imagen-ilegible', host);
      return { ...failure('error', 'imagen-ilegible'), sourceUrl };
    }

    await writeCopies(paths, copies);
    return { ok: true, status: 'ok', sourceUrl, width: copies.width, height: copies.height, savedAt: new Date().toISOString() };
  } catch (err) {
    // No poder escribir en disco, o cualquier cosa no prevista.
    console.error(`[imagenes] (${plataforma}) ${id}: no se guardó la imagen (error inesperado):`, err && err.message);
    return { ...failure('error', 'error-inesperado'), sourceUrl };
  }
}

/**
 * Lo mismo para una tanda: pocas a la vez (imageLimiter) y con corte si la
 * red no llega al servidor de imágenes. NUNCA tira. Los resultados salen en
 * el mismo orden que los posteos.
 *
 * @param {{ plataforma: string, id: string, url: string }[]} posts
 * @param {object} [deps] los de savePostImage, más onResult(result, index):
 *   se llama por cada posteo apenas tiene resultado (para el progreso del
 *   ciclo). Si tira, se ignora.
 * @returns {Promise<object[]>} un resultado de savePostImage por posteo; los
 *   que no se llegaron a intentar por el corte salen `skipped` con
 *   reason 'corte-por-red'.
 */
async function savePostImages(posts, deps = {}) {
  const list = Array.isArray(posts) ? posts : [];
  let cut = false;

  // "Seguidos" es en el orden de la lista, no en el que van terminando: con
  // varias descargas a la vez, un fallo de red (que vuelve al instante) le
  // gana a una descarga que anda (que tarda), y contarlos por orden de
  // llegada cortaría una tanda que en realidad está funcionando. Cada
  // resultado se anota en su lugar y, con cada fallo de red, se cuenta la
  // racha de fallos pegados a él en la lista entre los que ya terminaron.
  // No se espera a que terminen los anteriores: si la red se cae a mitad de
  // tanda, una descarga queda colgada hasta su tope de tiempo mientras las
  // que siguen fallan al instante, y esperar a la colgada dejaba intentar la
  // lista entera.
  const outcomes = new Array(list.length); // sin terminar: undefined; 'red' | 'otro' | 'salteado'
  const note = (index, result) => {
    outcomes[index] = result.skipped ? 'salteado' : result.network ? 'red' : 'otro';
    if (outcomes[index] !== 'red' || cut) return;
    let run = 1;
    for (let i = index - 1; i >= 0 && outcomes[i] === 'red'; i -= 1) run += 1;
    for (let i = index + 1; i < list.length && outcomes[i] === 'red'; i += 1) run += 1;
    if (run >= MAX_NETWORK_FAILURES) {
      cut = true;
      console.error(
        `[imagenes] ${MAX_NETWORK_FAILURES} fallos de red seguidos: se corta la tanda de imágenes. ` +
          'Lo que falta se intenta en el próximo ciclo que traiga el link.'
      );
    }
  };

  const settled = await Promise.allSettled(
    list.map((post, index) =>
      imageLimiter.run(async () => {
        const result = cut ? { ok: false, skipped: true, reason: 'corte-por-red' } : await savePostImage(post, deps);
        note(index, result);
        if (typeof deps.onResult === 'function') {
          try {
            deps.onResult(result, index);
          } catch (err) {
            // El aviso es de cortesía: no puede romper la tanda.
          }
        }
        return result;
      }, `${post && post.plataforma}:${post && post.id}`)
    )
  );
  return settled.map((entry) =>
    entry.status === 'fulfilled' ? entry.value : { ...failure('error', 'error-inesperado'), sourceUrl: null }
  );
}

module.exports = {
  savePostImage,
  savePostImages,
  imagePath,
  imagePaths,
  hasLocalCopy,
  checkImageUrl,
  isEnabled,
  imageLimiter,
  MEDIA_DIR,
  IMAGE_HOSTS,
  SIZES,
  THUMB_WIDTH,
  FULL_LONG_SIDE,
  MAX_BYTES,
  TIMEOUT_MS,
  MAX_NETWORK_FAILURES,
};
