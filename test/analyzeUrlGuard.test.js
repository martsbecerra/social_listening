'use strict';

// Separación por plataforma, cambio 2: el guard del análisis de publicación
// (checkAnalyzeUrl, src/platforms/urlPlatform.js). server.js lo corre en
// POST /api/analyze (con 'instagram') y POST /api/x/analyze (con 'x') ANTES
// de scrapeInstagram / fetchXThread: un link de otra red responde 400 con
// "Esta sección solo analiza publicaciones de <red>" y no gasta nada.
// Sin red, sin base: es una función pura.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { checkAnalyzeUrl, isPostUrlOf } = require('../src/platforms/urlPlatform');

describe('guard del análisis de publicación', () => {
  test('Instagram: acepta post/reel/tv de instagram.com y nada más', () => {
    for (const url of [
      'https://www.instagram.com/p/AAA123/',
      'https://instagram.com/reel/BBB_456',
      'https://www.instagram.com/reels/CCC/',
      'https://www.instagram.com/tv/DDD/?utm_source=ig',
    ]) {
      assert.deepEqual(checkAnalyzeUrl(url, 'instagram'), { ok: true }, url);
      assert.equal(isPostUrlOf(url, 'instagram'), true, url);
    }
  });

  test('Instagram: un link de X avisa "solo analiza publicaciones de Instagram" y sugiere la solapa de X', () => {
    for (const url of ['https://x.com/usuario/status/1234567890', 'https://twitter.com/usuario/status/1', 'https://mobile.twitter.com/usuario/status/1']) {
      const r = checkAnalyzeUrl(url, 'instagram');
      assert.equal(r.ok, false, url);
      assert.equal(r.motivo, 'otra_red');
      assert.equal(r.error, 'Esta sección solo analiza publicaciones de Instagram. Usá la solapa de X.');
    }
  });

  test('Instagram: un link de cualquier otro dominio avisa lo mismo, sin sugerir solapa', () => {
    const r = checkAnalyzeUrl('https://www.facebook.com/alguien/posts/123', 'instagram');
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'otra_red');
    assert.equal(r.error, 'Esta sección solo analiza publicaciones de Instagram.');
  });

  test('Instagram: perfil o story de instagram.com no es una publicación → mensaje de formato con ejemplo', () => {
    for (const url of ['https://www.instagram.com/jorgemacri/', 'https://www.instagram.com/stories/jorgemacri/123/', 'https://www.instagram.com/']) {
      const r = checkAnalyzeUrl(url, 'instagram');
      assert.equal(r.ok, false, url);
      assert.equal(r.motivo, 'no_es_posteo', url);
      assert.match(r.error, /Ingresá un link válido de una publicación de Instagram \(por ejemplo: https:\/\/www\.instagram\.com\/p\/XXXXXXXX\/\)/);
      assert.equal(isPostUrlOf(url, 'instagram'), false, url);
    }
  });

  test('Instagram: lo que no es una url → mensaje de formato', () => {
    for (const url of ['', '   ', 'hola', 'instagram.com/p/AAA/', null, undefined, 42]) {
      const r = checkAnalyzeUrl(url, 'instagram');
      assert.equal(r.ok, false, String(url));
      assert.equal(r.motivo, 'no_es_url', String(url));
      assert.match(r.error, /Ingresá un link válido/);
    }
  });

  test('X: simétrico — acepta status de x.com/twitter.com, rechaza Instagram sugiriendo su solapa', () => {
    assert.deepEqual(checkAnalyzeUrl('https://x.com/usuario/status/1234567890', 'x'), { ok: true });
    assert.deepEqual(checkAnalyzeUrl('https://twitter.com/usuario/status/1234567890?s=20', 'x'), { ok: true });
    assert.deepEqual(checkAnalyzeUrl('https://x.com/i/web/status/1234567890', 'x'), { ok: true });

    const ig = checkAnalyzeUrl('https://www.instagram.com/p/AAA123/', 'x');
    assert.equal(ig.ok, false);
    assert.equal(ig.motivo, 'otra_red');
    assert.equal(ig.error, 'Esta sección solo analiza publicaciones de X. Usá la solapa de Instagram.');

    const perfil = checkAnalyzeUrl('https://x.com/usuario', 'x');
    assert.equal(perfil.ok, false);
    assert.equal(perfil.motivo, 'no_es_posteo');
    assert.match(perfil.error, /publicación de X \(por ejemplo: https:\/\/x\.com\/usuario\/status\/1234567890\)/);

    const otro = checkAnalyzeUrl('https://www.tiktok.com/@alguien/video/1', 'x');
    assert.equal(otro.error, 'Esta sección solo analiza publicaciones de X.');
  });

  test('una plataforma desconocida es un error de programación, no un 400', () => {
    assert.throws(() => checkAnalyzeUrl('https://www.instagram.com/p/AAA/', 'tiktok'), /plataforma desconocida/);
  });
});
