'use strict';

// imageForModel (src/postImages.js, rama clasificacion-foto-y-exclusiones):
// la portada para el clasificador, en memoria. Se baja del link con las
// mismas reglas que las copias (host de la plataforma, https, sin seguir
// redirecciones, el formato por los primeros bytes) y se achica a 768 px; con
// la copia guardada, se lee del disco sin pedir nada; no escribe nada; nunca
// tira (null). fetch inyectado; imágenes generadas con sharp; carpeta de
// fotos temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fotos-modelo-'));
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_MEDIA_DIR = MEDIA;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const postImages = require('../src/postImages');

const LINK = 'https://scontent-eze1-1.cdninstagram.com/v/t51/portada.jpg?oh=FIRMA';
const respuesta = (buffer, { status = 200, type = 'image/png' } = {}) =>
  new Response(buffer, { status, headers: { 'content-type': type } });

async function imagen(width, height, format = 'png') {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })[format]().toBuffer();
}

test('baja del link, achica a 768 px de lado largo, devuelve JPEG en base64 y no escribe nada', async () => {
  const grande = await imagen(1600, 1200);
  const pedidos = [];
  const r = await postImages.imageForModel(
    { plataforma: 'instagram', id: '111', url: LINK },
    { fetchFn: async (url, opts) => (pedidos.push({ url, opts }), respuesta(grande)) }
  );
  assert.equal(r.mediaType, 'image/jpeg');
  assert.equal(r.origen, 'link');
  const meta = await sharp(Buffer.from(r.data, 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(Math.max(meta.width, meta.height), postImages.MODEL_LONG_SIDE);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].opts.redirect, 'manual');
  assert.equal(fs.existsSync(path.join(MEDIA, 'instagram')), false, 'no guarda copias');
});

test('con la copia grande guardada, la lee del disco sin pedir nada', async () => {
  const dir = path.join(MEDIA, 'instagram');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '222_full.jpg'), await imagen(900, 900, 'jpeg'));
  let pedidos = 0;
  const r = await postImages.imageForModel({ plataforma: 'instagram', id: '222', url: LINK }, { fetchFn: async () => (pedidos++, respuesta(Buffer.alloc(0))) });
  assert.equal(r.origen, 'copia');
  assert.equal(pedidos, 0);
  const meta = await sharp(Buffer.from(r.data, 'base64')).metadata();
  assert.equal(meta.width, 768);
});

test('lo que no se acepta da null sin tirar: host ajeno, redirección, vencido, no es imagen, SVG, sin link', async () => {
  const avisos = [];
  const warn = console.warn;
  console.warn = (msg) => avisos.push(String(msg));
  try {
    let pedidos = 0;
    const contar = (res) => async () => (pedidos++, res);
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '3', url: 'https://evil.example.com/a.jpg' }, { fetchFn: contar(null) }), null);
    assert.equal(pedidos, 0, 'un host ajeno ni se pide');
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '4', url: LINK }, { fetchFn: contar(new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } })) }), null);
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '5', url: LINK }, { fetchFn: contar(respuesta(Buffer.from('x'), { status: 403 })) }), null);
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '6', url: LINK }, { fetchFn: contar(respuesta(Buffer.from('<html>'), { type: 'text/html' })) }), null);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '7', url: LINK }, { fetchFn: contar(respuesta(svg, { type: 'image/svg+xml' })) }), null);
    assert.equal(await postImages.imageForModel({ plataforma: 'instagram', id: '8', url: null }), null);
    assert.equal(await postImages.imageForModel({ plataforma: 'x', id: '9', url: LINK }), null, 'una plataforma sin fotos');
    assert.equal(await postImages.imageForModel(null), null);
    assert.ok(avisos.every((a) => !a.includes('FIRMA')), 'el link firmado no va al log');
    assert.ok(avisos.some((a) => a.includes('formato-no-permitido')));
  } finally {
    console.warn = warn;
  }
});
