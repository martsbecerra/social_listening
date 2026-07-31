// ==========================================================================
// notify.js
// --------------------------------------------------------------------------
// Orquesta el envío de notificaciones para un posteo nuevo relevante: por
// ahora solo email, con el lugar preparado para sumar WhatsApp más adelante.
// ==========================================================================

const { sendAlertEmail } = require('./mailer');
const { sendWhatsAppAlert } = require('./notifiers/whatsapp');
const db = require('./db');

async function notifyNewPost(post) {
  try {
    await sendAlertEmail(post);
  } catch (err) {
    console.error(`No se pudo enviar el email de alerta para ${post.url}:`, err.message);
    return;
  }

  // Placeholder: no hace nada todavía, ver src/notifiers/whatsapp.js
  await sendWhatsAppAlert(post);

  db.markNotified(post.id);
}

module.exports = { notifyNewPost };
