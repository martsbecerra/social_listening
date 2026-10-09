'use strict';

// Fotos, paso 4 (openspec/changes/monitoreo-fotos, REQ-FOTO-05): el posteo
// normalizado de los dos proveedores de Instagram lleva `imageUrl`, el link
// de la imagen que después baja src/postImages.js. La foto si es una
// imagen, la portada si es un reel, la primera pieza si es un carrusel;
// nunca el video; null si la respuesta no trae imagen. Con las fixtures
// reales de los dos actores (los links están reemplazados por cdn.invalid)
// y casos armados a mano. Sin red; base y config temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-adapters-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const apify = require('../src/platforms/instagramApify');
const apidojo = require('../src/platforms/instagramApidojo');
const instagram = require('../src/platforms/instagram');

const fixture = (actor, name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', actor, `${name}.json`), 'utf8'));
const CDN = 'https://scontent-eze1-1.cdninstagram.com/v/t51';

describe('imageUrl en el proveedor apify/instagram-scraper (detalle por URL)', () => {
  const normalizar = (raw) => apify.normalizePost(raw, { account: null, sourceType: 'search' });
  const base = { id: '1', shortCode: 'AAA', url: 'https://www.instagram.com/p/AAA/', caption: 'texto' };

  test('fixture real del detalle (un reel): displayUrl, que es la portada, nunca el video', () => {
    const [raw] = fixture('apify', 'post-detail');
    assert.equal(raw.type, 'Video');
    const post = normalizar(raw);
    assert.equal(post.imageUrl, raw.displayUrl);
    assert.notEqual(post.imageUrl, raw.videoUrl);
    // El resto del posteo sigue como antes.
    assert.equal(post.postType, 'reel');
    assert.equal(post.id, String(raw.id));
  });

  test('fixture real con dos URLs: cada posteo trae la suya', () => {
    const posts = fixture('apify', 'post-details-2urls').map(normalizar);
    assert.equal(posts.length, 2);
    for (const post of posts) assert.equal(post.imageUrl, 'https://cdn.invalid/displayUrl');
  });

  test('imagen, carrusel y los casos sin imagen', () => {
    // Imagen: displayUrl.
    assert.equal(normalizar({ ...base, type: 'Image', displayUrl: `${CDN}/foto.jpg` }).imageUrl, `${CDN}/foto.jpg`);
    // Carrusel: displayUrl (la primera imagen), aunque vengan las piezas.
    assert.equal(
      normalizar({ ...base, type: 'Sidecar', displayUrl: `${CDN}/primera.jpg`, images: [`${CDN}/otra1.jpg`, `${CDN}/otra2.jpg`] }).imageUrl,
      `${CDN}/primera.jpg`
    );
    // Carrusel sin displayUrl: la primera de las piezas.
    assert.equal(normalizar({ ...base, type: 'Sidecar', images: [`${CDN}/pieza1.jpg`, `${CDN}/pieza2.jpg`] }).imageUrl, `${CDN}/pieza1.jpg`);
    // Con espacios alrededor: sin ellos.
    assert.equal(normalizar({ ...base, displayUrl: `  ${CDN}/foto.jpg ` }).imageUrl, `${CDN}/foto.jpg`);
    // Sin imagen: null. El video no cuenta.
    for (const sinImagen of [
      {},
      { displayUrl: '' },
      { displayUrl: null, images: [] },
      { displayUrl: 12345 },
      { displayUrl: '/ruta/relativa.jpg' },
      { videoUrl: `${CDN}/video.mp4` },
      { images: [null, ''] },
    ]) {
      assert.equal(normalizar({ ...base, ...sinImagen }).imageUrl, null, JSON.stringify(sinImagen));
    }
  });
});

describe('imageUrl en el proveedor apidojo/instagram-scraper-api', () => {
  test('fixtures reales: todos los posteos de perfil, hashtag, búsqueda y posteo suelto traen image.url', () => {
    for (const [name, context] of [
      ['profile', { account: 'clavescom', sourceType: 'account' }],
      ['hashtag', { account: null, sourceType: 'hashtag' }],
      ['search', { account: null, sourceType: 'search', sourceQuery: 'jorge macri' }],
      ['post', { account: null, sourceType: 'search' }],
    ]) {
      const raws = [].concat(fixture('apidojo', name));
      const posts = apidojo.normalizeItems(raws, context);
      assert.equal(posts.length, raws.length, name);
      // (Que nunca sea el video se prueba más abajo con casos armados: en
      // las fixtures todos los links son el mismo marcador.)
      for (const [i, post] of posts.entries()) {
        assert.equal(post.imageUrl, raws[i].image.url, `${name}[${i}]`);
      }
    }
  });

  test('carruseles reales: la imagen del posteo, no una pieza cualquiera', () => {
    const raws = fixture('apidojo', 'hashtag').filter((raw) => raw.isCarousel);
    assert.ok(raws.length >= 2);
    for (const raw of raws) {
      const post = apidojo.normalizePost(raw, { account: null, sourceType: 'hashtag' });
      assert.equal(post.postType, 'carrusel');
      assert.equal(post.imageUrl, raw.image.url);
    }
  });

  test('respaldo y casos sin imagen', () => {
    const base = { id: '9', code: 'ZZZ', caption: 'texto', owner: { username: 'alguien' }, createdAt: '2026-09-17T22:54:00.000Z' };
    const normalizar = (extra) => apidojo.normalizePost({ ...base, ...extra }, { account: null, sourceType: 'search' });
    // Carrusel sin image: la primera pieza, si es una imagen (type 1).
    assert.equal(normalizar({ isCarousel: true, carouselMedia: [{ type: 1, url: `${CDN}/pieza1.jpg` }, { type: 1, url: `${CDN}/pieza2.jpg` }] }).imageUrl, `${CDN}/pieza1.jpg`);
    // Si la primera pieza es un video (type 2), no se usa.
    assert.equal(normalizar({ isCarousel: true, carouselMedia: [{ type: 2, url: `${CDN}/video.mp4` }, { type: 1, url: `${CDN}/pieza2.jpg` }] }).imageUrl, null);
    // Sin imagen: null. El video no cuenta.
    for (const sinImagen of [{}, { image: null }, { image: {} }, { image: { url: '' } }, { image: 'no-es-un-objeto' }, { isVideo: true, video: { url: `${CDN}/video.mp4` } }, { carouselMedia: [] }]) {
      assert.equal(normalizar(sinImagen).imageUrl, null, JSON.stringify(sinImagen));
    }
  });

  test('la fachada de Instagram lo entrega igual', () => {
    const [raw] = fixture('apidojo', 'search');
    const context = { account: null, sourceType: 'search', sourceQuery: 'jorge macri' };
    assert.equal(instagram.normalizePost(raw, context).imageUrl, raw.image.url);
  });
});
