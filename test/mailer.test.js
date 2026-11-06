'use strict';

// El mail del magic link (src/mailer.js) con la versión de Nodemailer
// instalada: el transporte SMTP se arma con las variables del .env y el mail
// se compone de verdad, pero sale por el jsonTransport de Nodemailer (sin
// red: ningún test manda un mail). createTransport se stubea sobre el objeto
// del módulo, como los adapters en el resto de la suite.

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SMTP_HOST = 'smtp.ejemplo.test';
process.env.SMTP_USER = 'remitente@ejemplo.test';
process.env.SMTP_PASS = 'clave-de-prueba';
delete process.env.SMTP_PORT;
delete process.env.SMTP_FROM;
process.env.APP_BASE_URL = 'https://escucha.ejemplo.test/';

const nodemailer = require('nodemailer');
const realCreateTransport = nodemailer.createTransport;

const pedidos = [];
const enviados = [];
nodemailer.createTransport = (opciones) => {
  pedidos.push(opciones);
  const transporte = realCreateTransport({ jsonTransport: true });
  const sendMail = transporte.sendMail.bind(transporte);
  transporte.sendMail = async (mail) => {
    const info = await sendMail(mail);
    enviados.push(JSON.parse(info.message));
    return info;
  };
  return transporte;
};

const { sendMagicLinkEmail } = require('../src/mailer');

describe('mailer del magic link', { concurrency: false }, () => {
  beforeEach(() => {
    enviados.length = 0;
  });

  test('arma el SMTP con el .env y manda el link armado con APP_BASE_URL', async () => {
    await sendMagicLinkEmail({ email: 'persona@ejemplo.test', rawToken: 'abc+/=123' });

    assert.equal(pedidos.length, 1);
    assert.deepEqual(pedidos[0], {
      host: 'smtp.ejemplo.test',
      port: 465,
      secure: true,
      auth: { user: 'remitente@ejemplo.test', pass: 'clave-de-prueba' },
    });

    assert.equal(enviados.length, 1);
    const mail = enviados[0];
    assert.equal(mail.to[0].address, 'persona@ejemplo.test');
    assert.equal(mail.from.address, 'remitente@ejemplo.test');
    assert.equal(mail.subject, 'Tu link para entrar — Social Listening');
    // El token va codificado y la barra final de APP_BASE_URL no se duplica.
    assert.ok(
      mail.text.includes('https://escucha.ejemplo.test/login-verify.html?token=abc%2B%2F%3D123'),
      mail.text
    );
  });

  test('el transporte se arma una sola vez', async () => {
    await sendMagicLinkEmail({ email: 'otra@ejemplo.test', rawToken: 't2' });
    assert.equal(pedidos.length, 1);
    assert.equal(enviados.length, 1);
  });
});
