'use strict';

// src/replicaGuard.js: lo que reemplaza al login en una réplica
// (REQ-REP-04, REQ-REP-05). Solo lectura: todo lo que no sea GET/HEAD
// responde 403 sin llegar a ningún handler. Solo local: un Host que no sea
// localhost con el puerto del server responde 421 (DNS rebinding). Sin
// login: las páginas y los GET pasan sin cookie.
//
// App de prueba en un puerto local: el guard real, express.static sobre una
// carpeta temporal y handlers que anotan cada llegada. No carga server.js ni
// abre ninguna base.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createReplicaGuard } = require('../src/replicaGuard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-guard-'));
const PUBLIC = path.join(tmp, 'public');

let server;
let port;
const llegadas = [];

function pedir(method, rawPath, { host, origin } = {}) {
  const conCuerpo = !['GET', 'HEAD'].includes(method);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        // host null: sin header Host (si no, Node pone uno solo).
        setHost: false,
        headers: {
          ...(host === null ? {} : { Host: host === undefined ? `localhost:${port}` : host }),
          ...(origin === undefined ? {} : { Origin: origin.replace('PORT', port) }),
          ...(conCuerpo ? { 'Content-Type': 'application/json', 'Content-Length': 2 } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, body }));
      }
    );
    req.on('error', reject);
    req.end(conCuerpo ? '{}' : undefined);
  });
}

before(async () => {
  for (const [file, content] of [
    ['index.html', 'LOGIN'],
    ['dashboard.html', 'DASHBOARD'],
    ['instagram.html', 'INSTAGRAM'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(PUBLIC, file)), { recursive: true });
    fs.writeFileSync(path.join(PUBLIC, file), content);
  }

  const app = express();
  app.use(express.json());
  // El puerto se conoce recién al escuchar: el guard lo lee en cada pedido.
  app.use(createReplicaGuard({ getPort: () => port }));
  app.use(express.static(PUBLIC));
  const anotar = (nombre) => (req, res) => {
    llegadas.push(`${req.method} ${nombre}`);
    res.json({ handler: nombre, email: req.auth && req.auth.email });
  };
  app.get('/api/monitoring/posts', anotar('posts'));
  app.get('/api/auth/me', anotar('me'));
  app.post('/api/monitoring/run-now', anotar('run-now'));
  app.post('/api/analyze', anotar('analyze'));
  app.post('/api/monitoring/posts/:id/ignore', anotar('ignorar'));
  app.patch('/api/monitoring/posts/:id', anotar('sentimiento'));
  app.patch('/api/reclamos/:id', anotar('reclamo'));
  app.delete('/api/monitoring/searches/:search', anotar('borrar-busqueda'));
  app.post('/api/auth/magic-link', anotar('magic-link'));
  app.post('/api/replica/refresh', anotar('buscar-datos'));
  app.post('/api/replica/token', anotar('token'));
  app.patch('/api/replica/token', anotar('token-patch'));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  llegadas.length = 0;
});

describe('solo lectura', { concurrency: false }, () => {
  const ESCRITURAS = [
    ['POST', '/api/monitoring/run-now?plataforma=instagram'],
    ['POST', '/API/Monitoring/Run-Now?plataforma=instagram'],
    ['POST', '/api/analyze'],
    ['POST', '/api/monitoring/posts/1/ignore?plataforma=instagram'],
    ['PATCH', '/api/monitoring/posts/1?plataforma=instagram'],
    ['PATCH', '/api/reclamos/1'],
    ['DELETE', '/api/monitoring/searches/macri?plataforma=instagram'],
    ['POST', '/api/auth/magic-link'],
    ['PUT', '/api/monitoring/posts/1'],
    ['POST', '/dashboard.html'],
  ];
  for (const [method, rawPath] of ESCRITURAS) {
    test(`${method} ${rawPath} → 403 sin llegar al handler`, async () => {
      const res = await pedir(method, rawPath);
      assert.equal(res.status, 403);
      assert.match(JSON.parse(res.body).error, /Esta copia es de solo lectura/);
      assert.deepEqual(llegadas, []);
    });
  }

  test('GET de /api pasa sin cookie, con la sesión fija de la copia', async () => {
    const res = await pedir('GET', '/api/monitoring/posts?plataforma=instagram');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { handler: 'posts', email: 'copia.local' });
  });

  test('una página de la app se sirve sin cookie', async () => {
    const res = await pedir('GET', '/instagram.html');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'INSTAGRAM');
  });

  for (const rawPath of ['/', '/index.html', '/login-verify.html']) {
    test(`${rawPath} redirige al dashboard: no hay login`, async () => {
      const res = await pedir('GET', rawPath);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/dashboard.html');
    });
  }
});

describe('acciones locales de la copia (buscar datos nuevos, token)', { concurrency: false }, () => {
  for (const [rawPath, origin, handler] of [
    ['/api/replica/refresh', 'http://localhost:PORT', 'buscar-datos'],
    ['/api/replica/token', 'http://127.0.0.1:PORT', 'token'],
  ]) {
    test(`POST ${rawPath} desde la página de la app (Origin ${origin}) pasa`, async () => {
      const res = await pedir('POST', rawPath, { origin });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).handler, handler);
    });
  }

  for (const origin of [undefined, 'http://evil.example', 'http://localhost:1', 'null', 'https://localhost:PORT']) {
    test(`POST /api/replica/token con Origin ${origin === undefined ? '(ninguno)' : origin} → 403`, async () => {
      const res = await pedir('POST', '/api/replica/token', { origin });
      assert.equal(res.status, 403);
      assert.deepEqual(llegadas, []);
    });
  }

  for (const [method, rawPath] of [
    ['PATCH', '/api/replica/token'],
    ['POST', '/api/replica/token/otro'],
    ['POST', '/api/monitoring/run-now?plataforma=instagram'],
  ]) {
    test(`${method} ${rawPath} sigue en 403 aunque venga de la app`, async () => {
      const res = await pedir(method, rawPath, { origin: 'http://localhost:PORT' });
      assert.equal(res.status, 403);
      assert.deepEqual(llegadas, []);
    });
  }
});

describe('solo local', { concurrency: false }, () => {
  for (const host of ['evil.example:PORT', 'evil.example', '192.168.0.10:PORT', 'localhost:1', 'localhost']) {
    test(`Host "${host}" → 421`, async () => {
      const res = await pedir('GET', '/api/monitoring/posts?plataforma=instagram', { host: host.replace('PORT', port) });
      assert.equal(res.status, 421);
      assert.deepEqual(llegadas, []);
    });
  }

  test('sin Host: lo corta el server HTTP de Node con 400, antes del guard', async () => {
    const res = await pedir('GET', '/api/monitoring/posts?plataforma=instagram', { host: null });
    assert.equal(res.status, 400);
    assert.deepEqual(llegadas, []);
  });

  for (const host of ['localhost:PORT', '127.0.0.1:PORT', '[::1]:PORT', 'LOCALHOST:PORT']) {
    test(`Host "${host}" pasa`, async () => {
      const res = await pedir('GET', '/api/auth/me', { host: host.replace('PORT', port) });
      assert.equal(res.status, 200);
    });
  }
});
