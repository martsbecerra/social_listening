'use strict';

// Límite de pedidos (src/rateLimits.js, rama rate-limit-y-salud):
//
// - Cada límite da 429 { error: 'Demasiados pedidos. Esperá unos minutos.' }
//   con Retry-After al pasarse: general, sondeo, fotos, resumen, gasto y
//   rechazados (los números chicos salen del entorno, fijado antes de los
//   require).
// - Con sesión la clave es el correo (el mismo correo desde otra IP sigue
//   frenado; otro correo desde la misma IP, no). Sin sesión, la IP.
// - Sondeo, fotos y resumen no gastan el general; el gasto sí.
// - Gasto: compartido entre las cinco rutas, cada una cuenta, y /API/... con
//   barra final también. Cada ruta de RUTAS_GASTO existe en el código.
// - Rechazados: antes del gate, cuenta solo 401 y 403 de /api; frena a quien
//   no tiene sesión y deja pasar a quien sí; /health y lo que no es /api
//   quedan afuera.
// - Detrás de un proxy (trust proxy 1 y X-Forwarded-For): la clave es la IP
//   del cliente, no la del proxy ni una escrita por el cliente, y
//   express-rate-limit no avisa ningún error de configuración.
// - El orden de server.js.
//
// App de prueba en un puerto local con el gate real; base temporal; no
// carga server.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-limites-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.APP_BASE_URL = 'http://localhost'; // cookie sin "secure"
const CORREOS = 'abcdefghijklmnopqrstuvwxyz'.split('').map((l) => `${l}@test.local`);
process.env.ALLOWED_EMAILS = [...CORREOS.map((c) => `${c};operador`), 'lector@test.local'].join(',');
Object.assign(process.env, {
  RATE_LIMIT_API_MAX: '5',
  RATE_LIMIT_SONDEO_MAX: '4',
  RATE_LIMIT_IMAGENES_MAX: '3',
  RATE_LIMIT_RESUMEN_MAX: '3',
  RATE_LIMIT_GASTO_MAX: '2',
  RATE_LIMIT_RECHAZOS_MAX: '4',
});

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const rateLimits = require('../src/rateLimits');
const { DEMASIADOS_BODY, RUTAS_SONDEO, RUTAS_IMAGENES, RUTA_RESUMEN, RUTAS_GASTO } = rateLimits;
const { createAuthGate } = require('../src/auth/gate');
const { setSessionCookie } = require('../src/auth/session');
const { errorHandler, trustProxySetting } = require('../src/httpSecurity');

const ROOT = path.join(__dirname, '..');

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ append: (name, value) => (header = value) }, email);
  return header.split(';')[0];
}

let server;
let port;
let usados = 0;
// Un correo distinto por caso: los contadores viven todo el archivo.
function correoNuevo() {
  const email = CORREOS[usados];
  usados += 1;
  assert.ok(email, 'faltan correos de prueba');
  return email;
}

function pedir(method, rawPath, { cookie = null, ip = null, headers = {} } = {}) {
  const conCuerpo = method !== 'GET' && method !== 'HEAD';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: rawPath,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(ip ? { 'X-Forwarded-For': ip } : {}),
          ...(conCuerpo ? { 'Content-Type': 'application/json', 'Content-Length': 2 } : {}),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on('error', reject);
    if (conCuerpo) req.write('{}');
    req.end();
  });
}

async function repetir(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn(i));
  return out;
}

function assert429(r) {
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, DEMASIADOS_BODY);
  const segundos = Number(r.headers['retry-after']);
  assert.ok(Number.isInteger(segundos) && segundos >= 1 && segundos <= 3600, `Retry-After: ${r.headers['retry-after']}`);
}

// Avisos de express-rate-limit (ERR_ERL_...) y del límite ([limite]).
const avisos = [];
const consoleWarn = console.warn;
const consoleError = console.error;

before(async () => {
  console.warn = (...args) => {
    avisos.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    avisos.push(args.map(String).join(' '));
  };
  const app = express();
  // Como en Railway: APP_BASE_URL https => trust proxy 1.
  app.set('trust proxy', trustProxySetting({ APP_BASE_URL: 'https://escucha.example.org' }));
  app.use(rateLimits.limites().rechazados);
  // Después del límite de rechazados a propósito: lo deja afuera su skip.
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(createAuthGate({ confirmarBajaMs: 5 }));
  rateLimits.registrarLimites(app);
  const ok = (req, res) => res.json({ ok: true });
  for (const ruta of RUTAS_SONDEO) app.get(ruta, ok);
  for (const ruta of RUTAS_IMAGENES) app.get(ruta, ok);
  app.get(RUTA_RESUMEN, ok);
  for (const ruta of RUTAS_GASTO) app.post(ruta, ok);
  app.get('/api/monitoring/posts', ok);
  app.get('/api/otra', ok);
  app.use(errorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  console.warn = consoleWarn;
  console.error = consoleError;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('config (RATE_LIMIT_*)', () => {
  test('sin nada, los defaults; con valores, esos', () => {
    assert.deepEqual(rateLimits.resolveRateLimitConfig({}), {
      general: 600,
      sondeo: 4000,
      imagenes: 2000,
      resumen: 200,
      gasto: 20,
      rechazados: 300,
    });
    const c = rateLimits.resolveRateLimitConfig({ RATE_LIMIT_API_MAX: ' 50 ', RATE_LIMIT_GASTO_MAX: '7', RATE_LIMIT_SONDEO_MAX: '' });
    assert.equal(c.general, 50);
    assert.equal(c.gasto, 7);
    assert.equal(c.sondeo, 4000);
    assert.match(rateLimits.describeRateLimitConfig(c), /general 50.*gasto 7 por hora/);
  });

  test('un valor mal escrito tira con el nombre de la variable', () => {
    for (const malo of ['2.000', '0', '-3', 'mil', '1e3', '12,5']) {
      assert.throws(
        () => rateLimits.resolveRateLimitConfig({ RATE_LIMIT_RESUMEN_MAX: malo }),
        (err) => err.userMessage && err.message.includes('RATE_LIMIT_RESUMEN_MAX'),
        malo
      );
    }
  });
});

describe('general', () => {
  test('429 al pasarse, con el texto y Retry-After; la clave es el correo, no la IP', async () => {
    const a = sessionCookie(correoNuevo());
    const b = sessionCookie(correoNuevo());
    const oks = await repetir(5, () => pedir('GET', '/api/monitoring/posts', { cookie: a, ip: '198.51.100.1' }));
    assert.deepEqual(oks.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert429(await pedir('GET', '/api/monitoring/posts', { cookie: a, ip: '198.51.100.1' }));
    // El mismo correo desde otra IP: sigue frenado.
    assert429(await pedir('GET', '/api/otra', { cookie: a, ip: '198.51.100.2' }));
    // En mayúsculas también cuenta.
    assert429(await pedir('GET', '/API/Otra', { cookie: a, ip: '198.51.100.2' }));
    // Otro correo desde la misma IP: pasa.
    assert.equal((await pedir('GET', '/api/monitoring/posts', { cookie: b, ip: '198.51.100.1' })).status, 200);
    assert.ok(avisos.some((l) => l.includes('[limite] general') && l.includes('correo')), 'una línea de log al pasarse');
  });
});

describe('sondeo y fotos: su propio límite', () => {
  test('el sondeo no gasta el general, ni el general el sondeo', async () => {
    const c = sessionCookie(correoNuevo());
    await repetir(5, () => pedir('GET', '/api/otra', { cookie: c }));
    assert429(await pedir('GET', '/api/otra', { cookie: c }));
    const sondeos = await repetir(4, (i) => pedir('GET', `${RUTAS_SONDEO[i % RUTAS_SONDEO.length]}?plataforma=instagram`, { cookie: c }));
    assert.deepEqual(sondeos.map((r) => r.status), [200, 200, 200, 200]);
    assert429(await pedir('GET', '/api/monitoring/progress', { cookie: c }));

    const d = sessionCookie(correoNuevo());
    await repetir(4, () => pedir('GET', '/api/monitoring/status', { cookie: d }));
    const generales = await repetir(5, () => pedir('GET', '/api/otra', { cookie: d }));
    assert.deepEqual(generales.map((r) => r.status), [200, 200, 200, 200, 200]);
  });

  test('las fotos: las dos rutas comparten su límite, aparte del general', async () => {
    const f = sessionCookie(correoNuevo());
    await repetir(3, () => pedir('GET', '/api/monitoring/posts/123/image?size=thumb', { cookie: f }));
    assert429(await pedir('GET', '/api/analisis/9/image?size=full', { cookie: f }));
    assert.equal((await pedir('GET', '/api/otra', { cookie: f })).status, 200);
  });
});

describe('resumen público: por IP', () => {
  test('sin sesión, por IP; con sesión, también por IP; no gasta el general', async () => {
    const ip = '203.0.113.10';
    const oks = await repetir(3, () => pedir('GET', RUTA_RESUMEN, { ip }));
    assert.deepEqual(oks.map((r) => r.status), [200, 200, 200]);
    assert429(await pedir('GET', RUTA_RESUMEN, { ip }));
    assert.equal((await pedir('GET', RUTA_RESUMEN, { ip: '203.0.113.11' })).status, 200);
    const g = sessionCookie(correoNuevo());
    assert429(await pedir('GET', RUTA_RESUMEN, { ip, cookie: g }));
    assert.equal((await pedir('GET', '/api/otra', { ip, cookie: g })).status, 200);
  });
});

describe('gasto', () => {
  const conId = (ruta) => ruta.replace(':id', '7');

  test('cada una de las cinco rutas cuenta y se frena al pasarse', async () => {
    for (const ruta of RUTAS_GASTO) {
      const cookie = sessionCookie(correoNuevo());
      const oks = await repetir(2, () => pedir('POST', conId(ruta), { cookie }));
      assert.deepEqual(oks.map((r) => r.status), [200, 200], ruta);
      assert429(await pedir('POST', conId(ruta), { cookie }));
    }
  });

  test('el contador es uno para todas, por correo; /API/... con barra final también cuenta', async () => {
    const h = sessionCookie(correoNuevo());
    assert.equal((await pedir('POST', '/api/monitoring/run-now', { cookie: h })).status, 200);
    assert.equal((await pedir('POST', '/api/analyze', { cookie: h })).status, 200);
    assert429(await pedir('POST', '/api/analyze/7/confirmar', { cookie: h }));

    const i = sessionCookie(correoNuevo());
    const oks = await repetir(2, () => pedir('POST', '/API/Monitoring/Run-Now/', { cookie: i }));
    assert.deepEqual(oks.map((r) => r.status), [200, 200]);
    assert429(await pedir('POST', '/api/monitoring/run-now', { cookie: i }));
  });

  test('lo que gasta también cuenta en el general', async () => {
    const j = sessionCookie(correoNuevo());
    await repetir(2, () => pedir('POST', '/api/x/analyze', { cookie: j }));
    const oks = await repetir(3, () => pedir('GET', '/api/otra', { cookie: j }));
    assert.deepEqual(oks.map((r) => r.status), [200, 200, 200]);
    assert429(await pedir('GET', '/api/otra', { cookie: j }));
  });

  test('cada ruta de RUTAS_GASTO es una ruta POST del código, y sondeo, fotos y resumen también existen', () => {
    const archivos = [path.join(ROOT, 'server.js')];
    const recorrer = (dir) => {
      for (const nombre of fs.readdirSync(dir)) {
        const full = path.join(dir, nombre);
        if (fs.statSync(full).isDirectory()) recorrer(full);
        else if (nombre.endsWith('.js')) archivos.push(full);
      }
    };
    recorrer(path.join(ROOT, 'src'));
    const codigo = archivos.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const ruta of RUTAS_GASTO) assert.ok(codigo.includes(`app.post('${ruta}'`), `falta la ruta ${ruta}`);
    for (const ruta of RUTAS_SONDEO) assert.ok(codigo.includes(`app.get('${ruta}'`), `falta la ruta ${ruta}`);
    assert.ok(codigo.includes("app.get('/api/analisis/:id/image'"));
    assert.equal(require('../src/postImageRoutes').IMAGE_ROUTE, RUTAS_IMAGENES[0]);
    assert.equal(require('../src/publicResumen').RESUMEN_ROUTE, RUTA_RESUMEN);
  });
});

describe('rechazados: antes del gate, por IP', () => {
  test('cuenta solo 401 y 403; sin sesión frena, con sesión deja pasar; /health queda afuera', async () => {
    const ip = '192.0.2.50';
    // Lo que sale bien no cuenta (se descuenta al terminar).
    const k = sessionCookie(correoNuevo());
    await repetir(4, () => pedir('GET', '/api/otra', { cookie: k, ip }));
    // Cuatro 401 entran; el quinto pedido sin sesión ya es 429.
    const rechazos = await repetir(4, () => pedir('GET', '/api/monitoring/posts', { ip }));
    assert.deepEqual(rechazos.map((r) => r.status), [401, 401, 401, 401]);
    assert429(await pedir('GET', '/api/monitoring/posts', { ip }));
    assert429(await pedir('GET', '/api/auth/me', { ip }));
    // Con una sesión válida, desde la misma IP: pasa.
    const l = sessionCookie(correoNuevo());
    assert.equal((await pedir('GET', '/api/otra', { cookie: l, ip })).status, 200);
    // /health y lo que no es /api, afuera.
    assert.equal((await pedir('GET', '/health', { ip })).status, 200);
    assert.notEqual((await pedir('GET', '/js/no-existe.js', { ip })).status, 429);
    // Otra IP no tiene nada que ver.
    assert.equal((await pedir('GET', '/api/monitoring/posts', { ip: '192.0.2.51' })).status, 401);
    assert.ok(avisos.some((a) => a.includes('[limite] rechazados') && a.includes('192.0.2.50')));
  });

  test('los 403 también cuentan (un lector que escribe, una escritura de otro sitio)', async () => {
    const ip = '192.0.2.60';
    const lector = sessionCookie('lector@test.local');
    const r1 = await repetir(2, () => pedir('POST', '/api/otra', { cookie: lector, ip }));
    assert.deepEqual(r1.map((r) => r.status), [403, 403]);
    const r2 = await repetir(2, () => pedir('POST', '/api/monitoring/run-now', { ip, headers: { 'Sec-Fetch-Site': 'cross-site' } }));
    assert.deepEqual(r2.map((r) => r.status), [403, 403]);
    assert429(await pedir('GET', '/api/otra', { ip }));
    // El lector sigue con su sesión: no lo frena este límite.
    assert.equal((await pedir('GET', '/api/otra', { cookie: lector, ip })).status, 200);
  });
});

describe('detrás de un proxy (Railway)', () => {
  test('trust proxy es 1 con https o TRUST_PROXY, nunca true; si no, false', () => {
    assert.equal(trustProxySetting({ APP_BASE_URL: 'https://escucha.example.org' }), 1);
    assert.equal(trustProxySetting({ TRUST_PROXY: '1' }), 1);
    assert.equal(trustProxySetting({ TRUST_PROXY: 'true' }), 1);
    assert.equal(trustProxySetting({ APP_BASE_URL: 'http://localhost:3000' }), false);
    assert.equal(trustProxySetting({}), false);
  });

  test('la clave por IP es la del cliente (la que agrega el proxy), no una escrita por el cliente', async () => {
    // El cliente puede mandar su propio X-Forwarded-For; el proxy agrega la
    // dirección real al final. Con trust proxy 1 vale la última.
    const cliente = '198.51.100.77';
    const oks = await repetir(3, (i) => pedir('GET', RUTA_RESUMEN, { ip: `10.9.9.${i}, ${cliente}` }));
    assert.deepEqual(oks.map((r) => r.status), [200, 200, 200]);
    assert429(await pedir('GET', RUTA_RESUMEN, { ip: `6.6.6.6, ${cliente}` }));
    // Otro cliente detrás del mismo proxy (la conexión llega siempre desde
    // 127.0.0.1): su propio contador.
    assert.equal((await pedir('GET', RUTA_RESUMEN, { ip: '198.51.100.78' })).status, 200);
  });

  test('express-rate-limit no avisó ningún error de configuración en todo el archivo', () => {
    const erl = avisos.filter((a) => a.includes('ERR_ERL'));
    assert.deepEqual(erl, []);
  });
});

describe('server.js', () => {
  test('el orden: headers, no-store, /health, rechazados, cuerpo de hasta 100 kb, gate, límites de /api, estáticos', () => {
    const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const orden = [
      'app.use(securityHeaders())',
      'app.use(noStoreApi)',
      'healthRoutes.register(app)',
      'app.use(rateLimits.limites().rechazados)',
      "app.use(express.json({ limit: '100kb' }))",
      'app.use(createAuthGate())',
      'rateLimits.registrarLimites(app)',
      'app.use(express.static(',
    ].map((s) => {
      const i = code.indexOf(s);
      assert.ok(i >= 0, `falta: ${s}`);
      return i;
    });
    assert.deepEqual([...orden].sort((x, y) => x - y), orden);
  });
});
