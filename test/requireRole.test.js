'use strict';

// Roles (src/auth/allowlist.js, src/auth/requireRole.js y la regla general
// de src/auth/gate.js): un lector ve todo pero no gasta ni escribe.
//
// - La allowlist: `email;rol`, el rol por defecto, un rol desconocido, el
//   repetido.
// - requireRole como middleware suelto.
// - La regla del gate sobre TODAS las rutas no-GET registradas en server.js y
//   en src/ (se leen del código: una ruta nueva entra sola al test): un
//   lector recibe 403 y no llega al handler; un operador llega. /API/... en
//   mayúsculas también da 403; /api/auth/* sigue abierto para un lector.
//
// App de prueba en un puerto local: el gate real y un handler que anota cada
// llegada. Base temporal; no carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-roles-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.APP_BASE_URL = 'http://localhost'; // cookie sin "secure"
process.env.SESSION_SECRET = 'secreto-de-test';
process.env.ALLOWED_EMAILS = [
  'lector@test.local',
  'operador@test.local;operador',
  'raro@test.local;admin',
  'doble@test.local;lector',
  'doble@test.local;operador',
].join(',');

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const allowlist = require('../src/auth/allowlist');
const { requireRole, hasRole, FORBIDDEN_BODY } = require('../src/auth/requireRole');
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');

const ROOT = path.join(__dirname, '..');

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

// --------------------------------------------------------------------------
// Las rutas que escriben o gastan, leídas del código.
// --------------------------------------------------------------------------
function archivosDeRutas() {
  const src = path.join(ROOT, 'src');
  const out = [path.join(ROOT, 'server.js')];
  const recorrer = (dir) => {
    for (const nombre of fs.readdirSync(dir)) {
      const full = path.join(dir, nombre);
      if (fs.statSync(full).isDirectory()) recorrer(full);
      else if (nombre.endsWith('.js')) out.push(full);
    }
  };
  recorrer(src);
  return out;
}

function rutasNoGet() {
  const rutas = [];
  const noLiterales = [];
  for (const file of archivosDeRutas()) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bapp\.(post|put|patch|delete)\(\s*([^,]+),/g)) {
      const arg = m[2].trim();
      const literal = /^'([^']+)'$/.exec(arg);
      if (!literal) {
        noLiterales.push(`${path.relative(ROOT, file)}: app.${m[1]}(${arg}`);
        continue;
      }
      rutas.push({ method: m[1].toUpperCase(), ruta: literal[1], file: path.relative(ROOT, file) });
    }
  }
  return { rutas, noLiterales };
}

// "/api/x/:id/temas" → "/api/x/x1/temas"
const conParametros = (ruta) => ruta.replace(/:[A-Za-z_]+/g, 'x1');

let server;
let port;
let LECTOR;
let OPERADOR;
let RARO;
let DOBLE;
const llegadas = [];

function pedir(method, rawPath, { cookie = null } = {}) {
  const conCuerpo = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
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
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end(conCuerpo ? '{}' : undefined);
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(createAuthGate());
  // Todo lo que pasa el gate llega acá y queda anotado.
  app.use('/api', (req, res) => {
    llegadas.push(`${req.method} ${req.originalUrl}`);
    res.json({ llego: true });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  LECTOR = sessionCookie('lector@test.local');
  OPERADOR = sessionCookie('operador@test.local');
  RARO = sessionCookie('raro@test.local');
  DOBLE = sessionCookie('doble@test.local');
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  llegadas.length = 0;
});

describe('allowlist con roles', () => {
  function conArchivo(contenido) {
    const file = path.join(tmp, `allowed-${Math.round(Math.random() * 1e9)}.txt`);
    fs.writeFileSync(file, contenido);
    return file;
  }

  test('email;rol, sin rol vale lector, mayúsculas y comentarios', () => {
    const file = conArchivo(
      ['# comentario', 'Ana@X.gob.ar;OPERADOR', 'juan@x.gob.ar', '  pepe@x.gob.ar ; lector  # al final', ''].join('\n')
    );
    assert.equal(allowlist.getRole('ana@x.gob.ar', file), 'operador');
    assert.equal(allowlist.getRole('juan@x.gob.ar', file), 'lector');
    assert.equal(allowlist.getRole('PEPE@x.gob.ar', file), 'lector');
    assert.equal(allowlist.getRole('nadie@x.gob.ar', file), null);
    assert.equal(allowlist.isEmailAllowed('juan@x.gob.ar', file), true);
    assert.equal(allowlist.isEmailAllowed('nadie@x.gob.ar', file), false);
  });

  test('un rol desconocido vale lector y avisa una sola vez', () => {
    const file = conArchivo('rara@x.gob.ar;superadmin\n');
    const avisos = [];
    const original = console.warn;
    console.warn = (...args) => avisos.push(args.join(' '));
    try {
      assert.equal(allowlist.getRole('rara@x.gob.ar', file), 'lector');
      assert.equal(allowlist.getRole('rara@x.gob.ar', file), 'lector');
    } finally {
      console.warn = original;
    }
    assert.equal(avisos.filter((a) => a.includes('superadmin')).length, 1, avisos.join('\n'));
  });

  test('repetido con roles distintos: gana el más alto, también entre archivo y env', () => {
    const file = conArchivo('mix@x.gob.ar;lector\nmix@x.gob.ar;operador\nsolo-env@test.local\n');
    assert.equal(allowlist.getRole('mix@x.gob.ar', file), 'operador');
    // doble@test.local está en el env como lector y como operador.
    assert.equal(allowlist.getRole('doble@test.local', file), 'operador');
    // El env suma al archivo: operador@test.local solo está en el env.
    assert.equal(allowlist.getRole('operador@test.local', file), 'operador');
  });
});

describe('requireRole', () => {
  function correr(mw, auth) {
    let status = 200;
    let body = null;
    let siguio = false;
    const res = {
      status(s) {
        status = s;
        return this;
      },
      json(b) {
        body = b;
        return this;
      },
    };
    mw({ auth }, res, () => (siguio = true));
    return { status, body, siguio };
  }

  test('lector recibe 403; operador pasa; sin sesión, 401', () => {
    const mw = requireRole('operador');
    assert.deepEqual(correr(mw, { email: 'l', role: 'lector' }), { status: 403, body: FORBIDDEN_BODY, siguio: false });
    assert.equal(correr(mw, { email: 'o', role: 'operador' }).siguio, true);
    assert.equal(correr(mw, null).status, 401);
    assert.equal(correr(mw, { email: 'x', role: 'admin' }).status, 403);
    assert.equal(correr(requireRole('lector'), { email: 'l', role: 'lector' }).siguio, true);
  });

  test('un rol que no existe no se puede exigir ni alcanza', () => {
    assert.throws(() => requireRole('admin'), /rol desconocido/);
    assert.equal(hasRole('operador', 'admin'), false);
    assert.equal(hasRole('constructor', 'lector'), false);
    assert.equal(hasRole('operador', 'lector'), true);
  });
});

describe('regla general del gate: todo no-GET bajo /api exige operador', { concurrency: false }, () => {
  const { rutas, noLiterales } = rutasNoGet();

  test('las rutas se leen todas del código (camino escrito como texto fijo)', () => {
    assert.deepEqual(noLiterales, [], 'una ruta con un camino que no es texto fijo no la ve este test');
    // Las que ya existían en noviembre 2026: si una desaparece de la lista,
    // el test dejó de leer bien el código.
    const claves = new Set(rutas.map((r) => `${r.method} ${r.ruta}`));
    for (const esperada of [
      'POST /api/x/analyze',
      'POST /api/monitoring/run-now',
      'POST /api/monitoring/backfill-classification',
      'POST /api/monitoring/posts/:id/ignore',
      'PATCH /api/monitoring/posts/:id',
      'POST /api/monitoring/accounts',
      'DELETE /api/monitoring/accounts/:account',
      'POST /api/monitoring/keywords',
      'DELETE /api/monitoring/keywords/:keyword',
      'POST /api/monitoring/searches',
      'DELETE /api/monitoring/searches/:search',
      'PATCH /api/reclamos/:id',
      'POST /api/reclamos/:id/corregir',
      'POST /api/reclamos/:id/descartar',
      'POST /api/analyze',
      'POST /api/analyze/:id/confirmar',
      'DELETE /api/analisis/:id',
      'PATCH /api/analisis/:id/temas',
      'POST /api/figuras',
      'PATCH /api/figuras/:username',
      'POST /api/figuras/:username/descartar',
      'DELETE /api/figuras/:username',
      'POST /api/auth/magic-link',
      'POST /api/auth/verify',
      'POST /api/auth/logout',
    ]) {
      assert.ok(claves.has(esperada), `falta ${esperada}`);
    }
  });

  test('lector: 403 en cada ruta no-GET fuera de /api/auth, sin llegar al handler', async () => {
    const protegidas = rutas.filter((r) => r.ruta.startsWith('/api/') && !r.ruta.startsWith('/api/auth/'));
    assert.ok(protegidas.length >= 20, `solo ${protegidas.length} rutas`);
    for (const r of protegidas) {
      const res = await pedir(r.method, conParametros(r.ruta), { cookie: LECTOR });
      assert.equal(res.status, 403, `${r.method} ${r.ruta} (${r.file})`);
      assert.deepEqual(JSON.parse(res.body), FORBIDDEN_BODY);
    }
    assert.deepEqual(llegadas, []);
  });

  test('operador: llega al handler en cada ruta no-GET', async () => {
    const protegidas = rutas.filter((r) => r.ruta.startsWith('/api/') && !r.ruta.startsWith('/api/auth/'));
    for (const r of protegidas) {
      const res = await pedir(r.method, conParametros(r.ruta), { cookie: OPERADOR });
      assert.equal(res.status, 200, `${r.method} ${r.ruta} (${r.file})`);
    }
    assert.equal(llegadas.length, protegidas.length);
  });

  test('/API/... en mayúsculas o con otra forma también da 403 al lector', async () => {
    for (const raw of [
      '/API/MONITORING/RUN-NOW',
      '/Api/Analyze',
      '/api%2Fmonitoring%2Frun-now',
      '//api//monitoring/run-now',
      '/api/auth/../monitoring/run-now',
      '/api/auth/%2e%2e/monitoring/run-now',
    ]) {
      const res = await pedir('POST', raw, { cookie: LECTOR });
      assert.equal(res.status, 403, raw);
    }
    assert.deepEqual(llegadas, []);
  });

  test('cualquier método que no sea GET, HEAD u OPTIONS cuenta, también uno que nadie registró', async () => {
    assert.equal((await pedir('PUT', '/api/monitoring/posts/1', { cookie: LECTOR })).status, 403);
    assert.equal((await pedir('DELETE', '/api/ruta-del-futuro', { cookie: LECTOR })).status, 403);
    assert.equal((await pedir('POST', '/api/ruta-del-futuro', { cookie: OPERADOR })).status, 200);
  });

  test('un lector lee: GET, HEAD y OPTIONS pasan', async () => {
    assert.equal((await pedir('GET', '/api/monitoring/posts?plataforma=instagram', { cookie: LECTOR })).status, 200);
    assert.equal((await pedir('HEAD', '/api/monitoring/posts', { cookie: LECTOR })).status, 200);
    assert.equal((await pedir('OPTIONS', '/api/monitoring/posts', { cookie: LECTOR })).status, 200);
  });

  test('/api/auth/* sigue abierto para un lector (salir, ver quién soy)', async () => {
    assert.equal((await pedir('POST', '/api/auth/logout', { cookie: LECTOR })).status, 200);
    assert.equal((await pedir('POST', '/API/auth/logout', { cookie: LECTOR })).status, 200);
    const me = await pedir('GET', '/api/auth/me', { cookie: LECTOR });
    assert.equal(me.status, 200);
  });

  test('sin sesión, un no-GET da 401 (no 403)', async () => {
    assert.equal((await pedir('POST', '/api/monitoring/run-now')).status, 401);
  });

  test('un rol desconocido es lector; el repetido, el más alto', async () => {
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: RARO })).status, 403);
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: DOBLE })).status, 200);
  });
});
