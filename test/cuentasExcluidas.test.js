'use strict';

// Cuentas excluidas, base y API (rama clasificacion-foto-y-exclusiones):
//
// - La semilla: @populares_sevilla, una sola vez (si alguien la saca, no
//   vuelve) y lo guardado de esa cuenta queda ignorado.
// - Agregar una cuenta pasa a ignorado lo ya guardado de ella (sin importar
//   mayúsculas ni la @); repetida tira; sacarla no des-ignora.
// - Rutas: un lector ve la lista y no puede agregar ni sacar (403 del gate);
//   un operador agrega (201), repetida 409, datos inválidos 400, sacar 200 o
//   404; el correo de quien la cargó nunca sale en una respuesta.
//
// Base temporal; app de prueba con el gate real. No carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-excluidas-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.APP_BASE_URL = 'http://localhost';
process.env.ALLOWED_EMAILS = 'lector@test.local,operador@test.local;operador';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const db = require('../src/db');
const exclusionesRoutes = require('../src/exclusionesRoutes');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');

const raw = new DatabaseSync(DB_PATH);
const ignorado = (id) => raw.prepare('SELECT ignored FROM detected_posts WHERE id = ?').get(id).ignored;

function guardar(id, account, plataforma = 'instagram') {
  const url = plataforma === 'x' ? `https://x.com/${account}/status/${id}` : `https://www.instagram.com/p/${id}/`;
  assert.equal(
    db.saveDetectedPost({ id, plataforma, account, url, caption: 't', matchedReason: 'Búsqueda: x', likes: 1, comments: 1, postedAt: new Date().toISOString(), title: 'T', sentiment: 'neutral', postType: 'imagen' }),
    true
  );
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

describe('base', { concurrency: false }, () => {
  test('la semilla: @populares_sevilla con su motivo, una sola vez; lo guardado de esa cuenta queda ignorado', () => {
    const lista = db.listCuentasExcluidas('instagram');
    assert.deepEqual(lista.map((c) => c.cuenta), ['populares_sevilla']);
    assert.match(lista[0].motivo, /Partido Popular de Sevilla/);
    assert.equal(Object.keys(lista[0]).includes('creado_por'), false);
    assert.equal(db.sembrarCuentasExcluidas(), 0, 'ya se sembró al cargar la base');

    // Si alguien la saca, no vuelve.
    assert.equal(db.removeCuentaExcluida('instagram', '@Populares_Sevilla'), true);
    assert.equal(db.sembrarCuentasExcluidas(), 0);
    assert.deepEqual(db.listCuentasExcluidas('instagram'), []);

    // Una base sin la marca (la primera vez): siembra e ignora lo guardado.
    guardar('SEVILLA1', 'Populares_Sevilla');
    raw.prepare("DELETE FROM refresh_state WHERE key = 'cuentas_excluidas_semilla'").run();
    assert.equal(db.sembrarCuentasExcluidas(), 1);
    assert.equal(ignorado('SEVILLA1'), 1);
    assert.deepEqual(db.listCuentasExcluidas('instagram').map((c) => c.cuenta), ['populares_sevilla']);
  });

  test('agregar ignora lo ya guardado de la cuenta (sin mayúsculas ni @); repetida tira; sacar no des-ignora', () => {
    guardar('C1', 'CuentaRara');
    guardar('C2', 'cuentarara');
    guardar('C3', 'otra');
    guardar('C4', 'cuentarara', 'x');
    const r = db.addCuentaExcluida({ plataforma: 'instagram', cuenta: '@CuentaRara', motivo: 'spam', creadoPor: 'operador@test.local' });
    assert.equal(r.cuenta, 'cuentarara');
    assert.equal(r.ignorados, 2);
    assert.equal(ignorado('C1'), 1);
    assert.equal(ignorado('C2'), 1);
    assert.equal(ignorado('C3'), 0);
    assert.equal(ignorado('C4'), 0, 'otra plataforma no se toca');
    assert.deepEqual([...db.mapCuentasExcluidas('instagram')], [['cuentarara', 'spam'], ['populares_sevilla', db.listCuentasExcluidas('instagram')[1].motivo]]);
    assert.throws(
      () => db.addCuentaExcluida({ plataforma: 'instagram', cuenta: 'cuentarara', motivo: 'otra vez' }),
      (err) => err.code === 'CUENTA_EXCLUIDA_REPETIDA'
    );
    assert.equal(db.removeCuentaExcluida('instagram', 'cuentarara'), true);
    assert.equal(ignorado('C1'), 1, 'sacarla no des-ignora');
    assert.equal(db.removeCuentaExcluida('instagram', 'cuentarara'), false);
    assert.throws(() => db.listCuentasExcluidas(), /plataforma/);
  });
});

describe('rutas', { concurrency: false }, () => {
  let server;
  let port;
  let LECTOR;
  let OPERADOR;
  const logs = [];
  const consoleLog = console.log;

  function pedir(method, rawPath, { cookie, body } = {}) {
    const datos = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: rawPath,
          headers: { ...(cookie ? { Cookie: cookie } : {}), ...(datos ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(datos) } : {}) },
        },
        (res) => {
          let txt = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (txt += c));
          res.on('end', () => resolve({ status: res.statusCode, json: txt ? JSON.parse(txt) : null, txt }));
        }
      );
      req.on('error', reject);
      if (datos) req.write(datos);
      req.end();
    });
  }

  before(async () => {
    console.log = (...a) => logs.push(a.join(' '));
    const app = express();
    app.use(express.json());
    app.use(createAuthGate());
    exclusionesRoutes.register(app);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    LECTOR = sessionCookie('lector@test.local');
    OPERADOR = sessionCookie('operador@test.local');
  });

  after(async () => {
    console.log = consoleLog;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test('un lector ve la lista y no puede agregar ni sacar', async () => {
    const r = await pedir('GET', '/api/monitoring/excluded-accounts?plataforma=instagram', { cookie: LECTOR });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.cuentas.map((c) => c.cuenta), ['populares_sevilla']);
    const post = await pedir('POST', '/api/monitoring/excluded-accounts', { cookie: LECTOR, body: { plataforma: 'instagram', cuenta: 'x', motivo: 'y' } });
    assert.equal(post.status, 403);
    assert.equal((await pedir('DELETE', '/api/monitoring/excluded-accounts/populares_sevilla?plataforma=instagram', { cookie: LECTOR })).status, 403);
  });

  test('un operador agrega (201), repetida 409, datos inválidos 400, saca (200) o 404; el correo nunca sale', async () => {
    guardar('R1', 'nueva.cuenta');
    const alta = await pedir('POST', '/api/monitoring/excluded-accounts', { cookie: OPERADOR, body: { plataforma: 'instagram', cuenta: '@Nueva.Cuenta', motivo: '  política de otro país  ' } });
    assert.equal(alta.status, 201);
    assert.deepEqual(Object.keys(alta.json).sort(), ['createdAt', 'cuenta', 'ignorados', 'motivo']);
    assert.equal(alta.json.cuenta, 'nueva.cuenta');
    assert.equal(alta.json.motivo, 'política de otro país');
    assert.equal(alta.json.ignorados, 1);
    assert.equal(ignorado('R1'), 1);
    assert.ok(logs.some((l) => l.includes('[exclusiones] @nueva.cuenta excluida (instagram) por operador@test.local')));

    const repetida = await pedir('POST', '/api/monitoring/excluded-accounts', { cookie: OPERADOR, body: { plataforma: 'instagram', cuenta: 'nueva.cuenta', motivo: 'otra vez' } });
    assert.equal(repetida.status, 409);

    for (const body of [
      { plataforma: 'instagram', cuenta: '', motivo: 'm' },
      { plataforma: 'instagram', cuenta: 'con espacio', motivo: 'm' },
      { plataforma: 'instagram', cuenta: 'bien', motivo: '   ' },
      { plataforma: 'instagram', cuenta: 'bien', motivo: 'x'.repeat(201) },
    ]) {
      const r = await pedir('POST', '/api/monitoring/excluded-accounts', { cookie: OPERADOR, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error);
    }

    const lista = await pedir('GET', '/api/monitoring/excluded-accounts?plataforma=instagram', { cookie: OPERADOR });
    assert.ok(!lista.txt.includes('operador@test.local'), 'el correo no sale');
    assert.deepEqual(lista.json.cuentas.map((c) => c.cuenta), ['nueva.cuenta', 'populares_sevilla']);

    assert.equal((await pedir('DELETE', '/api/monitoring/excluded-accounts/nueva.cuenta?plataforma=instagram', { cookie: OPERADOR })).status, 200);
    assert.equal((await pedir('DELETE', '/api/monitoring/excluded-accounts/nueva.cuenta?plataforma=instagram', { cookie: OPERADOR })).status, 404);
    assert.equal(ignorado('R1'), 1, 'sacarla no des-ignora');
  });
});
