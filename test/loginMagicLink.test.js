'use strict';

// Contrato del reenvío de magic links: emitir uno nuevo invalida el anterior,
// y el cooldown por email bloquea dentro de la ventana de 2 minutos.
// Corre contra un tempfile: nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-login-'));
process.env.MONITORING_DB_PATH = path.join(dbDir, 'monitoring.db');
// La allowlist se lee del env: redeemMagicLink rechaza emails no autorizados.
process.env.ALLOWED_EMAILS = 'test@example.com';

const { issueMagicLink, redeemMagicLink } = require('../src/auth/magicLink');
const {
  isResendBlocked,
  markMagicLinkSent,
  RESEND_COOLDOWN_MS,
} = require('../src/auth/rateLimit');

describe('login-magic-link', { concurrency: false }, () => {
  test('pedir un link nuevo invalida el anterior', () => {
    const { rawToken: viejo } = issueMagicLink('test@example.com');
    const { rawToken: nuevo } = issueMagicLink('test@example.com');

    assert.equal(redeemMagicLink(viejo).ok, false);
    assert.equal(redeemMagicLink(nuevo).ok, true);
    // Un solo uso: el mismo token no entra dos veces.
    assert.equal(redeemMagicLink(nuevo).ok, false);
  });

  test('cooldown: bloqueado dentro de la ventana, libre después', () => {
    const t0 = Date.now();
    const email = 'cooldown@example.com';

    assert.equal(isResendBlocked(email, t0), false);
    markMagicLinkSent(email, t0);
    assert.equal(isResendBlocked(email, t0 + RESEND_COOLDOWN_MS - 1), true);
    assert.equal(isResendBlocked(email, t0 + RESEND_COOLDOWN_MS), false);
    // El cooldown es por email: no arrastra a otras direcciones.
    assert.equal(isResendBlocked('otra@example.com', t0 + 1), false);
  });
});
