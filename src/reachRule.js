// ==========================================================================
// reachRule.js — Regla del alcance de una métrica (alto | normal | bajo).
// --------------------------------------------------------------------------
// Likes y comentarios se miran por separado, cada uno contra la mediana de
// SU cuenta, con la misma cuenta:
//
//   razón = (valor + colchón) / (mediana de la cuenta + colchón)
//
//   - alto:   razón >= REACH_HIGH_RATIO (1,5) y valor >= piso.
//   - normal: razón >= REACH_MID_RATIO (1,1). En pantalla es "medio".
//   - bajo:   el resto. Quiere decir "no se despega de lo normal de su
//             cuenta", no "le fue mal".
//
// El colchón existe por las cuentas chicas: contra una mediana de 2 likes,
// 100 likes daban 50 veces lo habitual y el posteo salía "alto". Sumando el
// colchón arriba y abajo, esa diferencia de 98 likes pesa lo que pesa (1,05)
// y una cuenta grande se sigue midiendo casi igual que antes. El piso es el
// mínimo absoluto para llegar a alto, por si el colchón se achica.
//
// Los seis números salen del .env, para calibrar sin tocar código:
//   REACH_LIKES_CUSHION (2000)     REACH_LIKES_FLOOR (1000)
//   REACH_COMMENTS_CUSHION (300)   REACH_COMMENTS_FLOOR (150)
//   REACH_HIGH_RATIO (1.5)         REACH_MID_RATIO (1.1)
// Un valor mal escrito aborta el arranque (server.js lo valida antes de
// cargar los módulos), igual que IG_ACTOR y REFRESH_MODE: un typo no puede
// cambiar en silencio qué posteos se ven como destacados.
//
// Sin dependencias: no carga la base ni ningún otro módulo de src/.
// ==========================================================================

const DEFAULTS = {
  REACH_LIKES_CUSHION: 2000,
  REACH_LIKES_FLOOR: 1000,
  REACH_COMMENTS_CUSHION: 300,
  REACH_COMMENTS_FLOOR: 150,
  REACH_HIGH_RATIO: 1.5,
  REACH_MID_RATIO: 1.1,
};

function fail(message) {
  const e = new Error(`${message} Revisá el archivo .env.`);
  e.userMessage = e.message;
  throw e;
}

const textOf = (raw) => String(raw === undefined || raw === null ? '' : raw).trim();

// Colchones y pisos: cantidades de likes o de comentarios. Enteros, sin
// separador de miles: "2.000" se leería como 2 y nadie se enteraría.
function readCount(env, name) {
  const text = textOf(env[name]);
  if (text === '') return DEFAULTS[name];
  if (!/^\d+$/.test(text)) {
    fail(`${name}="${env[name]}" no es válido: va un número entero, sin puntos ni comas (por defecto ${DEFAULTS[name]}).`);
  }
  return Number(text);
}

// Cortes: razones mayores que 0. Se acepta la coma decimal ("1,1").
function readRatio(env, name) {
  const text = textOf(env[name]);
  if (text === '') return DEFAULTS[name];
  const value = /^\d+([.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : NaN;
  if (!(value > 0)) {
    fail(`${name}="${env[name]}" no es válido: va un número mayor que 0, como ${DEFAULTS[name]}.`);
  }
  return value;
}

/**
 * @param {object} [env] de dónde leer las variables (por defecto, el entorno).
 * @returns {{ highRatio: number, midRatio: number,
 *   likes: { cushion: number, floor: number },
 *   comments: { cushion: number, floor: number } }}
 * @throws {Error} con userMessage si algún valor no es válido.
 */
function resolveReachRule(env = process.env) {
  const rule = {
    highRatio: readRatio(env, 'REACH_HIGH_RATIO'),
    midRatio: readRatio(env, 'REACH_MID_RATIO'),
    likes: { cushion: readCount(env, 'REACH_LIKES_CUSHION'), floor: readCount(env, 'REACH_LIKES_FLOOR') },
    comments: { cushion: readCount(env, 'REACH_COMMENTS_CUSHION'), floor: readCount(env, 'REACH_COMMENTS_FLOOR') },
  };
  if (rule.midRatio >= rule.highRatio) {
    fail(`REACH_MID_RATIO (${rule.midRatio}) tiene que ser menor que REACH_HIGH_RATIO (${rule.highRatio}).`);
  }
  return rule;
}

/**
 * Razón y nivel de UNA métrica de un posteo. Función pura: quien llama ya
 * verificó que hay valor y que la mediana es una referencia válida (un
 * número >= 0, con muestra suficiente).
 *
 * Con colchón 0 y mediana 0 no hay contra qué dividir: la razón se calcula
 * contra 1 (0 = 1x, 2 = 2x), como antes de que existiera el colchón.
 *
 * @param {'likes'|'comments'} metric
 * @param {number} value
 * @param {number} medianValue
 * @param {object} rule lo que devuelve resolveReachRule.
 * @returns {{ level: 'alto'|'normal'|'bajo', ratio: number, cushion: number, floor: number }}
 */
function reachLevel(metric, value, medianValue, rule) {
  const { cushion, floor } = rule[metric];
  const base = medianValue + cushion;
  const ratio = base > 0 ? (value + cushion) / base : value === 0 ? 1 : value;
  let level = 'normal';
  if (ratio >= rule.highRatio && value >= floor) level = 'alto';
  else if (ratio < rule.midRatio) level = 'bajo';
  return { level, ratio, cushion, floor };
}

/** Una línea para el arranque del servidor, con los números en uso. */
function describeReachRule(rule) {
  const n = (value) => String(value).replace('.', ',');
  return (
    `likes colchón ${rule.likes.cushion} / piso ${rule.likes.floor} · ` +
    `comentarios colchón ${rule.comments.cushion} / piso ${rule.comments.floor} · ` +
    `alto desde ${n(rule.highRatio)}x · medio desde ${n(rule.midRatio)}x`
  );
}

module.exports = { DEFAULTS, resolveReachRule, reachLevel, describeReachRule };
