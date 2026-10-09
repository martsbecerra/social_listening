'use strict';

// Control de login (src/auth/gate.js): sin sesión no se llega a ningún handler
// de /api/ ni a ninguna página de la app, se escriba el camino como se
// escriba. Las rutas de Express no distinguen mayúsculas y el disco de
// Windows tampoco, así que el gate no puede decidir comparando el camino tal
// como llegó: /API/monitoring/run-now pasaba sin sesión hasta el handler.
//
// App de prueba en un puerto local de esta máquina: el gate real,
// express.static sobre una carpeta temporal y handlers de mentira que anotan
// cada llegada. No carga server.js ni abre ninguna base. Los pedidos van con
// http.request para que el camino salga escrito tal cual (fetch lo normaliza).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.SESSION_SECRET = 'secreto-de-test';
process.env.APP_BASE_URL = 'http://localhost'; // cookie sin "secure"

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAuthGate, canonicalPath } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');

const PAGINA = 'PAGINA-PROTEGIDA';
const LOGIN = 'PAGINA-DE-LOGIN';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gate-'));
const PUBLIC = path.join(tmp, 'public');

// Cookie de sesión como la que deja el login.
function sessionCookie(email = 'prueba@test.local') {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

let server;
let port;
let COOKIE;
const llegadas = []; // handlers de /api/ a los que llegó un pedido

function pedir(method, rawPath, { cookie = null } = {}) {
  const conCuerpo = method === 'POST' || method === 'PATCH';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
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
    ['index.html', LOGIN],
    ['login-verify.html', LOGIN],
    ['dashboard.html', PAGINA],
    ['instagram.html', PAGINA],
    ['favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['css/styles.css', 'body{}'],
    ['js/login.js', '// login'],
    ['js/monitoring.js', '// monitoreo'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(PUBLIC, file)), { recursive: true });
    fs.writeFileSync(path.join(PUBLIC, file), content);
  }

  // Mismo orden que server.js: el gate antes de los estáticos y de las rutas.
  const app = express();
  app.use(express.json());
  app.use(createAuthGate());
  app.use(express.static(PUBLIC));
  const anotar = (nombre) => (req, res) => {
    llegadas.push(`${req.method} ${nombre}`);
    res.json({ handler: nombre });
  };
  app.post('/api/auth/magic-link', anotar('magic-link'));
  app.get('/api/auth/me', anotar('me'));
  app.get('/api/monitoring/posts', anotar('posts'));
  app.post('/api/monitoring/run-now', anotar('run-now'));
  app.post('/api/analyze', anotar('analyze'));
  app.patch('/api/monitoring/posts/:id', anotar('sentimiento'));
  app.delete('/api/monitoring/accounts/:account', anotar('borrar-cuenta'));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  COOKIE = sessionCookie();
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  llegadas.length = 0;
});

describe('gate de login: /api/ sin sesión', { concurrency: false }, () => {
  // El camino, una vez decodificado y en minúsculas, es de /api/: 401.
  const API = [
    ['GET', '/api/monitoring/posts'],
    // Mayúsculas: Express manda estas formas al mismo handler.
    ['GET', '/API/monitoring/posts'],
    ['GET', '/Api/Monitoring/Posts'],
    ['GET', '/aPi/monitoring/posts?plataforma=instagram'],
    ['HEAD', '/API/monitoring/posts'],
    ['POST', '/API/monitoring/run-now'],
    ['POST', '/Api/analyze'],
    ['PATCH', '/API/monitoring/posts/123'],
    ['DELETE', '/API/monitoring/accounts/alguien'],
    ['GET', '/API'],
    ['GET', '/api/'],
    // Doble barra.
    ['GET', '//api/monitoring/posts'],
    ['GET', '///API//monitoring///posts'],
    ['GET', '/api//monitoring/posts'],
    // Caracteres codificados.
    ['GET', '/%61pi/monitoring/posts'],
    ['GET', '/%41PI/monitoring/posts'],
    ['GET', '/a%50i/monitoring/posts'],
    ['GET', '/api%2Fmonitoring/posts'],
    ['GET', '/api%2fmonitoring%2Fposts'],
    ['GET', '/%2Fapi/monitoring/posts'],
    // Barra invertida, escrita y codificada.
    ['GET', '/api\\monitoring/posts'],
    ['GET', '/api%5Cmonitoring/posts'],
    // El id es un solo tramo para Express aunque decodificado "suba" de
    // carpeta: sigue siendo de /api/ y sigue pidiendo sesión.
    ['PATCH', '/api/monitoring/posts/..%2f..%2f..%2fcss'],
    ['DELETE', '/API/monitoring/accounts/..%2F..%2F..%2Findex'],
  ];

  for (const [method, rawPath] of API) {
    test(`${method} ${rawPath} → 401 y no llega al handler`, async () => {
      const res = await pedir(method, rawPath);
      assert.equal(res.status, 401);
      assert.deepEqual(llegadas, []);
      assert.ok(!res.body.includes('handler'));
    });
  }

  // Formas que ni Express ni el disco entienden como /api/: no hace falta que
  // den 401, pero tampoco pueden llegar a un handler ni devolver algo.
  const RARAS = [
    ['GET', '/api;x/monitoring/posts'],
    ['GET', '/css/../api/monitoring/posts'],
    ['GET', '/css/..%2fAPI/monitoring/posts'],
    ['GET', '/css/%2e%2e/api/monitoring/posts'],
    ['GET', '/api%00/monitoring/posts'],
    ['GET', '/api%252Fmonitoring/posts'],
  ];

  for (const [method, rawPath] of RARAS) {
    test(`${method} ${rawPath} → no llega a ningún handler`, async () => {
      const res = await pedir(method, rawPath);
      assert.ok(res.status >= 400, `respondió ${res.status}`);
      assert.deepEqual(llegadas, []);
    });
  }

  test('camino mal codificado → 400, sin llegar al handler', async () => {
    const res = await pedir('GET', '/api/monitoring/posts/%E0%A4%A');
    assert.equal(res.status, 400);
    assert.deepEqual(llegadas, []);
  });

  test('una cookie inventada no es una sesión', async () => {
    const res = await pedir('GET', '/API/monitoring/posts', { cookie: 'sl_session=cualquiera.cosa' });
    assert.equal(res.status, 401);
    assert.deepEqual(llegadas, []);
  });

  test('las rutas públicas de auth lo son solo escritas exactas', async () => {
    assert.equal((await pedir('POST', '/api/auth/magic-link')).status, 200);
    assert.equal((await pedir('GET', '/api/auth/me')).status, 200);
    assert.deepEqual(llegadas, ['POST magic-link', 'GET me']);

    llegadas.length = 0;
    assert.equal((await pedir('POST', '/API/auth/magic-link')).status, 401);
    assert.equal((await pedir('POST', '/api//auth/magic-link')).status, 401);
    assert.equal((await pedir('GET', '/api/auth/me/')).status, 401);
    assert.deepEqual(llegadas, []);
  });
});

describe('gate de login: páginas sin sesión', { concurrency: false }, () => {
  const PAGINAS = [
    '/dashboard.html',
    '/instagram.html',
    // Mayúsculas: en Windows el disco entrega el mismo archivo.
    '/DASHBOARD.HTML',
    '/Dashboard.Html',
    '/dashboard.HTML',
    // Lo que Windows ignora o acepta al final del nombre.
    '/dashboard.html.',
    '/dashboard.html%20',
    '/dashboard.html::$DATA',
    '/dashboard.html/',
    '/DASHBO~1.HTM',
    // Doble barra.
    '//dashboard.html',
    '/css//../dashboard.html',
    // Caracteres codificados.
    '/%64ashboard.html',
    '/dashboard%2Ehtml',
    '/dashboard.htm%6C',
    '/dashboard%2EHTML',
    '/css/..%5Cdashboard.html',
    '/css/%2e%2e/dashboard.html',
  ];

  for (const rawPath of PAGINAS) {
    test(`GET ${rawPath} → al login, sin mostrar la página`, async () => {
      const res = await pedir('GET', rawPath);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/');
      assert.ok(!res.body.includes(PAGINA));
    });
  }

  test('lo público sigue público: login, estilos, íconos y scripts', async () => {
    for (const rawPath of ['/', '/index.html', '/login-verify.html']) {
      const res = await pedir('GET', rawPath);
      assert.equal(res.status, 200, rawPath);
      assert.equal(res.body, LOGIN, rawPath);
    }
    for (const rawPath of ['/css/styles.css', '/js/login.js', '/js/monitoring.js', '/favicon.svg']) {
      assert.equal((await pedir('GET', rawPath)).status, 200, rawPath);
    }
  });

  test('la página de login escrita de otra forma no es la pública: manda al login', async () => {
    const res = await pedir('GET', '/INDEX.HTML');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/');
  });
});

describe('gate de login: con sesión', { concurrency: false }, () => {
  test('la API responde, también escrita en mayúsculas', async () => {
    assert.equal((await pedir('GET', '/api/monitoring/posts', { cookie: COOKIE })).status, 200);
    assert.equal((await pedir('GET', '/API/monitoring/posts', { cookie: COOKIE })).status, 200);
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: COOKIE })).status, 200);
    assert.deepEqual(llegadas, ['GET posts', 'GET posts', 'POST run-now']);
  });

  test('las páginas se ven y el login manda al dashboard', async () => {
    const pagina = await pedir('GET', '/dashboard.html', { cookie: COOKIE });
    assert.equal(pagina.status, 200);
    assert.equal(pagina.body, PAGINA);

    for (const rawPath of ['/', '/index.html']) {
      const res = await pedir('GET', rawPath, { cookie: COOKIE });
      assert.equal(res.status, 302, rawPath);
      assert.equal(res.location, '/dashboard.html', rawPath);
    }
  });
});

describe('canonicalPath', () => {
  test('decodifica, pasa a minúsculas, unifica las barras', () => {
    assert.equal(canonicalPath('/API/Monitoring/Posts'), '/api/monitoring/posts');
    assert.equal(canonicalPath('//api///monitoring/posts'), '/api/monitoring/posts');
    assert.equal(canonicalPath('/%41pi%2Fmonitoring'), '/api/monitoring');
    assert.equal(canonicalPath('/api%5Cmonitoring\\posts'), '/api/monitoring/posts');
    assert.equal(canonicalPath('/dashboard%2EHTML'), '/dashboard.html');
  });

  test('no resuelve los "..": un camino de /api/ sigue siendo de /api/', () => {
    assert.equal(canonicalPath('/api/monitoring/posts/..%2f..%2f..%2fcss'), '/api/monitoring/posts/../../../css');
  });

  test('decodifica una sola vez, como express.static', () => {
    assert.equal(canonicalPath('/api%252Fmonitoring'), '/api%2fmonitoring');
  });

  test('mal codificado: null', () => {
    assert.equal(canonicalPath('/api/%E0%A4%A'), null);
    assert.equal(canonicalPath('/%'), null);
  });
});
