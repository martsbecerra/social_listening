// ==========================================================================
// mailer.js
// --------------------------------------------------------------------------
// Envío de emails de alerta cuando el monitoreo detecta un posteo nuevo
// relevante. Usa Nodemailer con SMTP (por defecto, Gmail).
//
// Con Gmail hace falta una "contraseña de aplicación" (no la contraseña
// normal): https://myaccount.google.com/apppasswords
// ==========================================================================

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
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

function buildEmailBody(post) {
  const captionSnippet = (post.caption || '').slice(0, 300);
  const fecha = post.postedAt ? new Date(post.postedAt).toLocaleString('es-AR') : 'N/D';

  return [
    `Cuenta: @${post.account}`,
    `Motivo: ${post.matchedReason}`,
    `Link: ${post.url}`,
    `Fecha: ${fecha}`,
    `Likes: ${post.likes ?? 'N/D'} | Comentarios: ${post.comments ?? 'N/D'}`,
    '',
    'Caption:',
    captionSnippet || '(sin texto)',
  ].join('\n');
}

/**
 * Manda el email de alerta de un posteo nuevo relevante.
 * Lanza el error tal cual si falla (el caller decide cómo loguearlo).
 */
async function sendAlertEmail(post) {
  const to = process.env.ALERT_EMAIL_TO;
  if (!to) {
    throw new Error('ALERT_EMAIL_TO no está configurado en el .env');
  }

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `🔔 Nueva mención: @${post.account}`,
    text: buildEmailBody(post),
  });
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

module.exports = { sendAlertEmail, sendMagicLinkEmail };
