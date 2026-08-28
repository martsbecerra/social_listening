// ==========================================================================
// mailer.js
// --------------------------------------------------------------------------
// Envío del email con el magic link de login. Usa Nodemailer con SMTP (por
// defecto, Gmail). Es el único uso de email de la app: las notificaciones
// del monitoreo por mail se eliminaron.
//
// Con Gmail hace falta una "contraseña de aplicación" (no la contraseña
// normal): https://myaccount.google.com/apppasswords
// ==========================================================================

const nodemailer = require('nodemailer');

let transporter = null;

function smtpConfigError() {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((key) => !process.env[key]);
  if (missing.length === 0) return null;
  return new Error(
    `Faltan ${missing.join(', ')} en el .env. Sin SMTP_HOST, Nodemailer intenta 127.0.0.1 y el magic link no sale.`
  );
}

function getTransporter() {
  const configError = smtpConfigError();
  if (configError) throw configError;

  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
}

/**
 * Mail del magic link de login. El URL se arma con APP_BASE_URL, nunca
 * con el header Host.
 */
async function sendMagicLinkEmail({ email, rawToken }) {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('APP_BASE_URL no está configurado en el .env');
  }

  const verifyUrl = `${base}/login-verify.html?token=${encodeURIComponent(rawToken)}`;

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Tu link para entrar — Social Listening',
    text: [
      'Hacé clic en este link para entrar. Vence en 15 minutos y se usa una sola vez.',
      '',
      verifyUrl,
      '',
      'Si no pediste entrar, ignorá este mail.',
    ].join('\n'),
  });
}

module.exports = { sendMagicLinkEmail };
