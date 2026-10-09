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
//   - la respuesta tiene que ser image/* y el archivo, un JPEG, un PNG o un
//     WebP (por sus primeros bytes), de hasta MAX_INPUT_PIXELS;
//   - tope de tamaño (MAX_BYTES) y de tiempo (TIMEOUT_MS) por imagen;
//   - pocas a la vez, con limitador PROPIO (imageLimiter; nunca el
//     apifyLimiter ni los de benchmark/refresco: ver concurrencyLimiter.js);
//   - la tanda se corta tras MAX_CONSECUTIVE_FAILURES fotos seguidas con
//     fallo, del tipo que sea (la red no llega, el servidor responde mal, no
//     se puede escribir): insistir solo demora el ciclo y llena el log;
//   - cada tanda tiene además un tope de tiempo (BATCH_TIMEOUT_MS): con un
//     servidor lento pero vivo nada corta, y 150 fotos a 15 s cada una, de a
//     tres, eran más de 12 minutos de ciclo. Pasado el tope no arranca
//     ninguna descarga más; las que están en vuelo terminan.
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
// Tope de tamaño de la imagen, en píxeles. Instagram no sirve nada de más de
// 1440 × 1800 (2,6 megapíxeles); 12 dejan margen de sobra. El tope de bytes
// no alcanza: un PNG de 7000 × 7000 pesa 200 KB y decodificarlo ocupa más de
// 200 MB de memoria, y pueden ser tres a la vez.
const MAX_INPUT_PIXELS = 12e6;
const MAX_CONCURRENT = 3;
const MAX_CONSECUTIVE_FAILURES = 5;
// Tope de una tanda entera. De sobra para una tanda normal (150 fotos del
// refresco bajan en menos de un minuto) y corto para que un servidor lento
// no estire el ciclo: lo que no entra queda para después.
const BATCH_TIMEOUT_MS = 120000;

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

// network: el fallo fue de la red, no del link. retry: el fallo es pasajero
// (la red, el tope de tiempo, un error del servidor de imágenes, la
// escritura en disco) y con el mismo link puede andar más tarde; si no, el
// problema es de ese link o de esa imagen y reintentar da lo mismo.
function failure(status, reason, { network = false, retry = network } = {}) {
  return { ok: false, status, reason, network, retry };
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
    // 5xx, 429 y 408 son del servidor o del momento: se puede reintentar.
    if (status !== 200) return failure('error', `http-${status}`, { retry: status >= 500 || status === 429 || status === 408 });
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

// Formatos que se aceptan: los tres que sirve Instagram. Se reconocen por
// los primeros bytes del archivo, no por el content-type (eso lo dice el
// servidor) ni por lo que sharp sepa leer: sharp también abre SVG, GIF, TIFF
// o AVIF, y nada de eso tiene por qué llegarle.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'];

/** 'jpeg' | 'png' | 'webp' según los primeros bytes, o null. */
function sniffFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Error con el motivo del rechazo, para anotarlo tal cual. */
function rejected(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

/**
 * De los bytes de la imagen, las dos copias JPEG y las medidas de la
 * original (ya con su orientación aplicada). Tira si no es JPEG, PNG ni
 * WebP ('formato-no-permitido'), si tiene más de MAX_INPUT_PIXELS
 * ('imagen-demasiado-grande') o si sharp no la puede leer.
 */
async function buildCopies(buffer) {
  const format = sniffFormat(buffer);
  if (!format) throw rejected('formato-no-permitido');
  // metadata() lee solo el encabezado: el formato y las medidas se miran
  // antes de decodificar nada.
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  if (meta.format !== format || !ALLOWED_FORMATS.includes(meta.format)) throw rejected('formato-no-permitido');
  if (!(meta.width > 0) || !(meta.height > 0)) throw rejected('imagen-ilegible');
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw rejected('imagen-demasiado-grande');

  const options = { limitInputPixels: MAX_INPUT_PIXELS };
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
  console.error(`[imagenes] (${String(plataforma)}) ${String(id)}: no se guardó la imagen (${reason}${host ? `, host ${host}` : ''}).`);
}

/**
 * Baja la imagen de un posteo y guarda sus dos copias. NUNCA tira.
 *
 * @param {{ plataforma: string, id: string, url: string }} post
 * @param {{ fetchFn?: typeof fetch, mediaDir?: string, timeoutMs?: number, maxBytes?: number }} [deps]
 *   Para los tests; por defecto fetch global, data/media y los topes de arriba.
 * @returns {Promise<
 *   { ok: true, status: 'ok', sourceUrl: string, width: number, height: number, savedAt: string } |
 *   { ok: false, status: 'vencido'|'error', reason: string, network: boolean, retry: boolean, sourceUrl: string|null } |
 *   { ok: false, skipped: true, reason: string }
 * >} `status` es lo que va a detected_posts.image_status. `skipped`: no se
 *   intentó (apagado, o se cortó la tanda) y no hay nada que anotar.
 *   `network`: el fallo fue de la red, no del link. `retry`: el fallo es
 *   pasajero y vale la pena reintentar más tarde con el mismo link.
 */
async function savePostImage(post, deps = {}) {
  const { plataforma, id, url } = post && typeof post === 'object' ? post : {};
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
      // El formato o el tamaño no se aceptan, o sharp no la pudo leer.
      const reason = (err && err.reason) || 'imagen-ilegible';
      logFailure(plataforma, id, reason, host);
      return { ...failure('error', reason), sourceUrl };
    }

    await writeCopies(paths, copies);
    return { ok: true, status: 'ok', sourceUrl, width: copies.width, height: copies.height, savedAt: new Date().toISOString() };
  } catch (err) {
    // No poder escribir en disco, o cualquier cosa no prevista.
    console.error(`[imagenes] (${String(plataforma)}) ${String(id)}: no se guardó la imagen (error inesperado):`, err && err.message);
    return { ...failure('error', 'error-inesperado', { retry: true }), sourceUrl };
  }
}

/**
 * Lo mismo para una tanda: pocas a la vez (imageLimiter), con corte si las
 * fotos vienen fallando una atrás de otra y con un tope de tiempo para la
 * tanda entera. NUNCA tira. Los resultados salen en el mismo orden que los
 * posteos.
 *
 * @param {{ plataforma: string, id: string, url: string }[]} posts
 * @param {object} [deps] los de savePostImage, más onResult(result, index):
 *   se llama por cada posteo apenas tiene resultado (para anotarlo y para el
 *   progreso del ciclo). Si devuelve false, tira o rechaza, ese posteo
 *   cuenta como fallo para el corte: no se pudo anotar lo que pasó.
 *   maxBatchMs: tope de la tanda (por defecto BATCH_TIMEOUT_MS).
 *   cutOnExpired: false para que un link vencido no cuente para el corte
 *   (el reintento de fotos pendientes, donde es la respuesta esperable).
 * @returns {Promise<object[]>} un resultado de savePostImage por posteo; los
 *   que no se llegaron a intentar salen `skipped` con reason
 *   'corte-por-fallos' o 'tope-de-tiempo'.
 */
async function savePostImages(posts, deps = {}) {
  const list = Array.isArray(posts) ? posts : [];
  let cut = false;
  // Tope de tiempo de la tanda: pasado ese momento no arranca ninguna más.
  const maxBatchMs = Number(deps.maxBatchMs) > 0 ? Number(deps.maxBatchMs) : BATCH_TIMEOUT_MS;
  const deadline = Date.now() + maxBatchMs;
  let outOfTime = false;

  // Corte: MAX_CONSECUTIVE_FAILURES fotos seguidas que fallan, por lo que
  // sea: la red no llega, el servidor de imágenes responde mal, no se puede
  // escribir en la carpeta de fotos o no se puede anotar en la base. Si
  // vienen todas mal, insistir con el resto solo demora el ciclo y llena el
  // log. Una que sale bien corta la racha.
  //
  // "Seguidas" es en el orden de la lista, no en el que van terminando: con
  // varias descargas a la vez, un fallo de red (que vuelve al instante) le
  // gana a una descarga que anda (que tarda), y contarlos por orden de
  // llegada cortaría una tanda que en realidad está funcionando. Cada
  // resultado se anota en su lugar y, con cada fallo, se cuenta la racha de
  // fallos pegados a él en la lista entre los que ya terminaron. No se
  // espera a que terminen los anteriores: si la red se cae a mitad de tanda,
  // una descarga queda colgada hasta su tope de tiempo mientras las que
  // siguen fallan al instante, y esperar a la colgada dejaba intentar la
  // lista entera.
  const outcomes = new Array(list.length); // sin terminar: undefined; 'bien' | 'fallo' | 'salteado'
  const note = (index, outcome) => {
    outcomes[index] = outcome;
    if (outcome !== 'fallo' || cut) return;
    let run = 1;
    for (let i = index - 1; i >= 0 && outcomes[i] === 'fallo'; i -= 1) run += 1;
    for (let i = index + 1; i < list.length && outcomes[i] === 'fallo'; i += 1) run += 1;
    if (run >= MAX_CONSECUTIVE_FAILURES) {
      cut = true;
      console.error(
        `[imagenes] ${MAX_CONSECUTIVE_FAILURES} fotos seguidas con fallo: se corta la tanda de imágenes. ` +
          'Lo que falta queda para el próximo ciclo.'
      );
    }
  };

  const settled = await Promise.allSettled(
    list.map((post, index) =>
      imageLimiter.run(async () => {
        let result;
        if (cut) {
          result = { ok: false, skipped: true, reason: 'corte-por-fallos' };
        } else if (Date.now() >= deadline) {
          if (!outOfTime) {
            outOfTime = true;
            console.error(
              `[imagenes] la tanda de imágenes llegó a su tope de ${Math.round(maxBatchMs / 1000)} s: no arranca ninguna descarga más. ` +
                'Lo que falta queda para el próximo ciclo.'
            );
          }
          result = { ok: false, skipped: true, reason: 'tope-de-tiempo' };
        } else {
          try {
            result = await savePostImage(post, deps);
          } catch (err) {
            result = { ...failure('error', 'error-inesperado', { retry: true }), sourceUrl: null };
          }
        }
        // Quien llama anota acá el resultado (la base, el progreso). Si no
        // pudo, para el corte es un fallo más aunque la foto haya bajado.
        let noted = true;
        if (typeof deps.onResult === 'function') {
          try {
            noted = (await deps.onResult(result, index)) !== false;
          } catch (err) {
            noted = false;
          }
        }
        // Un link vencido es un fallo más, salvo que quien llama avise que
        // acá es lo esperable (cutOnExpired: false).
        const expectedExpiry = !result.ok && result.status === 'vencido' && deps.cutOnExpired === false;
        note(index, result.skipped ? 'salteado' : noted && (result.ok || expectedExpiry) ? 'bien' : 'fallo');
        return result;
      }, `${String(post && post.plataforma)}:${String(post && post.id)}`)
    )
  );
  return settled.map((entry) =>
    entry.status === 'fulfilled' ? entry.value : { ...failure('error', 'error-inesperado', { retry: true }), sourceUrl: null }
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
  MAX_INPUT_PIXELS,
  ALLOWED_FORMATS,
  MAX_CONSECUTIVE_FAILURES,
  BATCH_TIMEOUT_MS,
};
