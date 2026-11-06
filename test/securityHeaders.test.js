'use strict';

// Seguridad HTTP (src/httpSecurity.js): los headers de helmet con la CSP de
// la app, también en los 401 y las redirecciones del gate; el manejador de
// errores, que al cliente le da solo un mensaje genérico y nunca un stack;
// los handlers del proceso; y que los HTML de public/ no carguen nada de un
// CDN ni tengan código o estilos en línea (la CSP los bloquearía).
//
// App de prueba en un puerto local, con el mismo orden que server.js: los
// headers, el JSON, el gate, los estáticos (una carpeta temporal), las rutas
// y el manejador de errores. No carga server.js ni abre ninguna base.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.SESSION_SECRET = 'secreto-de-test';
process.env.APP_BASE_URL = 'http://localhost';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAuthGate } = require('../src/auth/gate');
const {
  securityHeaders,
  errorHandler,
  installProcessHandlers,
  MAP_TILE_HOSTS,
} = require('../src/httpSecurity');

const REAL_PUBLIC = path.join(__dirname, '..', 'public');

function cspMap(header) {
  const map = new Map();
  for (const part of String(header || '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

async function startApp({ baseUrl }) {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-headers-'));
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!DOCTYPE html><p>login</p>');
  fs.writeFileSync(path.join(publicDir, 'dashboard.html'), '<!DOCTYPE html><p>inicio</p>');

  const app = express();
  app.use(securityHeaders({ baseUrl }));
  app.use(express.json());
  app.use(createAuthGate());
  app.use(express.static(publicDir));
  // Fuera de /api/ y sin .html: el gate las deja pasar sin sesión.
  app.get('/prueba/ok', (req, res) => res.json({ ok: true }));
  app.get('/prueba/tira', () => {
    throw new Error('detalle interno que no tiene que salir');
  });
  app.get('/prueba/next-502', (req, res, next) => {
    next(Object.assign(new Error('falló el servicio de afuera'), { status: 502 }));
  });
  app.get('/prueba/status-raro', (req, res, next) => {
    next(Object.assign(new Error('status que no es de error'), { status: 200 }));
  });
  app.post('/prueba/eco', (req, res) => res.json(req.body));
  app.use(errorHandler);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stopApp({ server }) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// Junta lo que se loguea mientras corre fn (y no lo muestra).
async function capturandoLogs(fn) {
  const logs = [];
  const { error, warn } = console;
  console.error = (...args) => logs.push(['error', ...args]);
  console.warn = (...args) => logs.push(['warn', ...args]);
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

describe('headers de seguridad (http)', { concurrency: false }, () => {
  let app;
  before(async () => {
    app = await startApp({ baseUrl: 'http://localhost:3000' });
  });
  after(() => stopApp(app));

  test('CSP explícita: todo de self, salvo Google Fonts y los mosaicos del mapa', async () => {
    const res = await fetch(`${app.base}/index.html`);
    assert.equal(res.status, 200);
    const csp = cspMap(res.headers.get('content-security-policy'));

    assert.deepEqual(csp.get('default-src'), ["'self'"]);
    assert.deepEqual(csp.get('script-src'), ["'self'"]);
    assert.deepEqual(csp.get('script-src-attr'), ["'none'"]);
    assert.deepEqual(csp.get('style-src'), ["'self'", 'https://fonts.googleapis.com']);
    assert.deepEqual(csp.get('font-src'), ["'self'", 'https://fonts.gstatic.com']);
    assert.deepEqual(csp.get('img-src'), ["'self'", 'data:', ...MAP_TILE_HOSTS]);
    assert.deepEqual(csp.get('connect-src'), ["'self'"]);
    assert.deepEqual(csp.get('object-src'), ["'none'"]);
    assert.deepEqual(csp.get('base-uri'), ["'self'"]);
    assert.deepEqual(csp.get('form-action'), ["'self'"]);
    assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
    // Las fotos se sirven desde la app: img-src no abre todo https:.
    assert.ok(!csp.get('img-src').includes('https:'));
    const todo = [...csp.values()].flat();
    assert.ok(!todo.includes("'unsafe-inline'"));
    assert.ok(!todo.includes("'unsafe-eval'"));
    // En http no se suben los pedidos a https.
    assert.ok(!csp.has('upgrade-insecure-requests'));
  });

  test('los demás headers: sin iframes, nosniff, referrer recortado, sin HSTS en http', async () => {
    const res = await fetch(`${app.base}/prueba/ok`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('strict-transport-security'), null);
  });

  test('el 401 y la redirección del gate también llevan los headers', async () => {
    const api = await fetch(`${app.base}/api/monitoring/posts?plataforma=instagram`);
    assert.equal(api.status, 401);
    assert.ok(cspMap(api.headers.get('content-security-policy')).has('frame-ancestors'));
    assert.equal(api.headers.get('x-frame-options'), 'DENY');

    const page = await fetch(`${app.base}/dashboard.html`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.ok(cspMap(page.headers.get('content-security-policy')).has('frame-ancestors'));
  });
});

describe('headers de seguridad (https)', { concurrency: false }, () => {
  let app;
  before(async () => {
    app = await startApp({ baseUrl: 'https://escucha.ejemplo.test' });
  });
  after(() => stopApp(app));

  test('con APP_BASE_URL https: HSTS de 180 días sin subdominios y upgrade-insecure-requests', async () => {
    const res = await fetch(`${app.base}/prueba/ok`);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000');
    const csp = cspMap(res.headers.get('content-security-policy'));
    assert.ok(csp.has('upgrade-insecure-requests'));
    assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
  });
});

describe('manejador de errores', { concurrency: false }, () => {
  let app;
  before(async () => {
    app = await startApp({ baseUrl: 'http://localhost:3000' });
  });
  after(() => stopApp(app));

  test('un handler que tira: 500 con {error:"Error interno."}, sin stack, y el error completo al log', async () => {
    const { result, logs } = await capturandoLogs(async () => {
      const res = await fetch(`${app.base}/prueba/tira`);
      return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
    });
    assert.equal(result.status, 500);
    assert.match(result.type, /application\/json/);
    assert.deepEqual(JSON.parse(result.text), { error: 'Error interno.' });
    assert.ok(!result.text.includes('detalle interno'));
    assert.ok(!result.text.includes('at '));
    assert.ok(!result.text.includes('httpSecurity'));

    assert.equal(logs.length, 1);
    const [nivel, linea, err] = logs[0];
    assert.equal(nivel, 'error');
    assert.match(linea, /GET \/prueba\/tira/);
    assert.equal(err.message, 'detalle interno que no tiene que salir');
    assert.ok(err.stack);
  });

  test('un 5xx propio conserva su status con el mismo mensaje genérico', async () => {
    const { result } = await capturandoLogs(async () => {
      const res = await fetch(`${app.base}/prueba/next-502`);
      return { status: res.status, body: await res.json() };
    });
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { error: 'Error interno.' });
  });

  test('un status que no es de error vale como 500', async () => {
    const { result } = await capturandoLogs(async () => {
      const res = await fetch(`${app.base}/prueba/status-raro`);
      return { status: res.status, body: await res.json() };
    });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'Error interno.' });
  });

  test('JSON mal formado: 400 "Pedido inválido.", y el cuerpo no va al log', async () => {
    const { result, logs } = await capturandoLogs(async () => {
      const res = await fetch(`${app.base}/prueba/eco`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"token": "SECRETO-DEL-CUERPO"',
      });
      return { status: res.status, text: await res.text() };
    });
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.text), { error: 'Pedido inválido.' });
    assert.ok(!result.text.includes('SECRETO'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.ok(!JSON.stringify(logs).includes('SECRETO'));
    assert.match(logs[0][1], /400 en POST \/prueba\/eco: entity\.parse\.failed/);
  });
});

describe('handlers del proceso', () => {
  for (const evento of ['unhandledRejection', 'uncaughtException']) {
    test(`${evento}: se loguea y el proceso termina con 1`, () => {
      const proc = new EventEmitter();
      const salidas = [];
      const logs = [];
      installProcessHandlers({ proc, exit: (code) => salidas.push(code), log: (...args) => logs.push(args) });
      const err = new Error(`falla de prueba (${evento})`);
      proc.emit(evento, err);
      assert.deepEqual(salidas, [1]);
      assert.equal(logs.length, 1);
      assert.equal(logs[0][1], err);
    });
  }
});

describe('los HTML de public/ cumplen la CSP', () => {
  const paginas = fs.readdirSync(REAL_PUBLIC).filter((f) => f.endsWith('.html'));

  test('están las cinco páginas', () => {
    assert.deepEqual(paginas.sort(), ['dashboard.html', 'index.html', 'instagram.html', 'login-verify.html', 'x.html']);
  });

  for (const pagina of paginas) {
    test(`${pagina}: sin CDN, sin scripts, estilos ni eventos en línea`, () => {
      const html = fs.readFileSync(path.join(REAL_PUBLIC, pagina), 'utf8');
      // Todo <script> trae src y es de la app.
      for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = /\bsrc="([^"]+)"/i.exec(tag);
        assert.ok(src, `${pagina}: <script> sin src: ${tag}`);
        assert.ok(!/^(https?:)?\/\//i.test(src[1]), `${pagina}: script de afuera: ${src[1]}`);
      }
      // Hojas de estilo: de la app o de Google Fonts.
      for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
        if (!/\brel="stylesheet"/i.test(tag)) continue;
        const href = /\bhref="([^"]+)"/i.exec(tag)[1];
        const deAfuera = /^(https?:)?\/\//i.test(href);
        assert.ok(!deAfuera || href.startsWith('https://fonts.googleapis.com/'), `${pagina}: estilo de afuera: ${href}`);
      }
      assert.ok(!/<style\b/i.test(html), `${pagina}: bloque <style>`);
      assert.ok(!/\sstyle\s*=/i.test(html), `${pagina}: atributo style=`);
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `${pagina}: atributo on…=`);
      assert.ok(!/javascript:/i.test(html), `${pagina}: link javascript:`);
    });
  }

  test('lo que cargan de public/vendor existe', () => {
    for (const pagina of ['instagram.html', 'x.html']) {
      const html = fs.readFileSync(path.join(REAL_PUBLIC, pagina), 'utf8');
      const refs = [...html.matchAll(/\b(?:src|href)="(vendor\/[^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(
        refs.sort(),
        ['vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js', 'vendor/tabulator/tabulator.min.css', 'vendor/tabulator/tabulator.min.js'],
        pagina
      );
      for (const ref of refs) assert.ok(fs.existsSync(path.join(REAL_PUBLIC, ref)), `${pagina}: falta ${ref}`);
    }
    for (const img of ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
      assert.ok(fs.existsSync(path.join(REAL_PUBLIC, 'vendor', 'leaflet', 'images', img)), img);
    }
  });
});
