// ==========================================================================
// runStatus.js
// --------------------------------------------------------------------------
// Cómo salió una corrida del monitoreo para UNA red, calculado al leer (no
// se guarda): `ok`, `incompleta`, `cortada`, `en curso` o `interrumpida`. Y
// los textos para una persona de lo que falló. Sin dependencias (no carga la
// base), como reachRule.js: lo usan el scheduler (la línea "[ciclo] fin"),
// las rutas (estado de la escucha, inicio, Pipeline) y los scripts.
//
// Hasta noviembre 2026 una corrida con seis de ocho búsquedas caídas
// figuraba "ok": un TIMEOUT o un 502 eran "falló una fuente" y nada lo
// registraba (openspec/changes/ventana-por-fuente). Ahora cada consulta de
// detección deja una fila en monitoring_run_sources (src/db.js) y el estado
// sale de ahí.
//
// Estado de una fuente (monitoring_run_sources.estado):
//   en curso    la consulta está corriendo (o el proceso se cayó en el medio)
//   ok          respondió
//   esperando   se dejó de esperar; su corrida sigue en Apify y se levanta
//               en el ciclo siguiente
//   parcial     Apify cortó la corrida y entró lo que dejó
//   fallo       falló (el motivo dice por qué)
//   recuperada  quedó esperando y un ciclo posterior levantó su resultado
//   perdida     quedó esperando y su corrida ya no está en Apify
//   sin_fuente  quedó esperando y el término ya no está configurado
// ==========================================================================

// Estados de una fuente que dejan la corrida incompleta. `recuperada` también
// (decisión del dueño, 16/11/2026): la corrida no trajo eso cuando corrió.
const ESTADOS_INCOMPLETA = new Set(['fallo', 'esperando', 'parcial', 'recuperada', 'perdida']);

// Tipos de fila que son una fuente de la detección (se cuentan en "N de M").
const TIPOS_FUENTE = new Set(['busqueda', 'cuenta', 'hashtag', 'keyword']);

/**
 * Código corto del motivo de un fallo, a partir del error (o del texto que
 * quedó en apify_calls.error). Nunca tira.
 * @param {Error|string|null|undefined} err
 * @returns {string} TIMEOUT | HTTP_<status> | RED | AUTH_INVALID | QUOTA_EXCEEDED | RATE_LIMITED |
 *   RUN_<estado> | NO_LANZADA | NOT_CONFIGURED | ERROR
 */
function motivoDeFallo(err) {
  if (!err) return 'ERROR';
  const code = typeof err === 'object' ? err.code : null;
  const text = String(typeof err === 'object' ? err.message || '' : err);
  if (code === 'TIMEOUT' || text === 'TIMEOUT' || /timeout de seguridad|se superó la espera/i.test(text)) return 'TIMEOUT';
  if (code === 'QUOTA_EXCEEDED' || text === 'QUOTA_EXCEEDED' || /Monthly usage hard limit exceeded/.test(text)) return 'QUOTA_EXCEEDED';
  if (code === 'NO_LANZADA' || code === 'NOT_CONFIGURED') return code;
  const runStatus = (typeof err === 'object' && err.runStatus) || (/terminó en (FAILED|ABORTED|TIMED-OUT)/.exec(text) || [])[1];
  if (runStatus) return `RUN_${String(runStatus).replace('-', '_')}`;
  if (code === 'AUTH_INVALID') return 'AUTH_INVALID';
  if (code === 'RATE_LIMITED' || /concurrent-runs-limit-exceeded/.test(text)) return 'RATE_LIMITED';
  const status = (typeof err === 'object' && Number(err.status)) || Number((/Apify respondió (\d{3})/.exec(text) || [])[1]);
  if (status === 401 || status === 403) return 'AUTH_INVALID';
  if (status === 429) return 'RATE_LIMITED';
  if (Number.isFinite(status) && status >= 400) return `HTTP_${status}`;
  if ((typeof err === 'object' && (err.network || err.requestTimeout)) || /Error de red|tardó demasiado en responder/i.test(text)) return 'RED';
  return 'ERROR';
}

/** El motivo dicho para una persona (tooltips y listas): "Apify respondió con un error (502)". */
function motivoTexto(motivo) {
  const m = String(motivo || '');
  if (m === 'TIMEOUT') return 'no respondió a tiempo (la búsqueda siguió en Apify)';
  if (/^HTTP_\d+$/.test(m)) return `Apify respondió con un error (${m.slice(5)})`;
  if (m === 'RED') return 'no hubo conexión con Apify';
  if (m === 'AUTH_INVALID') return 'Apify rechazó la clave';
  if (m === 'QUOTA_EXCEEDED') return 'se agotó la cuota de Apify';
  if (m === 'RATE_LIMITED') return 'Apify no aceptó más corridas a la vez';
  if (/^RUN_/.test(m)) return 'Apify cortó la corrida';
  if (m === 'NO_LANZADA') return 'no se llegó a lanzar';
  if (m === 'SIGUE_EN_APIFY') return 'su corrida anterior sigue en Apify';
  if (m === 'INTERRUMPIDA') return 'el servidor se cortó en el medio';
  if (m === 'NOT_CONFIGURED') return 'falta configuración del servidor';
  if (m === 'SIN_BUSQUEDA') return 'el actor configurado no busca por palabra clave';
  if (m === 'SIN_FUENTES') return 'no hay nada configurado para buscar';
  return 'falló';
}

/** El motivo en dos o tres palabras, para la línea del recuadro de progreso: "falló · error 502". */
function motivoCorto(motivo) {
  const m = String(motivo || '');
  if (/^HTTP_\d+$/.test(m)) return `falló · error ${m.slice(5)}`;
  if (m === 'RED') return 'falló · sin conexión';
  if (m === 'AUTH_INVALID') return 'falló · clave rechazada';
  if (m === 'QUOTA_EXCEEDED') return 'falló · sin cuota';
  if (m === 'NO_LANZADA') return 'no se llegó a lanzar';
  if (m === 'SIGUE_EN_APIFY') return 'sigue en Apify';
  return 'falló';
}

/** "búsquedas" si todas las fuentes de la lista son búsquedas (Instagram); si no, "fuentes" (X). */
function sustantivo(fuentes, n = 2) {
  const reales = (fuentes || []).filter((f) => TIPOS_FUENTE.has(f.tipo));
  const soloBusquedas = reales.length === 0 || reales.every((f) => f.tipo === 'busqueda');
  if (soloBusquedas) return n === 1 ? 'búsqueda' : 'búsquedas';
  return n === 1 ? 'fuente' : 'fuentes';
}

/** Cómo se nombra una fuente en un texto: «macri», @cuenta, #hashtag. */
function nombreFuente(f) {
  const fuente = String((f && f.fuente) || '').trim();
  if (!fuente) return 'una fuente';
  if (f.tipo === 'cuenta') return `@${fuente.replace(/^@/, '')}`;
  if (f.tipo === 'hashtag') return `#${fuente.replace(/^#/, '')}`;
  return `«${fuente}»`;
}

/** "«a», «b», «c», «d» y 2 más" (como mucho `max` nombres). */
function listar(nombres, max = 4) {
  const lista = [...new Set(nombres)];
  if (lista.length <= max) {
    if (lista.length <= 1) return lista.join('');
    return `${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
  }
  return `${lista.slice(0, max).join(', ')} y ${lista.length - max} más`;
}

/**
 * Las filas de una corrida para una red, resumidas. Solo cuenta el PRIMER
 * intento de cada fuente para el "N de M"; una segunda consulta (intento 2,
 * por tope lleno) no es otra fuente.
 * @param {Array<object>} fuentes filas de monitoring_run_sources (db.listRunSources)
 * @returns {{ total: number, respondieron: number, fallidas: object[], esperando: object[], parciales: object[],
 *   recuperadas: object[], perdidas: object[], topeLleno: object[], huecos: object[], detalleFallo: object|null,
 *   sinBuscar: string|null, sustantivo: string }}
 */
function contar(fuentes) {
  const filas = Array.isArray(fuentes) ? fuentes : [];
  const reales = filas.filter((f) => TIPOS_FUENTE.has(f.tipo) && (f.intento || 1) === 1);
  const de = (estado) => reales.filter((f) => f.estado === estado);
  const plataforma = filas.find((f) => f.tipo === 'plataforma');
  return {
    total: reales.length,
    respondieron: reales.filter((f) => f.estado === 'ok' || f.estado === 'parcial').length,
    fallidas: de('fallo'),
    esperando: de('esperando'),
    parciales: de('parcial'),
    recuperadas: de('recuperada'),
    perdidas: de('perdida'),
    topeLleno: reales.filter((f) => f.topeLleno),
    huecos: reales.filter((f) => f.huecoDesde),
    detalleFallo: filas.find((f) => f.tipo === 'detalle' && f.estado === 'fallo') || null,
    sinBuscar: plataforma ? plataforma.motivo || 'SIN_FUENTES' : null,
    sustantivo: sustantivo(reales),
  };
}

/**
 * Estado de una corrida para una red.
 * @param {{ id?: number, finishedAt?: string|null, quotaExceeded?: boolean, errorCode?: string|null }} run
 * @param {Array<object>} [fuentes] las filas de esa corrida y esa red
 * @param {{ runIdEnCurso?: number|null }} [options] la fila del ciclo que corre ahora
 * @returns {'en curso'|'interrumpida'|'cortada'|'incompleta'|'ok'}
 */
function estadoCorrida(run, fuentes = [], { runIdEnCurso = null } = {}) {
  if (!run || !run.finishedAt) return run && run.id != null && run.id === runIdEnCurso ? 'en curso' : 'interrumpida';
  if (run.quotaExceeded) return 'cortada';
  if (run.errorCode) return 'incompleta';
  const c = contar(fuentes);
  const incompleta =
    c.sinBuscar != null ||
    c.detalleFallo != null ||
    c.topeLleno.length > 0 ||
    c.huecos.length > 0 ||
    (Array.isArray(fuentes) ? fuentes : []).some((f) => TIPOS_FUENTE.has(f.tipo) && ESTADOS_INCOMPLETA.has(f.estado));
  return incompleta ? 'incompleta' : 'ok';
}

const plural = (n, uno, muchos) => (n === 1 ? uno : muchos);

/**
 * Lo que falló en una corrida, en textos para una persona. `titulo` es la
 * frase principal ("Fallaron 6 de 8 búsquedas"); `nota`, qué pasa con eso
 * ("se retoman solas"); `lineas`, una por fuente con su motivo. null si no
 * hay nada que contar (corrida ok o sin filas).
 * @returns {null | { titulo: string, nota: string, nombres: string, lineas: string[],
 *   fallidas: number, esperando: number, topeLleno: number, total: number }}
 */
function resumenFallidas(fuentes) {
  const c = contar(fuentes);
  const base = { fallidas: c.fallidas.length + c.perdidas.length, esperando: c.esperando.length, topeLleno: c.topeLleno.length, total: c.total };
  if (c.sinBuscar != null) {
    return { ...base, titulo: `No se buscó nada: ${motivoTexto(c.sinBuscar)}`, nota: '', nombres: '', lineas: [] };
  }
  const caidas = [...c.fallidas, ...c.perdidas, ...c.parciales];
  const levantadas = c.recuperadas;
  const lineas = [];
  for (const f of caidas) lineas.push(`${nombreFuente(f)} · ${f.estado === 'perdida' ? 'su corrida ya no está en Apify' : motivoTexto(f.motivo)}`);
  for (const f of c.esperando) lineas.push(`${nombreFuente(f)} · sigue en Apify, se levanta en la próxima corrida`);
  for (const f of levantadas) lineas.push(`${nombreFuente(f)} · ${motivoTexto(f.motivo)} · se levantó después`);
  for (const f of c.topeLleno) lineas.push(`${nombreFuente(f)} · llegó al tope${f.tope ? ` de ${f.tope} resultados` : ''}: puede faltar algo`);
  for (const f of c.huecos) lineas.push(`${nombreFuente(f)} · estuvo demasiado tiempo sin responder: lo anterior a la ventana máxima no se pidió`);
  if (c.detalleFallo) lineas.push('No se pudo pedir el texto de los resultados nuevos');

  const s = (n) => sustantivo(fuentes, n);
  const afectadas = caidas.length + levantadas.length;
  if (afectadas > 0) {
    const todas = [...caidas, ...levantadas];
    return {
      ...base,
      titulo: `${plural(afectadas, 'Falló', 'Fallaron')} ${afectadas} de ${c.total} ${s(c.total)}`,
      nota: levantadas.length === afectadas ? plural(afectadas, 'se levantó después', 'se levantaron después') : plural(afectadas, 'se retoma sola', 'se retoman solas'),
      nombres: listar(todas.map(nombreFuente)),
      lineas,
    };
  }
  if (c.esperando.length > 0) {
    const n = c.esperando.length;
    return {
      ...base,
      titulo: `${n} de ${c.total} ${s(c.total)} ${plural(n, 'sigue', 'siguen')} en Apify`,
      nota: plural(n, 'se levanta sola', 'se levantan solas'),
      nombres: listar(c.esperando.map(nombreFuente)),
      lineas,
    };
  }
  if (c.topeLleno.length > 0) {
    const n = c.topeLleno.length;
    return {
      ...base,
      titulo: n === 1 ? `${nombreFuente(c.topeLleno[0])} llegó al tope${c.topeLleno[0].tope ? ` de ${c.topeLleno[0].tope} resultados` : ''}` : `${n} ${s(n)} llegaron al tope`,
      nota: 'puede faltar algo',
      nombres: listar(c.topeLleno.map(nombreFuente)),
      lineas,
    };
  }
  if (c.huecos.length > 0) {
    const n = c.huecos.length;
    return { ...base, titulo: `${n} ${s(n)} ${plural(n, 'pidió', 'pidieron')} la ventana máxima`, nota: 'quedó un hueco anterior', nombres: listar(c.huecos.map(nombreFuente)), lineas };
  }
  if (c.detalleFallo) {
    return { ...base, titulo: 'No se pudo pedir el texto de los resultados nuevos', nota: 'se reintenta en la próxima corrida', nombres: '', lineas };
  }
  return null;
}

/**
 * Para el log: "fallaron 6 de 8 búsquedas: «macri» HTTP_502, «GCBA» TIMEOUT"
 * (con los códigos, que acá sí sirven). '' si no hay nada que decir.
 */
function resumenParaLog(fuentes) {
  const c = contar(fuentes);
  if (c.sinBuscar != null) return `no se buscó nada (${c.sinBuscar})`;
  const partes = [];
  const caidas = [...c.fallidas, ...c.perdidas, ...c.parciales];
  if (caidas.length > 0) {
    partes.push(
      `${plural(caidas.length, 'falló', 'fallaron')} ${caidas.length} de ${c.total} ${c.sustantivo}: ` +
        caidas.map((f) => `${nombreFuente(f)} ${f.estado === 'perdida' ? 'PERDIDA' : f.estado === 'parcial' ? `PARCIAL(${f.motivo || '?'})` : f.motivo || 'ERROR'}`).join(', ')
    );
  }
  if (c.esperando.length > 0) partes.push(`${c.esperando.length} ${plural(c.esperando.length, 'sigue', 'siguen')} en Apify: ${c.esperando.map(nombreFuente).join(', ')}`);
  if (c.topeLleno.length > 0) partes.push(`tope lleno: ${c.topeLleno.map(nombreFuente).join(', ')}`);
  if (c.huecos.length > 0) partes.push(`hueco por el techo de la ventana: ${c.huecos.map(nombreFuente).join(', ')}`);
  if (c.detalleFallo) partes.push(`falló el detalle (${c.detalleFallo.motivo || 'ERROR'})`);
  return partes.join('; ');
}

module.exports = {
  ESTADOS_INCOMPLETA,
  TIPOS_FUENTE,
  motivoDeFallo,
  motivoTexto,
  motivoCorto,
  sustantivo,
  nombreFuente,
  contar,
  estadoCorrida,
  resumenFallidas,
  resumenParaLog,
};
