// ==========================================================================
// whatsapp.js
// --------------------------------------------------------------------------
// Placeholder para notificaciones por WhatsApp. Todavía no está implementado
// (falta definir proveedor: WhatsApp Business API, Twilio, etc.). Por ahora
// es un no-op para que src/notify.js pueda llamarlo sin romper nada.
// ==========================================================================

async function sendWhatsAppAlert(post) {
  // TODO: implementar cuando se defina el proveedor de WhatsApp.
  return;
}

module.exports = { sendWhatsAppAlert };
