// ==========================================================================
// gastos.js
// --------------------------------------------------------------------------
// Qué gastó la app en Apify, corrida por corrida, en tablas de consola:
//   1. por corrida: inicio y fin (hora de Argentina), duración, llamadas,
//      resultados, USD estimado y USD real; una corrida incompleta (alguna
//      búsqueda falló, quedó en Apify o llenó su tope) lleva "~";
//   2. por corrida y fase: búsqueda, detalle, benchmark, refresco, otras;
//   3. por término de búsqueda, su rendimiento en el período: consultas y
//      resultados (de Apify), cuántos eran nuevos, cuántos trajo solo ese
//      término, cuántos se guardaron, cuántos descartó el clasificador y
//      cuántos quedaron sin evaluar (sin texto), con lo que costó en Apify y
//      en el modelo (desde noviembre 2026, search_seen anota todo eso);
//   4. total del período.
// Lee apify_calls y monitoring_runs en data/monitoring.db ABIERTA EN SOLO
// LECTURA: se puede correr con la app andando, nunca escribe ni llama a
// Apify. Período: desde --desde "AAAA-MM-DD HH:MM" (hora de Argentina)
// hasta ahora; sin la opción, las últimas 24 horas. Ninguna tabla pasa de
// 80 columnas, para que no se corte en la consola.
//
//   npm run gastos
//   node scripts/gastos.js --desde "2026-09-25 08:00"
//
// Fases: una llamada con query_type 'search' es "búsqueda" (esté en la fase
// busqueda o, en las corridas viejas, en monitoreo); el resto de la fase
// busqueda es "detalle" (apify/instagram-scraper con las URLs nuevas);
// benchmark y refresco son ellas mismas; todo lo demás (monitoreo,
// validacion, recalc-script, analisis) va a "otras", con la fase real entre
// paréntesis.
//
// USD est. = la columna usd (tarifa del actor al registrar la llamada).
// USD real = usd_real, lo que Apify asentó por run (actor apidojo; se
// concilia al cerrar el ciclo siguiente o con
// node scripts/costo-apify.js --conciliar). El actor oficial cobra por
// resultado y no tiene run por llamada: su estimado ES el cobro y se toma
// como real. Un * al lado del real avisa que a esa fila le faltan llamadas
// por conciliar.
//
// Tabla 3: "nuevos" son los resultados que el monitoreo decidió por primera
// vez en el período (search_seen.first_seen_at) y que ese término trajo
// (search_seen.terminos: todos los términos que trajeron el posteo; en las
// filas anteriores a noviembre 2026, solo el primero). "únicos": los que no
// trajo ningún otro término. El costo del modelo de un posteo que trajeron
// varios términos se reparte entre ellos. "US$ Apify" es el real donde ya se
// concilió y, si no, el estimado.
// ==========================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TZ = 'America/Argentina/Buenos_Aires';
const DAY_MS = 24 * 60 * 60 * 1000;
// Una corrida sin finished_at es "en curso" si es la última y empezó hace
// menos de esto; si no, quedó "sin cierre" (la app se cortó en el medio).
const EN_CURSO_MAX_MS = 3 * 60 * 60 * 1000;
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'monitoring.db');
const OFFICIAL_ACTOR = 'apify~instagram-scraper';
const FASES = ['busqueda', 'detalle', 'benchmark', 'refresco', 'otras'];
const FASE_LABEL = { busqueda: 'búsqueda', detalle: 'detalle', benchmark: 'benchmark', refresco: 'refresco', otras: 'otras' };
const ANCHO_MAX = 80;

const USO = [
  'Uso: node scripts/gastos.js [--desde "AAAA-MM-DD HH:MM"]',
  '  --desde   inicio del período, en hora de Argentina (también vale solo la',
  '            fecha). Sin la opción: las últimas 24 horas.',
].join('\n');

// --------------------------------------------------------------------------
// Hora de Argentina
// --------------------------------------------------------------------------

const partesFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Fecha y hora de un instante (ms UTC) en hora de Argentina. */
function partesArgentina(ms) {
  const p = {};
  for (const { type, value } of partesFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    anio: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
  };
}

/** Instante (ms UTC) de una fecha y hora dadas en hora de Argentina. */
function argentinaAUtc({ anio, mes, dia, hora = 0, minuto = 0 }) {
  const pedido = Date.UTC(anio, mes - 1, dia, hora, minuto, 0, 0);
  let ms = pedido;
  // Dos pasadas por si el desfasaje cambiara en el borde (Argentina no tiene
  // horario de verano desde 2009, pero el cálculo no depende de eso).
  for (let i = 0; i < 2; i += 1) {
    const p = partesArgentina(ms);
    const visto = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo, 0);
    ms += pedido - visto;
  }
  return ms;
}

const dd = (n) => String(n).padStart(2, '0');

/** 'dd/MM HH:mm' en hora de Argentina; '-' sin fecha. */
function fechaHoraCorta(iso) {
  if (!iso) return '-';
  const p = partesArgentina(Date.parse(iso));
  return `${dd(p.dia)}/${dd(p.mes)} ${dd(p.hora)}:${dd(p.minuto)}`;
}

/** 'dd/MM/AAAA HH:mm' en hora de Argentina. */
function fechaHoraLarga(iso) {
  const p = partesArgentina(Date.parse(iso));
  return `${dd(p.dia)}/${dd(p.mes)}/${p.anio} ${dd(p.hora)}:${dd(p.minuto)}`;
}

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------

const DESDE_RE = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\s*$/;

/** "AAAA-MM-DD HH:MM" (o solo la fecha) en hora de Argentina → ISO UTC. Tira si no es una fecha válida. */
function parseDesde(texto) {
  const m = DESDE_RE.exec(String(texto ?? ''));
  if (!m) throw new Error(`--desde inválido: "${texto}". Formato: "AAAA-MM-DD HH:MM" (hora de Argentina).`);
  const pedido = { anio: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]), hora: m[4] ? Number(m[4]) : 0, minuto: m[5] ? Number(m[5]) : 0 };
  const ms = argentinaAUtc(pedido);
  if (!Number.isFinite(ms)) throw new Error(`--desde inválido: "${texto}" no es una fecha que exista.`);
  const p = partesArgentina(ms);
  const coincide = p.anio === pedido.anio && p.mes === pedido.mes && p.dia === pedido.dia && p.hora === pedido.hora && p.minuto === pedido.minuto;
  if (!coincide) throw new Error(`--desde inválido: "${texto}" no es una fecha y hora que exista.`);
  return new Date(ms).toISOString();
}

/**
 * Opciones de la línea de comandos. Sin --desde, el período empieza 24
 * horas antes de `now`.
 * @returns {{ ayuda: boolean, desdeIso?: string, porDefecto?: boolean }}
 */
function parseArgs(argv, now = Date.now()) {
  if (argv.some((a) => a === '--ayuda' || a === '--help' || a === '-h')) return { ayuda: true };
  let desdeTexto = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--desde') {
      if (i + 1 >= argv.length) throw new Error('--desde necesita un valor: "AAAA-MM-DD HH:MM".');
      desdeTexto = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--desde=')) {
      desdeTexto = arg.slice('--desde='.length);
    } else {
      throw new Error(`Opción desconocida: ${arg}`);
    }
  }
  const desdeIso = desdeTexto == null ? new Date(now - DAY_MS).toISOString() : parseDesde(desdeTexto);
  return { ayuda: false, desdeIso, porDefecto: desdeTexto == null };
}

// --------------------------------------------------------------------------
// Lectura y agregación
// --------------------------------------------------------------------------

/** Abre la base en solo lectura (con la app andando no molesta). Tira si no existe. */
function abrirBase(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`No existe la base ${dbPath}. ¿Ya corrió la app alguna vez?`);
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
}

/** Fase del reporte de una fila de apify_calls (ver el encabezado). */
function faseDe(row) {
  if (row.query_type === 'search') return 'busqueda';
  if (row.phase === 'busqueda') return 'detalle';
  if (row.phase === 'benchmark' || row.phase === 'refresco') return row.phase;
  return 'otras';
}

function esOficial(actor) {
  return !actor || actor === OFFICIAL_ACTOR;
}

function nuevoAcumulador() {
  return { calls: 0, failed: 0, results: 0, usdEst: 0, usdReal: 0, usdEstPendiente: 0, pendientes: 0, fases: new Set() };
}

/** Suma una fila de apify_calls al acumulador (llamadas, fallidas, resultados, usd estimado y real, pendientes de conciliar). */
function acumular(a, row) {
  a.calls += 1;
  if (!row.ok) a.failed += 1;
  a.results += Number(row.items) || 0;
  a.usdEst += Number(row.usd) || 0;
  if (row.usd_real != null) a.usdReal += Number(row.usd_real) || 0;
  else if (esOficial(row.actor)) a.usdReal += Number(row.usd) || 0;
  else if (row.ok || row.apify_run_id) {
    a.pendientes += 1;
    a.usdEstPendiente += Number(row.usd) || 0;
  }
  a.fases.add(row.phase);
  return a;
}

/** Deja el acumulador como objeto plano (fases ordenadas). */
function cerrar(a) {
  return { ...a, fases: [...a.fases].sort() };
}

function cerrarPorFase(porFase) {
  const out = {};
  for (const fase of FASES) if (porFase[fase]) out[fase] = cerrar(porFase[fase]);
  return out;
}

function duracionDe(startedAt, finishedAt, { esUltima, now }) {
  if (!finishedAt) return esUltima && now - Date.parse(startedAt) < EN_CURSO_MAX_MS ? 'en curso' : 'sin cierre';
  const s = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${dd(m % 60)} min`;
}

const COLUMNAS_LLAMADA = 'c.run_id, c.phase, c.query_type, c.actor, c.target, c.items, c.ok, c.error, c.usd, c.usd_real, c.apify_run_id';

/** La clave de un término: sin espacios de más y en minúsculas (como la config). */
const claveTermino = (t) => String(t ?? '').trim().toLowerCase();

function columnasDe(db, tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}

/**
 * Lo que decidió el monitoreo sobre los resultados de búsqueda vistos por
 * primera vez desde `desdeIso`, por término (ver el encabezado). Con una
 * base anterior a noviembre 2026 (sin las columnas nuevas de search_seen)
 * devuelve `completo: false`: solo se sabe el primer término de cada posteo
 * y no hay costo del modelo.
 * @returns {{ porTermino: Map<string, object>, completo: boolean, total: object }}
 */
function leerRendimiento(db, desdeIso) {
  const vacio = () => ({ nuevos: 0, unicos: 0, guardados: 0, descartados: 0, sinEvaluar: 0, usdModelo: 0, conCosto: 0 });
  const porTermino = new Map();
  const total = vacio();
  let columnas = [];
  try {
    columnas = columnasDe(db, 'search_seen');
  } catch {
    columnas = [];
  }
  if (!columnas.includes('first_seen_at')) return { porTermino, completo: false, total };
  const completo = columnas.includes('terminos') && columnas.includes('llm_usd');
  const filas = db
    .prepare(`SELECT term, outcome${completo ? ', terminos, llm_usd' : ''} FROM search_seen WHERE first_seen_at >= ?`)
    .all(desdeIso);
  const sumar = (a, fila, parte, unico) => {
    a.nuevos += 1;
    if (unico) a.unicos += 1;
    if (fila.outcome === 'guardado') a.guardados += 1;
    else if (fila.outcome === 'descartado') a.descartados += 1;
    else a.sinEvaluar += 1;
    if (fila.llm_usd != null) {
      a.usdModelo += Number(fila.llm_usd) * parte;
      a.conCosto += parte;
    }
  };
  for (const fila of filas) {
    let terminos = [];
    if (completo && fila.terminos) {
      try {
        const lista = JSON.parse(fila.terminos);
        if (Array.isArray(lista)) terminos = lista;
      } catch {
        terminos = [];
      }
    }
    if (terminos.length === 0 && fila.term) terminos = [fila.term];
    const claves = [...new Set(terminos.map(claveTermino).filter(Boolean))];
    sumar(total, fila, 1, claves.length === 1);
    for (const clave of claves) {
      if (!porTermino.has(clave)) porTermino.set(clave, vacio());
      sumar(porTermino.get(clave), fila, 1 / claves.length, claves.length === 1);
    }
  }
  return { porTermino, completo, total };
}

/**
 * Las corridas incompletas entre las del reporte: alguna fuente falló, quedó
 * esperando en Apify, llenó su tope… (src/runStatus.js, la misma regla que
 * la pantalla). Con una base sin la tabla de fuentes, ninguna.
 * @returns {Set<number>}
 */
function corridasIncompletas(db, runs) {
  const incompletas = new Set();
  if (runs.length === 0) return incompletas;
  let filas = [];
  try {
    if (columnasDe(db, 'monitoring_run_sources').length === 0) return incompletas;
    const ids = runs.map((r) => Number(r.id)).filter(Number.isFinite);
    filas = db
      .prepare(`SELECT run_id, plataforma, tipo, estado, intento, motivo, tope_lleno, hueco_desde FROM monitoring_run_sources WHERE run_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
  } catch {
    return incompletas;
  }
  const { estadoCorrida } = require('../src/runStatus');
  const porCorridaYRed = new Map();
  for (const f of filas) {
    const key = `${f.run_id}|${f.plataforma}`;
    if (!porCorridaYRed.has(key)) porCorridaYRed.set(key, []);
    porCorridaYRed.get(key).push({ tipo: f.tipo, estado: f.estado, intento: f.intento, motivo: f.motivo, topeLleno: Boolean(f.tope_lleno), huecoDesde: f.hueco_desde });
  }
  const porId = new Map(runs.map((r) => [Number(r.id), r]));
  for (const [key, fuentes] of porCorridaYRed) {
    const id = Number(key.split('|')[0]);
    const run = porId.get(id);
    if (!run || !run.finished_at) continue;
    // La cuota tiene su propia marca ("!"): acá solo lo incompleto.
    if (estadoCorrida({ id, finishedAt: run.finished_at, quotaExceeded: false, errorCode: run.error_code || null }, fuentes) === 'incompleta') incompletas.add(id);
  }
  for (const run of runs) if (run.finished_at && run.error_code) incompletas.add(Number(run.id));
  return incompletas;
}

/**
 * Arma el reporte. Corridas = monitoring_runs iniciadas desde `desdeIso`,
 * con TODAS sus llamadas; términos y total = llamadas con `at` desde
 * `desdeIso` (por eso el total puede incluir llamadas sin corrida o de una
 * corrida iniciada antes: se informan aparte).
 * @param {{ dbPath?: string, desdeIso: string, now?: number, porDefecto?: boolean }} options
 */
function buildReport({ dbPath = process.env.MONITORING_DB_PATH || DEFAULT_DB_PATH, desdeIso, now = Date.now(), porDefecto = false }) {
  const db = abrirBase(dbPath);
  try {
    const ultimoId = db.prepare('SELECT MAX(id) AS id FROM monitoring_runs').get().id;
    const conErrorCode = columnasDe(db, 'monitoring_runs').includes('error_code');
    const runs = db
      .prepare(
        `SELECT id, started_at, finished_at, "trigger", plataforma, new_posts, quota_exceeded${conErrorCode ? ', error_code' : ''} FROM monitoring_runs WHERE started_at >= ? ORDER BY id`
      )
      .all(desdeIso);
    const incompletas = corridasIncompletas(db, runs);
    const corridas = new Map();
    for (const r of runs) {
      corridas.set(r.id, {
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        trigger: r.trigger,
        plataforma: r.plataforma,
        newPosts: Number(r.new_posts) || 0,
        quotaExceeded: Boolean(r.quota_exceeded),
        incompleta: incompletas.has(Number(r.id)),
        duracion: duracionDe(r.started_at, r.finished_at, { esUltima: r.id === ultimoId, now }),
        ...nuevoAcumulador(),
        porFase: {},
      });
    }
    const llamadasDeCorridas = db
      .prepare(`SELECT ${COLUMNAS_LLAMADA} FROM apify_calls c JOIN monitoring_runs r ON r.id = c.run_id WHERE r.started_at >= ? ORDER BY c.id`)
      .all(desdeIso);
    for (const row of llamadasDeCorridas) {
      const c = corridas.get(row.run_id);
      if (!c) continue;
      acumular(c, row);
      const fase = faseDe(row);
      acumular(c.porFase[fase] || (c.porFase[fase] = nuevoAcumulador()), row);
    }

    const total = { ...nuevoAcumulador(), porFase: {} };
    const fueraDeCorridas = nuevoAcumulador();
    const deCorridasPrevias = nuevoAcumulador();
    const terminos = new Map();
    const llamadasDelPeriodo = db
      .prepare(
        `SELECT ${COLUMNAS_LLAMADA}, r.started_at AS run_started_at FROM apify_calls c LEFT JOIN monitoring_runs r ON r.id = c.run_id WHERE c.at >= ? ORDER BY c.id`
      )
      .all(desdeIso);
    for (const row of llamadasDelPeriodo) {
      acumular(total, row);
      const fase = faseDe(row);
      acumular(total.porFase[fase] || (total.porFase[fase] = nuevoAcumulador()), row);
      if (row.run_id == null) acumular(fueraDeCorridas, row);
      else if (row.run_started_at != null && row.run_started_at < desdeIso) acumular(deCorridasPrevias, row);
      if (row.query_type === 'search') {
        // Por la clave normalizada: "GCBA" y "gcba" son el mismo término. Se
        // muestra como se escribió la última vez.
        const termino = String(row.target || '').trim() || '(sin término)';
        const clave = claveTermino(termino);
        if (!terminos.has(clave)) terminos.set(clave, { termino, clave, ...nuevoAcumulador() });
        terminos.get(clave).termino = termino;
        acumular(terminos.get(clave), row);
      }
    }
    // El rendimiento de cada término (lo que decidió el monitoreo). Un
    // término con decisiones pero sin consultas en el período también sale.
    const rendimiento = leerRendimiento(db, desdeIso);
    for (const clave of rendimiento.porTermino.keys()) {
      if (!terminos.has(clave)) terminos.set(clave, { termino: clave, clave, ...nuevoAcumulador() });
    }
    const sinRendimiento = { nuevos: 0, unicos: 0, guardados: 0, descartados: 0, sinEvaluar: 0, usdModelo: 0, conCosto: 0 };

    return {
      dbPath,
      desdeIso,
      hastaIso: new Date(now).toISOString(),
      porDefecto,
      corridas: [...corridas.values()].map((c) => ({ ...cerrar(c), porFase: cerrarPorFase(c.porFase) })),
      terminos: [...terminos.values()]
        .map((t) => ({ ...cerrar(t), ...(rendimiento.porTermino.get(t.clave) || sinRendimiento) }))
        .sort((a, b) => b.usdEst - a.usdEst || b.calls - a.calls || b.nuevos - a.nuevos || a.termino.localeCompare(b.termino)),
      rendimiento: { completo: rendimiento.completo, total: rendimiento.total },
      total: { ...cerrar(total), porFase: cerrarPorFase(total.porFase) },
      fueraDeCorridas: cerrar(fueraDeCorridas),
      deCorridasPrevias: cerrar(deCorridasPrevias),
    };
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------------
// Tablas
// --------------------------------------------------------------------------

const celda = (texto, ancho, derecha = false) => (derecha ? String(texto).padStart(ancho) : String(texto).padEnd(ancho));
const usd = (n) => (Number(n) || 0).toFixed(3);
const usdReal = (a) => usd(a.usdReal) + (a.pendientes > 0 ? '*' : '');
// Lo mejor que se sabe del costo en Apify: lo real de las llamadas ya
// conciliadas más el estimado de las que faltan.
const mejorUsd = (a) => (Number(a.usdReal) || 0) + (Number(a.usdEstPendiente) || 0);

function recortar(texto, ancho) {
  const t = String(texto);
  return t.length <= ancho ? t : `${t.slice(0, ancho - 1)}…`;
}

function filaNumeros(a) {
  return celda(a.calls, 6, true) + celda(a.results, 9, true) + celda(usd(a.usdEst), 10, true) + celda(usdReal(a), 10, true);
}

const ENCABEZADO_NUMEROS = celda('llam.', 6, true) + celda('result.', 9, true) + celda('USD est.', 10, true) + celda('USD real', 10, true);

/** Tabla de fases (la usan la 2 y la 4): una fila por fase con llamadas y una de total. */
function filasPorFase(porFase, total, sangria) {
  const pad = ' '.repeat(sangria);
  const out = [pad + celda('fase', 32) + ENCABEZADO_NUMEROS];
  for (const fase of FASES) {
    const a = porFase[fase];
    if (!a || a.calls === 0) continue;
    const label = fase === 'otras' ? `otras (${a.fases.join(', ')})` : FASE_LABEL[fase];
    out.push(pad + celda(recortar(label, 32), 32) + filaNumeros(a));
  }
  out.push(pad + celda('total', 32) + filaNumeros(total));
  return out;
}

function tablaCorridas(r) {
  const out = ['== 1. Por corrida'];
  if (r.corridas.length === 0) {
    out.push('  (sin corridas en el período)');
    return out;
  }
  out.push('  ' + celda('#', 6) + celda('inicio', 12) + celda('fin', 12) + celda('durac.', 11) + ENCABEZADO_NUMEROS);
  const suma = nuevoAcumulador();
  let manuales = 0;
  let conCuota = 0;
  let incompletas = 0;
  for (const c of r.corridas) {
    if (c.trigger !== 'cron') manuales += 1;
    if (c.quotaExceeded) conCuota += 1;
    if (c.incompleta) incompletas += 1;
    const marca = `#${c.id}${c.trigger === 'cron' ? '' : '*'}${c.quotaExceeded ? '!' : ''}${c.incompleta ? '~' : ''}`;
    out.push(
      '  ' +
        celda(marca, 6) +
        celda(fechaHoraCorta(c.startedAt), 12) +
        celda(c.finishedAt ? fechaHoraCorta(c.finishedAt) : '-', 12) +
        celda(c.duracion, 11) +
        filaNumeros(c)
    );
    suma.calls += c.calls;
    suma.failed += c.failed;
    suma.results += c.results;
    suma.usdEst += c.usdEst;
    suma.usdReal += c.usdReal;
    suma.usdEstPendiente += c.usdEstPendiente;
    suma.pendientes += c.pendientes;
  }
  out.push('  ' + celda('total', 41) + filaNumeros(suma));
  if (manuales > 0) out.push('  * = corrida manual ("Actualizar ahora")');
  if (conCuota > 0) out.push('  ! = alguna llamada cortó por la cuota de Apify');
  if (incompletas > 0) out.push('  ~ = alguna búsqueda falló o llegó al tope (corrida incompleta)');
  return out;
}

function tablaCorridasPorFase(r) {
  const out = ['== 2. Por corrida y fase'];
  if (r.corridas.length === 0) {
    out.push('  (sin corridas en el período)');
    return out;
  }
  r.corridas.forEach((c, i) => {
    const fin = c.finishedAt ? fechaHoraCorta(c.finishedAt) : c.duracion;
    out.push(`  #${c.id}  ${fechaHoraCorta(c.startedAt)} → ${fin} · ${c.trigger} · ${c.plataforma} · ${c.newPosts} posteos nuevos`);
    if (c.calls === 0) out.push('      (sin llamadas registradas)');
    else out.push(...filasPorFase(c.porFase, c, 6));
    if (i < r.corridas.length - 1) out.push('');
  });
  return out;
}

function tablaTerminos(r) {
  const out = ['== 3. Por término de búsqueda'];
  if (r.terminos.length === 0) {
    out.push('  (sin búsquedas en el período)');
    return out;
  }
  // 80 columnas: término 15 + ocho números + dos de dólares.
  const fila = (nombre, a, d) =>
    '  ' +
    celda(nombre, 15) +
    celda(a.calls, 6, true) +
    celda(a.results, 7, true) +
    celda(d.nuevos, 7, true) +
    celda(d.unicos, 7, true) +
    celda(d.guardados, 7, true) +
    celda(d.descartados, 7, true) +
    celda(d.sinEvaluar, 6, true) +
    celda(usd(mejorUsd(a)) + (a.pendientes > 0 ? '*' : ''), 8, true) +
    celda(d.conCosto > 0 ? usd(d.usdModelo) : '-', 8, true);
  out.push(
    '  ' +
      celda('término', 15) +
      celda('cons.', 6, true) +
      celda('result.', 7, true) +
      celda('nuevos', 7, true) +
      celda('únicos', 7, true) +
      celda('guard.', 7, true) +
      celda('desc.', 7, true) +
      celda('s/ev.', 6, true) +
      celda('Apify', 8, true) +
      celda('modelo', 8, true)
  );
  for (const t of r.terminos) out.push(fila(recortar(t.termino, 14), t, t));
  out.push(fila(`total (${r.terminos.length})`, r.total.porFase.busqueda || nuevoAcumulador(), r.rendimiento.total));
  out.push('  cons. = consultas · guard. = guardados · desc. = descartados por el modelo');
  out.push('  s/ev. = sin evaluar (sin texto) · Apify y modelo, en US$');
  if (!r.rendimiento.completo) {
    out.push('  Base anterior a noviembre 2026: nuevos, guardados y descartados salen solo');
    out.push('  del primer término de cada posteo, y no hay costo del modelo.');
  }
  return out;
}

function tablaTotal(r) {
  const t = r.total;
  const out = ['== 4. Total del período'];
  const cron = r.corridas.filter((c) => c.trigger === 'cron').length;
  const posteos = r.corridas.reduce((s, c) => s + c.newPosts, 0);
  out.push(`  corridas: ${r.corridas.length} (${cron} cron, ${r.corridas.length - cron} manuales) · posteos nuevos: ${posteos}`);
  out.push(`  llamadas: ${t.calls} (${t.failed} fallidas) · resultados: ${t.results}`);
  out.push(`  USD estimado: ${usd(t.usdEst)} · USD real: ${usdReal(t)}` + (t.pendientes > 0 ? ` (${t.pendientes} llamadas sin conciliar)` : ''));
  if (t.calls > 0) out.push(...filasPorFase(t.porFase, t, 2));
  const f = r.fueraDeCorridas;
  if (f.calls > 0) out.push(`  fuera de corridas: ${f.calls} llamadas (${f.fases.join(', ')}) ≈ ${usd(f.usdEst)} USD est.`);
  const p = r.deCorridasPrevias;
  if (p.calls > 0) out.push(`  de corridas iniciadas antes del período: ${p.calls} llamadas ≈ ${usd(p.usdEst)} USD est.`);
  return out;
}

const NOTAS = [
  'Notas: USD est. = tarifa del actor al registrar la llamada. USD real = lo que',
  'Apify asentó por run (actor apidojo); el detalle (apify/instagram-scraper) se',
  'cobra por resultado y sin run por llamada, así que su estimado vale como real.',
  '* = a esa fila le faltan llamadas por conciliar (se concilia al cerrar el',
  'ciclo siguiente o con: node scripts/costo-apify.js --conciliar).',
];

/** Todas las líneas del reporte, listas para imprimir. */
function render(r) {
  const rel = path.relative(process.cwd(), r.dbPath) || r.dbPath;
  return [
    'Gasto en Apify por corrida (horas de Argentina)',
    `Período: ${fechaHoraLarga(r.desdeIso)} → ${fechaHoraLarga(r.hastaIso)}${r.porDefecto ? ' (últimas 24 horas)' : ''}`,
    `Base: ${rel} (solo lectura)`,
    '',
    ...tablaCorridas(r),
    '',
    ...tablaCorridasPorFase(r),
    '',
    ...tablaTerminos(r),
    '',
    ...tablaTotal(r),
    '',
    ...NOTAS,
  ];
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  require('dotenv').config();
  let opciones;
  try {
    opciones = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USO);
    process.exit(1);
  }
  if (opciones.ayuda) {
    console.log(USO);
    return;
  }
  const report = buildReport({ desdeIso: opciones.desdeIso, porDefecto: opciones.porDefecto });
  console.log(render(report).join('\n'));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  TZ,
  FASES,
  ANCHO_MAX,
  USO,
  partesArgentina,
  argentinaAUtc,
  fechaHoraCorta,
  fechaHoraLarga,
  parseDesde,
  parseArgs,
  abrirBase,
  faseDe,
  leerRendimiento,
  buildReport,
  render,
};
