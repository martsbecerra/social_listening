'use strict';

// ==========================================================================
// stopwords.js — Palabras vacías en castellano para la nube de palabras de
// Estadísticas (src/stats.js).
// --------------------------------------------------------------------------
// Van ya en minúscula y sin tildes: stats.js compara así ("más" y "mas" son
// la misma). Solo cuentan las palabras sueltas de 3 letras o más, así que las
// de una o dos letras ("a", "de", "el", "en", "la", "lo", "mi", "no", "se",
// "si", "su", "te", "tu", "un", "ya", "yo") no hace falta listarlas. Una
// palabra de la lista de palabras clave del monitoreo cuenta aunque esté
// acá: esas se buscan antes, como frases.
// ==========================================================================

const LISTA = [
  // Artículos, contracciones y demostrativos
  'las', 'los', 'una', 'unas', 'unos', 'del',
  'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'esos', 'esas',
  'aquel', 'aquella', 'aquello', 'aquellos', 'aquellas',
  // Preposiciones
  'ante', 'bajo', 'cabe', 'con', 'contra', 'desde', 'durante', 'entre', 'hacia', 'hasta',
  'mediante', 'para', 'por', 'segun', 'sin', 'sobre', 'tras', 'via',
  // Pronombres
  'ella', 'ellas', 'ello', 'ellos', 'nos', 'nosotros', 'nosotras', 'vos', 'ustedes', 'usted',
  'les', 'mis', 'tus', 'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'suyo', 'suya',
  'suyos', 'suyas', 'mio', 'mia', 'tuyo', 'tuya', 'que', 'quien', 'quienes', 'cual', 'cuales',
  'cuyo', 'cuya', 'donde', 'cuando', 'como', 'cuanto', 'cuanta', 'cuantos', 'cuantas',
  'algo', 'alguien', 'alguno', 'alguna', 'algunos', 'algunas', 'nada', 'nadie', 'ninguno',
  'ninguna', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'mismos', 'mismas',
  'todo', 'toda', 'todos', 'todas', 'cada', 'varios', 'varias', 'tal', 'tales',
  // Conjunciones y conectores
  'pero', 'sino', 'porque', 'pues', 'aunque', 'mientras', 'entonces', 'luego', 'asi',
  'tambien', 'tampoco', 'ademas', 'incluso', 'solo', 'sola', 'solos', 'solamente', 'apenas',
  // Adverbios de todos los días
  'hoy', 'ayer', 'manana', 'ahora', 'antes', 'despues', 'siempre', 'nunca', 'jamas', 'aun',
  'todavia', 'tarde', 'temprano', 'pronto', 'aca', 'aqui', 'alla', 'alli', 'ahi', 'cerca',
  'lejos', 'arriba', 'abajo', 'adelante', 'atras', 'mas', 'menos', 'muy', 'mucho', 'mucha',
  'muchos', 'muchas', 'poco', 'poca', 'pocos', 'pocas', 'tanto', 'tanta', 'tantos', 'tantas',
  'bien', 'mal', 'mejor', 'peor', 'casi', 'nomas', 'recien', 'igual', 'bueno', 'buena',
  // Verbos auxiliares y muy comunes
  'ser', 'son', 'era', 'eran', 'fue', 'fueron', 'sea', 'sean', 'sido', 'siendo', 'soy',
  'sos', 'somos', 'seria', 'serian', 'sera', 'seran',
  'estar', 'estan', 'estaba', 'estaban', 'estuvo', 'estuvieron', 'estoy', 'estamos',
  'estado', 'estando', 'esten',
  'haber', 'hay', 'habia', 'habian', 'hubo', 'han', 'has', 'hemos', 'habra', 'haya', 'hayan',
  'tener', 'tiene', 'tienen', 'tenia', 'tenian', 'tuvo', 'tengo', 'tenes', 'tenemos',
  'hacer', 'hace', 'hacen', 'hizo', 'hicieron', 'hago', 'haces', 'hacemos', 'hecho',
  'poder', 'puede', 'pueden', 'pudo', 'podia', 'puedo', 'podes', 'podemos',
  'decir', 'dice', 'dicen', 'dijo', 'dijeron', 'digo', 'decis',
  'van', 'iba', 'iban', 'voy', 'vamos', 'vas',
  'dar', 'dan', 'dio', 'dieron', 'doy',
  'ver', 'veo', 'ves', 'vemos', 'vio', 'visto',
  'saber', 'sabe', 'saben', 'sabes', 'sabemos',
  'quiere', 'quieren', 'quiero', 'queres', 'queremos',
  'deja', 'dejan', 'dejo', 'pasa', 'pasan', 'paso', 'sigue', 'siguen', 'llega', 'llegan',
  // Tiempo y cantidades genéricas
  'dia', 'dias', 'vez', 'veces', 'ano', 'anos', 'mes', 'meses', 'semana', 'semanas', 'hora',
  'horas', 'momento', 'parte', 'cosa', 'cosas', 'tipo', 'forma', 'caso', 'casos', 'uno', 'dos',
  'tres', 'cuatro', 'cinco', 'primer', 'primero', 'primera', 'segundo', 'segunda', 'ultimo',
  'ultima', 'ultimos', 'ultimas', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'gran', 'grande',
  'grandes',
  // Relleno de redes y de notas
  'nota', 'notas', 'link', 'links', 'bio', 'perfil', 'post', 'posteo', 'reel', 'reels',
  'video', 'videos', 'foto', 'fotos', 'click', 'clic', 'enlace', 'leer', 'lee', 'mira',
  'mirala', 'miralo', 'segui', 'seguinos', 'seguime', 'compartir', 'comparti', 'comenta',
  'comenten', 'info', 'informacion', 'historia', 'historias', 'stories', 'story', 'live',
  'vivo', 'fuente', 'cortesia', 'creditos', 'credito',
  // Interjecciones y muletillas
  'che', 'dale', 'ojo', 'jaja', 'jajaja', 'jajajaja', 'jeje', 'uff', 'ups',
];

// Set de búsqueda: cada palabra, en minúscula y sin tildes (por las dudas,
// aunque la lista ya va así).
const STOPWORDS = new Set(
  LISTA.map((palabra) =>
    palabra
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
  )
);

module.exports = { STOPWORDS };
