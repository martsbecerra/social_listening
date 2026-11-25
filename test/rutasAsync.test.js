'use strict';

// rutaAsync (src/asyncRoute.js, rama rate-limit-y-salud): una ruta async que
// rechaza (o tira, o rechaza sin error) responde 500 { error: 'Error
// interno.' } por errorHandler, no dispara unhandledRejection y el proceso
// sigue atendiendo. Y en server.js y src/ ninguna ruta async quedó sin el
// envoltorio (se lee del código: una ruta nueva entra sola al test).

const fs = require('fs');
const path = require('path');
const http = require('http');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { rutaAsync } = require('../src/asyncRoute');
const { errorHandler } = require('../src/httpSecurity');

const ROOT = path.join(__dirname, '..');
let server;
let port;
const sinManejar = [];
const alRechazo = (reason) => sinManejar.push(reason);
const consoleError = console.error;
const errores = [];

function pedir(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  process.on('unhandledRejection', alRechazo);
  console.error = (...args) => errores.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  const app = express();
  app.get(
    '/rechaza',
    rutaAsync(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('falla adentro de la ruta');
    })
  );
  app.get(
    '/tira',
    rutaAsync(() => {
      throw new Error('falla sincrónica');
    })
  );
  // eslint-disable-next-line prefer-promise-reject-errors
  app.get('/rechaza-sin-error', rutaAsync(() => Promise.reject()));
  app.get('/rechaza-sin-error', (req, res) => res.json({ siguio: 'a la ruta siguiente' }));
  app.get(
    '/bien',
    rutaAsync(async (req, res) => {
      await new Promise((r) => setTimeout(r, 1));
      res.json({ ok: true });
    })
  );
  app.use(errorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  process.off('unhandledRejection', alRechazo);
  console.error = consoleError;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('una ruta async que rechaza responde 500 "Error interno." y el proceso sigue', async () => {
  for (const ruta of ['/rechaza', '/tira', '/rechaza-sin-error']) {
    const r = await pedir(ruta);
    assert.equal(r.status, 500, ruta);
    assert.deepEqual(r.json, { error: 'Error interno.' }, ruta);
  }
  // Sigue atendiendo.
  assert.deepEqual((await pedir('/bien')).json, { ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sinManejar, [], 'ningún unhandledRejection');
  // El error completo, al log (no al cliente).
  assert.ok(errores.some((l) => l.includes('falla adentro de la ruta')));
});

test('en server.js y src/ toda ruta async usa rutaAsync', () => {
  const archivos = [path.join(ROOT, 'server.js')];
  const recorrer = (dir) => {
    for (const nombre of fs.readdirSync(dir)) {
      const full = path.join(dir, nombre);
      if (fs.statSync(full).isDirectory()) recorrer(full);
      else if (nombre.endsWith('.js')) archivos.push(full);
    }
  };
  recorrer(path.join(ROOT, 'src'));
  const sueltas = [];
  let envueltas = 0;
  for (const file of archivos) {
    // Sin los comentarios de línea (el de src/asyncRoute.js muestra el uso).
    const code = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // Un handler de ruta async: flecha o function con (req, res…).
    for (const m of code.matchAll(/async\s*(?:function\s*\w*\s*)?\(\s*req\s*,\s*res\b/g)) {
      const antes = code.slice(Math.max(0, m.index - 'rutaAsync('.length), m.index);
      if (antes === 'rutaAsync(') envueltas += 1;
      else {
        const linea = code.slice(0, m.index).split('\n').length;
        sueltas.push(`${path.relative(ROOT, file)}:${linea}`);
      }
    }
    // Ni un handler async con nombre pasado directo a app.<método>(…).
    for (const m of code.matchAll(/async function (\w+)\s*\(\s*req\s*,\s*res\b/g)) {
      if (new RegExp(`app\\.(?:get|post|put|patch|delete|use)\\([^)]*\\b${m[1]}\\b`).test(code)) {
        sueltas.push(`${path.relative(ROOT, file)}: ${m[1]} pasado sin rutaAsync`);
      }
    }
  }
  assert.deepEqual(sueltas, []);
  assert.equal(envueltas, 9, 'las 9 de hoy: 5 en server.js, 1 en analysisRoutes, 2 en reclamosRoutes y la del magic link');
});
