// One-off auth checks against spec scenarios. Not part of the app.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeEmail, isEmailAllowed } = require('../src/auth/allowlist');
const { issueMagicLink, redeemMagicLink } = require('../src/auth/magicLink');

const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];

function assert(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    console.log(`  FAIL ${name}`);
    failures.push(name);
  }
}

function request(method, urlPath, { headers = {}, body, redirect } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tmpAllow = path.join(__dirname, '_tmp-allowed.txt');
fs.writeFileSync(tmpAllow, '# comment\nAna@X.com\n\n');
assert('allowlist case + comment', isEmailAllowed('ana@x.com', tmpAllow));
assert('allowlist unknown', !isEmailAllowed('eve@x.com', tmpAllow));
fs.appendFileSync(tmpAllow, 'eve@x.com\n');
assert('allowlist edit without restart', isEmailAllowed('eve@x.com', tmpAllow));
fs.unlinkSync(tmpAllow);
assert('normalize', normalizeEmail('  Foo@Bar.COM ') === 'foo@bar.com');

process.env.ALLOWED_EMAILS = 'ana@x.com';
const issued = issueMagicLink('ana@x.com');
const first = redeemMagicLink(issued.rawToken);
assert('redeem once', first.ok === true && first.email === 'ana@x.com');
const second = redeemMagicLink(issued.rawToken);
assert('redeem reuse fails', second.ok === false);

const childEnv = {
  ...process.env,
  PORT: String(PORT),
  SESSION_SECRET: process.env.SESSION_SECRET || 'test-secret-32-chars-minimum-ok',
  APP_BASE_URL: BASE,
  ALLOWED_EMAILS: 'ana@x.com',
  MONITOR_CRON: '0 0 1 1 *',
};
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let started = false;
child.stdout.on('data', (buf) => {
  const text = buf.toString();
  if (text.includes('Servidor listo')) started = true;
});
child.stderr.on('data', (buf) => process.stderr.write(buf));

function waitForStart(ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (started) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer);
        reject(new Error('server did not start'));
      }
    }, 100);
  });
}

(async () => {
  try {
    await waitForStart(15000);

    const unknown = await request('POST', '/api/auth/magic-link', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'eve@x.com' }),
    });
    const allowedReq = await request('POST', '/api/auth/magic-link', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ana@x.com' }),
    });
    assert('generic 200 unknown', unknown.status === 200);
    assert('generic 200 allowed', allowedReq.status === 200);
    assert(
      'same payload',
      unknown.body === allowedReq.body && unknown.body.includes('Si el email está autorizado')
    );

    const analyze = await request('POST', '/api/analyze', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.instagram.com/p/XXXXXXXX/' }),
    });
    assert('analyze 401', analyze.status === 401);

    const dash = await request('GET', '/dashboard.html');
    assert('dashboard redirect', dash.status === 302 && (dash.headers.location || '').endsWith('/'));

    const getVerify = await request('GET', `/login-verify.html?token=${issued.rawToken}`);
    assert('GET verify does not consume page', getVerify.status === 200);

    const fresh = issueMagicLink('ana@x.com');
    const getAgain = await request('GET', `/login-verify.html?token=${encodeURIComponent(fresh.rawToken)}`);
    assert('GET verify html 200', getAgain.status === 200);

    const redeemHttp = await request('POST', '/api/auth/verify', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(fresh.rawToken)}`,
    });
    assert('POST verify 302', redeemHttp.status === 302 && redeemHttp.headers.location === '/dashboard.html');
    const setCookie = String(redeemHttp.headers['set-cookie'] || '');
    assert('set session cookie', setCookie.includes('sl_session='));
    const cookieHeader = setCookie.split(';')[0];

    const reuseHttp = await request('POST', '/api/auth/verify', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(fresh.rawToken)}`,
    });
    assert('POST reuse fails', reuseHttp.status === 400);

    const me = await request('GET', '/api/auth/me', { headers: { Cookie: cookieHeader } });
    assert('me 200', me.status === 200 && me.body.includes('ana@x.com'));

    const posts = await request('GET', '/api/monitoring/posts', { headers: { Cookie: cookieHeader } });
    assert('authed api 200', posts.status === 200);

    const logout = await request('POST', '/api/auth/logout', { headers: { Cookie: cookieHeader } });
    assert('logout 204', logout.status === 204);
    const logoutCookie = String(logout.headers['set-cookie'] || '');
    assert('logout clears cookie', /sl_session=/.test(logoutCookie) && /Max-Age=0/i.test(logoutCookie));

    const meAfter = await request('GET', '/api/auth/me');
    assert('me without cookie 401', meAfter.status === 401);

    const loginPage = await request('GET', '/');
    assert('login public', loginPage.status === 200);
  } finally {
    child.kill('SIGTERM');
  }

  if (failures.length) {
    console.error(`\n${failures.length} failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nall auth checks passed');
})().catch((err) => {
  console.error(err);
  child.kill('SIGTERM');
  process.exit(1);
});
