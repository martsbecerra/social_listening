// ==========================================================================
// analysisTemas.js — Editar los temas de un análisis v2 (fase F).
// --------------------------------------------------------------------------
// Los temas los define el modelo (la primera tanda) y cada comentario guarda
// el id del suyo. El equipo puede:
//   - renombrar uno; si el nombre nuevo es el de otro tema del modelo, se
//     unen (unidoA: sus comentarios cuentan en el otro, sin reescribirlos);
//   - agregar uno a mano, sin conteo, con un texto que entra en el informe;
//   - quitar uno agregado a mano (uno del modelo no: sus comentarios
//     quedarían sin tema).
// Puro: recibe la lista y devuelve la lista nueva, o tira con userMessage.
// La usa PATCH /api/analisis/:id/temas (src/analysisRoutes.js), que también
// traduce el pedido viejo de la solapa de la fase E (la lista entera) con
// traducirListaVieja.
// ==========================================================================

const { claveTema } = require('./analysisMetrics');

const MAX_NOMBRE = 60;
const MAX_TEXTO = 1000;
const MAX_MANUALES = 8;

function errorDeDatos(mensaje) {
  const e = new Error(mensaje);
  e.userMessage = mensaje;
  e.status = 400;
  return e;
}

function nombreValido(raw) {
  const nombre = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!nombre) throw errorDeDatos('Poné un nombre para el tema.');
  if (nombre.length > MAX_NOMBRE) throw errorDeDatos(`El nombre puede tener hasta ${MAX_NOMBRE} caracteres.`);
  return nombre;
}

function textoValido(raw) {
  const texto = typeof raw === 'string' ? raw.trim() : '';
  if (texto.length > MAX_TEXTO) throw errorDeDatos(`El texto puede tener hasta ${MAX_TEXTO} caracteres.`);
  return texto || null;
}

/** Los que están a la vista (los unidos a otro, no). */
function vigentes(lista) {
  const ids = new Set(lista.map((t) => t.id));
  return lista.filter((t) => !Number.isInteger(t.unidoA) || !ids.has(t.unidoA));
}

/**
 * Aplica un cambio a los temas v2.
 * @param {{ version: 2, lista: Array }} temas
 * @param {{ accion: 'renombrar'|'agregar'|'quitar', id?: number, nombre?: string, texto?: string }} cambio
 * @returns {{ version: 2, lista: Array }} la lista nueva (no toca la de entrada)
 */
function aplicarCambio(temas, cambio) {
  const lista = (temas && Array.isArray(temas.lista) ? temas.lista : []).map((t) => ({ ...t }));
  const accion = cambio && cambio.accion;
  const porId = (id) => vigentes(lista).find((t) => t.id === Number(id));

  if (accion === 'renombrar') {
    const tema = porId(cambio.id);
    if (!tema) throw errorDeDatos('Ese tema no existe.');
    const nombre = nombreValido(cambio.nombre);
    if (!tema.manual && typeof cambio.texto === 'string' && cambio.texto.trim()) {
      throw errorDeDatos('Los temas del modelo no llevan texto: el informe los nombra con su cantidad de comentarios.');
    }
    const otro = vigentes(lista).find((t) => t.id !== tema.id && claveTema(t.nombre) === claveTema(nombre));
    if (otro && (otro.manual || tema.manual)) throw errorDeDatos('Ya hay un tema agregado a mano con ese nombre.');
    if (otro) tema.unidoA = otro.id; // se unen: cuenta en el que ya existía
    else tema.nombre = nombre;
    if (tema.manual && cambio.texto !== undefined) tema.texto = textoValido(cambio.texto);
    return { version: 2, lista };
  }
  if (accion === 'agregar') {
    const nombre = nombreValido(cambio.nombre);
    if (vigentes(lista).some((t) => claveTema(t.nombre) === claveTema(nombre))) throw errorDeDatos('Ya hay un tema con ese nombre.');
    if (lista.filter((t) => t.manual).length >= MAX_MANUALES) throw errorDeDatos(`Se pueden agregar hasta ${MAX_MANUALES} temas a mano.`);
    const id = lista.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    lista.push({ id, nombre, manual: true, texto: textoValido(cambio.texto) });
    return { version: 2, lista };
  }
  if (accion === 'quitar') {
    const tema = porId(cambio.id);
    if (!tema) throw errorDeDatos('Ese tema no existe.');
    if (!tema.manual) throw errorDeDatos('Un tema del modelo no se puede quitar: renombralo o unilo a otro.');
    return { version: 2, lista: lista.filter((t) => t.id !== tema.id) };
  }
  throw errorDeDatos('El cambio tiene que ser renombrar, agregar o quitar.');
}

/**
 * La solapa de la fase E manda la lista entera ({ titulo, texto }), en el
 * orden en que la recibió, con UN cambio: un título distinto (renombrar),
 * uno más al final (agregar) o uno menos (quitar). Devuelve ese cambio.
 * @param {Array<{ id: number, titulo: string }>} actual la lista que le mandó la ruta (mismo orden)
 * @param {Array<{ titulo?: string, texto?: string }>} nueva
 */
function traducirListaVieja(actual, nueva) {
  if (!Array.isArray(nueva)) throw errorDeDatos('Los temas tienen que ser una lista.');
  if (nueva.length === actual.length + 1) {
    const ultimo = nueva[nueva.length - 1] || {};
    return { accion: 'agregar', nombre: ultimo.titulo, texto: ultimo.texto };
  }
  if (nueva.length === actual.length - 1) {
    const quedan = new Set(nueva.map((t) => t && t.titulo));
    const ido = actual.find((t) => !quedan.has(t.titulo));
    if (!ido) throw errorDeDatos('No se entendió qué tema se quitó.');
    return { accion: 'quitar', id: ido.id };
  }
  if (nueva.length === actual.length) {
    const i = actual.findIndex((t, k) => (nueva[k] && nueva[k].titulo) !== t.titulo || ((nueva[k] && nueva[k].texto) || '') !== (t.texto || ''));
    if (i < 0) return null;
    return { accion: 'renombrar', id: actual[i].id, nombre: nueva[i].titulo, texto: nueva[i].texto };
  }
  throw errorDeDatos('Cambiá un tema por vez.');
}

module.exports = { aplicarCambio, traducirListaVieja, MAX_MANUALES };
