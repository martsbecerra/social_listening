'use strict';

// Adónde va el login con una sesión abierta (public/js/loginDestino.js, el
// mismo archivo que carga index.html): solo a una página interna de la app,
// y con un # solo si es uno de los de la app. Ante cualquier valor raro, el
// inicio. Lo del lado del servidor (el ?volver= del gate) está en
// test/authGate.test.js.
//
// Base temporal (MONITORING_DB_PATH antes de los require): el gate carga la
// sesión y con ella src/db.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-volver-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { loginDestino, LOGIN_VOLVER, LOGIN_INICIO } = require('../public/js/loginDestino.js');
const { PAGINAS_VOLVER } = require('../src/auth/gate');

describe('loginDestino', () => {
  test('la misma lista que el gate (PAGINAS_VOLVER)', () => {
    assert.deepEqual([...LOGIN_VOLVER].sort(), [...PAGINAS_VOLVER].sort());
    assert.equal(LOGIN_INICIO, '/dashboard.html');
  });

  test('vuelve a una de las tres páginas, con su # si es de la app', () => {
    assert.equal(loginDestino('?volver=%2Finstagram.html', '#analisis-57'), '/instagram.html#analisis-57');
    assert.equal(loginDestino('?volver=/x.html', '#tab-analysis'), '/x.html#tab-analysis');
    assert.equal(loginDestino('?volver=%2Fdashboard.html', ''), '/dashboard.html');
    assert.equal(loginDestino('?volver=/instagram.html', '#publicacion-3712345678901234567'), '/instagram.html#publicacion-3712345678901234567');
    assert.equal(loginDestino('?volver=/instagram.html', '#fuentes-busquedas'), '/instagram.html#fuentes-busquedas');
  });

  test('otro sitio o algo que no es un camino interno: al inicio', () => {
    for (const volver of [
      'https://otro.com',
      'https://otro.com/x.html',
      'http://localhost:3000/x.html',
      '//otro.com',
      '//otro.com/instagram.html',
      '/\\otro.com',
      '\\\\otro.com',
      '/%5Cotro.com',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,hola',
      '/instagram.html/../../otro',
      '/INSTAGRAM.HTML',
      '/instagram.html?x=1',
      '/instagram.html#analisis-57',
      'instagram.html',
      '/api/auth/me',
      '/',
      '',
    ]) {
      const search = `?volver=${encodeURIComponent(volver)}`;
      assert.equal(loginDestino(search, ''), '/dashboard.html', volver);
      assert.equal(loginDestino(search, '#tab-analysis'), '/dashboard.html', `${volver} con #`);
    }
    // Sin codificar, tal como podría venir escrito en un link.
    assert.equal(loginDestino('?volver=//otro.com', ''), '/dashboard.html');
    assert.equal(loginDestino('?volver=/\\otro.com', ''), '/dashboard.html');
    assert.equal(loginDestino('?volver=javascript:alert(1)', ''), '/dashboard.html');
  });

  test('un # raro, aunque la página sea buena: al inicio', () => {
    for (const hash of [
      '#javascript:alert(1)',
      '#//otro.com',
      '#/\\otro.com',
      '#https://otro.com',
      '#<img src=x onerror=alert(1)>',
      '#analisis-57"',
      '#tab analysis',
      '#%2F%2Fotro.com',
      '#análisis',
      '#',
      `#${'a'.repeat(101)}`,
    ]) {
      assert.equal(loginDestino('?volver=/instagram.html', hash), '/dashboard.html', hash);
    }
  });

  test('sin volver, con dos, o con algo que no se puede leer: al inicio', () => {
    assert.equal(loginDestino('', ''), '/dashboard.html');
    assert.equal(loginDestino('', '#analisis-57'), '/dashboard.html');
    assert.equal(loginDestino(undefined, undefined), '/dashboard.html');
    assert.equal(loginDestino('?volver=/x.html&volver=//otro.com', ''), '/dashboard.html');
    assert.equal(loginDestino('?volver=/x.html&volver=/x.html', ''), '/dashboard.html');
    assert.equal(loginDestino('?volver[]=/x.html', ''), '/dashboard.html');
    assert.equal(loginDestino('?otra=/x.html', ''), '/dashboard.html');
  });

  test('el resultado siempre es un camino propio: empieza con "/" y no con "//"', () => {
    const raros = ['?volver=%2F%2Fotro.com', '?volver=%5C%5Cotro.com', '?volver=%0A%2Fx.html', '?volver=/x.html%00'];
    for (const search of raros) {
      const destino = loginDestino(search, '#x');
      assert.ok(destino.startsWith('/') && !destino.startsWith('//') && !destino.startsWith('/\\'), `${search} → ${destino}`);
      assert.equal(destino, '/dashboard.html', search);
    }
  });
});
