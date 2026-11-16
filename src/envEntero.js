// ==========================================================================
// envEntero.js
// --------------------------------------------------------------------------
// Un entero positivo del .env, sin dependencias (lo usan los chequeos del
// arranque de server.js, antes de cargar la base). Vacío o ausente: el valor
// por defecto. Solo dígitos: "2.000" o "1,5" se rechazan (no se adivina si
// el punto es de miles). Mal escrito: tira con userMessage, que va solo a la
// consola del arranque (por eso puede nombrar la variable).
// ==========================================================================

function leerEnteroPositivo(env, nombre, porDefecto) {
  const raw = env[nombre];
  if (raw == null || String(raw).trim() === '') return porDefecto;
  const texto = String(raw).trim();
  if (!/^\d+$/.test(texto) || Number(texto) <= 0) {
    const e = new Error(`${nombre}="${raw}" no es válido: tiene que ser un entero positivo, sin puntos ni comas (por defecto ${porDefecto}).`);
    e.userMessage = e.message;
    throw e;
  }
  return Number(texto);
}

module.exports = { leerEnteroPositivo };
