// ==========================================================================
// clasificadorFoto.js
// --------------------------------------------------------------------------
// La foto como respaldo del clasificador (noviembre 2026, rama
// clasificacion-foto-y-exclusiones). Puro: sin base ni red. Ver
// src/classifier.js (cuándo se usa) y postImages.imageForModel (de dónde
// sale la imagen).
//
//   - CLASIFICAR_CON_FOTO: 1 (por defecto) | 0, que la apaga en todos lados.
//   - CLASIFICADOR_FOTO_MAX: cuántas llamadas con foto como mucho por ciclo
//     (y por invocación del backfill); 50 por defecto, 0 = ninguna.
//   - Texto corto: menos de MIN_TEXTO_UTIL (40) caracteres de texto útil
//     (sin links, menciones, hashtags ni emojis). Los hashtags y las
//     menciones igual van al modelo; solo no cuentan para el corte.
// ==========================================================================

const MIN_TEXTO_UTIL = 40;
const MAX_POR_CICLO_DEFAULT = 50;

/**
 * La config del .env. Tira con userMessage si está mal escrita (server.js
 * aborta el arranque, como con las demás).
 * @returns {{ habilitada: boolean, maxPorCiclo: number }}
 */
function resolveFotoConfig(env = process.env) {
  const errores = [];
  const flag = String(env.CLASIFICAR_CON_FOTO ?? '').trim().toLowerCase();
  let habilitada = true;
  if (flag === '0' || flag === 'false') habilitada = false;
  else if (flag !== '' && flag !== '1' && flag !== 'true') errores.push(`CLASIFICAR_CON_FOTO="${env.CLASIFICAR_CON_FOTO}" no es válido: 1 (con foto de respaldo) o 0 (sin foto).`);
  const crudo = String(env.CLASIFICADOR_FOTO_MAX ?? '').trim();
  let maxPorCiclo = MAX_POR_CICLO_DEFAULT;
  if (crudo !== '') {
    if (!/^\d+$/.test(crudo) || !Number.isSafeInteger(Number(crudo))) {
      errores.push(`CLASIFICADOR_FOTO_MAX="${env.CLASIFICADOR_FOTO_MAX}" no es válido: un entero, 0 o más, sin separador de miles (por ejemplo ${MAX_POR_CICLO_DEFAULT}).`);
    } else maxPorCiclo = Number(crudo);
  }
  if (errores.length > 0) {
    const err = new Error(errores.join(' '));
    err.userMessage = err.message;
    throw err;
  }
  return { habilitada, maxPorCiclo };
}

/** La línea del arranque. */
function describeFotoConfig(c) {
  if (!c.habilitada || c.maxPorCiclo === 0) return 'apagada: se clasifica solo con el texto';
  return `con menos de ${MIN_TEXTO_UTIL} caracteres de texto útil, sin texto, o si el modelo la pide; hasta ${c.maxPorCiclo} por ciclo`;
}

/** El texto que cuenta para el corte: sin links, menciones, hashtags ni emojis o símbolos. */
function textoUtil(caption) {
  return String(caption || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿El texto no alcanza solo? (vacío incluido) */
function textoCorto(caption) {
  return textoUtil(caption).length < MIN_TEXTO_UTIL;
}

/**
 * El tope de llamadas con foto de un ciclo (o de un backfill). tomar() da
 * true y descuenta mientras queda; después, false para siempre.
 */
function crearPresupuestoFoto(max) {
  const limite = Math.max(0, Math.floor(Number(max) || 0));
  const p = {
    usadas: 0,
    agotado: false,
    limite,
    tomar() {
      if (p.usadas >= limite) {
        p.agotado = true;
        return false;
      }
      p.usadas += 1;
      return true;
    },
  };
  return p;
}

module.exports = {
  resolveFotoConfig,
  describeFotoConfig,
  textoUtil,
  textoCorto,
  crearPresupuestoFoto,
  MIN_TEXTO_UTIL,
  MAX_POR_CICLO_DEFAULT,
};
