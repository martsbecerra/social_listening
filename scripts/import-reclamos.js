// ==========================================================================
// import-reclamos.js
// --------------------------------------------------------------------------
// Importador genérico de reclamos desde .xlsx o .csv. Reemplaza al viejo
// import-reclamos-excel.js, que estaba hecho a medida de un archivo puntual
// y tenía la categoría hardcodeada.
//
//   node scripts/import-reclamos.js data/import/<archivo> [opciones]
//
//   --dry-run        procesa y muestra el resultado sin escribir en la base
//   --limit N        procesa sólo las primeras N filas (para probar barato)
//   --si             no pide confirmación (para correr desatendido)
//   --map campo=Col  fuerza el mapeo de una columna (repetible)
//
// Qué hace con cada fila:
//   1. Repara el encoding del texto (mojibake de CP1252).
//   2. Mapea la categoría del archivo al esquema nuevo (alias en categoriasConfig).
//   3. Le pregunta al LLM si el TEXTO tiene una ubicación accionable.
//   4. Le pide la subcategoría, agrupando por categoría.
//   5. Usa las coordenadas del archivo si son válidas; si no, deja la fila en
//      'pendiente' para que la geocodifique el worker de siempre.
//
// Las filas SIN ubicación accionable NO se descartan: entran con
// geo_status 'sin_direccion'. Sirven para estadística aunque no vayan al mapa.
// ==========================================================================

// Sin esto el script no ve LLM_PROVIDER ni las claves: caería en el proveedor
// por defecto y fallaría en la primera llamada. server.js lo hace por su lado.
require('dotenv').config();

const path = require('path');
const readline = require('readline');

const tabla = require('../src/importers/tabla');
const { parsearFecha } = require('../src/importers/fechas');
const { extraerUbicaciones, sumarUsage } = require('../src/importers/extraerDireccion');
const { asignarSubcategorias } = require('../src/clasificarReclamo');
const { geocodeAddress } = require('../src/geocode');
const { ubicarPunto } = require('../src/territorios');
const { normalizeClasificacion } = require('../src/categoriasConfig');
const { getLlmProvider, getClassifierModel } = require('../src/llm/providerConfig');
const db = require('../src/db');

// Precio del modelo clasificador en OpenRouter (USD por millón de tokens).
// Sólo se usa para la estimación previa; el costo real sale de la API.
const PRECIO_ESTIMADO = { inputPorMTok: 1, outputPorMTok: 5 };

// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, limit: null, muestra: null, si: false, map: {}, archivo: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--si' || a === '--yes') opts.si = true;
    else if (a === '--limit') opts.limit = Number(args[++i]);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length));
    else if (a === '--muestra') opts.muestra = Number(args[++i]);
    else if (a.startsWith('--muestra=')) opts.muestra = Number(a.slice('--muestra='.length));
    else if (a === '--map') {
      const [campo, ...resto] = String(args[++i] || '').split('=');
      if (campo && resto.length) opts.map[campo.trim()] = resto.join('=').trim();
    } else if (!a.startsWith('--')) opts.archivo = a;
  }
  return opts;
}

function uso() {
  console.error('Uso: node scripts/import-reclamos.js <archivo.xlsx|csv> [--dry-run] [--limit N] [--muestra N] [--si] [--map campo=Columna]');
  console.error('  --muestra N  toma N filas VALIDAS (con direccion accionable) por cada categoria del archivo');
}

async function confirmar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const respuesta = await new Promise((resolve) => rl.question(pregunta, resolve));
  rl.close();
  return /^s(i|í)?$/i.test(String(respuesta).trim());
}

/** Id estable: link + dirección + categoría. Ver el comentario en el README. */
function construirId(link, direccion, categoria, indice) {
  const base = [link || '', direccion || '', categoria || ''].join('|');
  if (link) return `import:${base}`;
  // Sin link no hay identidad natural: se usa la posición en el archivo, que
  // al menos es estable si se reimporta el MISMO archivo.
  return `import:fila${indice}|${base}`;
}

function pct(n, total) {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

// --------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.archivo) {
    uso();
    process.exit(1);
  }

  const filePath = path.resolve(opts.archivo);
  console.log(`\nArchivo: ${filePath}`);

  // --- 1. Leer y mapear columnas ---
  const { columnas, filas: todas, hoja } = tabla.leerTabla(filePath);
  console.log(`Hoja "${hoja}": ${todas.length} filas, ${columnas.length} columnas.`);

  const { mapeo, faltan } = tabla.detectarColumnas(columnas, opts.map);
  console.log('\nMapeo de columnas:');
  for (const [campo, col] of Object.entries(mapeo)) {
    console.log(`  ${campo.padEnd(11)} -> ${col || '(no encontrada)'}`);
  }

  if (faltan.length > 0) {
    console.error(`\n❌ No se encontraron columnas para: ${faltan.join(', ')}`);
    console.error('\n   Columnas disponibles en el archivo:');
    columnas.forEach((c) => console.error(`     ${c}`));
    console.error('\n   Indicá el mapeo a mano y volvé a correr, por ejemplo:');
    console.error(`     --map ${faltan[0]}="${columnas[0]}"`);
    console.error('\n   No se escribió nada.\n');
    process.exit(1);
  }

  const filas = opts.limit && opts.limit > 0 ? todas.slice(0, opts.limit) : todas;
  if (filas.length !== todas.length) {
    console.log(`\n--limit ${opts.limit}: se procesan las primeras ${filas.length} filas.`);
  }

  // --- 2. Encoding ---
  const textosCrudos = filas.map((f) => f[mapeo.texto]);
  const diag = tabla.diagnosticarEncoding(textosCrudos);
  console.log('\nEncoding:');
  if (diag.afectados === 0) {
    console.log('  sin mojibake detectado.');
  } else {
    console.log(`  ${diag.afectados} textos con mojibake, ${diag.reparables} reparables.`);
    if (diag.ejemplos[0]) {
      console.log(`    antes:   ${diag.ejemplos[0].antes}`);
      console.log(`    después: ${diag.ejemplos[0].despues}`);
    }
    const noReparables = diag.afectados - diag.reparables;
    if (noReparables > 0) {
      const ratio = noReparables / diag.afectados;
      console.log(`  ⚠️  ${noReparables} no se pueden reparar de forma confiable.`);
      if (ratio > 0.1) {
        console.error(
          `\n❌ Más del 10% del texto dañado no es reparable (${pct(noReparables, diag.afectados)}).` +
          '\n   Importar texto corrupto significa clasificarlo mal y que quede mal para siempre.' +
          '\n   Revisá cómo se exportó el archivo. No se escribió nada.\n'
        );
        process.exit(1);
      }
      console.log('     Esos textos se importan como vinieron (son pocos).');
    }
  }

  // --- 3. Preparar filas ---
  const anioPorDefecto = new Date().getUTCFullYear();
  const preparadas = [];
  let sinTexto = 0;

  filas.forEach((f, i) => {
    const crudo = f[mapeo.texto];
    const texto = tabla.pareceMojibake(crudo) ? tabla.repararMojibake(crudo) || String(crudo) : String(crudo || '');
    if (!texto.trim()) {
      sinTexto += 1;
      return;
    }

    const catCruda = mapeo.categoria ? f[mapeo.categoria] : null;
    const { categoria } = normalizeClasificacion({ categoria: catCruda, contexto: `fila ${i + 1}` });

    const fecha = parsearFecha(mapeo.fecha ? f[mapeo.fecha] : null, { anioPorDefecto });
    const coords = mapeo.x && mapeo.y ? tabla.parsearCoordenadas(f[mapeo.x], f[mapeo.y]) : null;
    const pista = mapeo.direccion ? String(f[mapeo.direccion] || '').trim() : '';

    preparadas.push({
      indice: i + 1,
      texto,
      pista: pista && pista !== 'NULL' ? pista : '',
      categoriaCruda: catCruda,
      categoria,
      link: mapeo.link ? String(f[mapeo.link] || '').trim() : '',
      autor: mapeo.autor ? String(f[mapeo.autor] || '').trim() : '',
      comuna: mapeo.comuna != null && f[mapeo.comuna] != null ? Number(f[mapeo.comuna]) : null,
      fecha: fecha ? fecha.fecha : null,
      precisionFecha: fecha ? fecha.precision : null,
      coords,
    });
  });

  if (sinTexto > 0) console.log(`\n${sinTexto} filas sin texto, se saltean.`);

  // --- 4. Estimación de costo ---
  const provider = getLlmProvider();
  const modelo = getClassifierModel(provider);
  // Categorías presentes en el archivo, ya unificadas por los alias. El
  // histórico de X trae 4 valores crudos pero dos son la misma categoría mal
  // escrita, así que acá quedan 3.
  const categoriasPresentes = [...new Set(preparadas.map((p) => p.categoria))];
  console.log(`\nCategorías presentes (ya unificadas): ${categoriasPresentes.join(' | ')}`);

  const modoMuestra = Number.isFinite(opts.muestra) && opts.muestra > 0;
  const TOPE_POR_CATEGORIA = modoMuestra ? opts.muestra * 5 : Infinity;

  // Cuántas filas se van a evaluar con el LLM. En modo muestra no se sabe de
  // antemano: depende de cuántas filas haya que descartar para juntar las N
  // válidas de cada categoría, así que se estima el piso y el techo.
  const aEvaluarMin = modoMuestra
    ? categoriasPresentes.length * opts.muestra
    : preparadas.length;
  const aEvaluarMax = modoMuestra
    ? categoriasPresentes.reduce(
        (n, c) => n + Math.min(TOPE_POR_CATEGORIA, preparadas.filter((p) => p.categoria === c).length),
        0
      )
    : preparadas.length;

  const charsProm =
    preparadas.reduce((n, p) => n + p.texto.length + p.pista.length, 0) / Math.max(1, preparadas.length);

  function estimar(filasAEvaluar, filasAClasificar) {
    const lotesUbic = Math.ceil(filasAEvaluar / 15);
    const lotesSub = Math.ceil(filasAClasificar / 25);
    const input =
      Math.round((charsProm * filasAEvaluar) / 4 + (charsProm * filasAClasificar) / 8) +
      lotesUbic * 700 +
      lotesSub * 1200;
    const output = filasAEvaluar * 30 + filasAClasificar * 15;
    return {
      lotesUbic,
      lotesSub,
      input,
      output,
      costo: (input * PRECIO_ESTIMADO.inputPorMTok + output * PRECIO_ESTIMADO.outputPorMTok) / 1e6,
    };
  }

  const estMin = estimar(aEvaluarMin, aEvaluarMin);
  const estMax = estimar(aEvaluarMax, aEvaluarMin);

  console.log('\n--- COSTO ESTIMADO ---');
  console.log(`  proveedor : ${provider}  |  modelo: ${modelo}`);
  if (modoMuestra) {
    console.log(`  modo      : muestra de ${opts.muestra} filas VÁLIDAS por categoría`);
    console.log(`  tope      : ${TOPE_POR_CATEGORIA} filas evaluadas por categoría`);
    console.log(`  a guardar : hasta ${categoriasPresentes.length * opts.muestra} filas`);
    console.log(`  a evaluar : entre ${aEvaluarMin} y ${aEvaluarMax} filas`);
    console.log(`  llamadas  : ~${estMin.lotesUbic + estMin.lotesSub} a ~${estMax.lotesUbic + estMax.lotesSub}`);
    console.log(`  costo     : ~USD ${estMin.costo.toFixed(3)} a ~USD ${estMax.costo.toFixed(3)}`);
  } else {
    console.log(`  filas     : ${preparadas.length}`);
    console.log(`  llamadas  : ~${estMin.lotesUbic} (ubicación) + ~${estMin.lotesSub} (subcategoría)`);
    console.log(`  tokens    : ~${estMin.input.toLocaleString('es-AR')} entrada, ~${estMin.output.toLocaleString('es-AR')} salida`);
    console.log(`  costo     : ~USD ${estMin.costo.toFixed(3)}`);
  }
  console.log('  (estimación con la tarifa pública; el costo real lo informa la API al terminar)');

  if (opts.dryRun) console.log('\n--dry-run: no se va a escribir nada en la base.');

  if (!opts.si) {
    const ok = await confirmar('\n¿Seguimos? (s/n) ');
    if (!ok) {
      console.log('Cancelado. No se escribió nada.\n');
      process.exit(0);
    }
  }

  // --- 5. Ubicaciones (LLM) ---
  let usage = null;
  let llUbic = 0;
  let seleccionadas = [];
  const descartadas = [];
  const evaluadasPorCat = {};
  const validasPorCat = {};

  if (modoMuestra) {
    console.log('\nBuscando filas válidas por categoría...');
    for (const cat of categoriasPresentes) {
      const candidatas = preparadas.filter((p) => p.categoria === cat);
      const elegidas = [];
      let evaluadas = 0;

      // Se avanza de a lotes: cada lote es una llamada. Se corta apenas se
      // juntan las N válidas, para no pagar por filas que no hacen falta.
      for (let i = 0; i < candidatas.length && elegidas.length < opts.muestra && evaluadas < TOPE_POR_CATEGORIA; ) {
        const cuantas = Math.min(15, TOPE_POR_CATEGORIA - evaluadas, candidatas.length - i);
        const lote = candidatas.slice(i, i + cuantas);
        const { ubicaciones, usage: u, llamadas } = await extraerUbicaciones(
          lote.map((p) => ({ texto: p.texto, pista: p.pista }))
        );
        usage = sumarUsage(usage, u);
        llUbic += llamadas;
        evaluadas += lote.length;
        i += lote.length;

        lote.forEach((p, k) => {
          p.ubicacion = ubicaciones[k] || { direccion: null, tipo: null };
          if (p.ubicacion.direccion && elegidas.length < opts.muestra) elegidas.push(p);
          // Las que se evaluaron y no entraron a la muestra por no tener
          // dirección accionable se guardan aparte: son las que permiten
          // juzgar si el criterio está descartando de más. No se importan en
          // modo muestra, pero sí se reportan con ejemplos.
          else if (!p.ubicacion.direccion) descartadas.push(p);
        });
        process.stdout.write(`\r  ${cat}: ${elegidas.length}/${opts.muestra} válidas (${evaluadas} evaluadas)`);
      }
      process.stdout.write('\n');

      evaluadasPorCat[cat] = evaluadas;
      validasPorCat[cat] = elegidas.length;
      if (elegidas.length < opts.muestra) {
        console.log(
          `    ⚠️  sólo ${elegidas.length} de ${opts.muestra} en "${cat}" tras evaluar ${evaluadas} filas` +
          `${evaluadas >= TOPE_POR_CATEGORIA ? ' (se alcanzó el tope)' : ' (se agotaron las filas)'}.`
        );
      }
      seleccionadas.push(...elegidas);
    }
  } else {
    console.log('\nExtrayendo ubicaciones...');
    const { ubicaciones, usage: u, llamadas } = await extraerUbicaciones(
      preparadas.map((p) => ({ texto: p.texto, pista: p.pista })),
      { onProgress: (h, t) => process.stdout.write(`\r  ${h}/${t} filas`) }
    );
    process.stdout.write('\n');
    usage = sumarUsage(usage, u);
    llUbic += llamadas;
    preparadas.forEach((p, i) => {
      p.ubicacion = ubicaciones[i] || { direccion: null, tipo: null };
    });
    seleccionadas = preparadas;
  }

  // --- 6. Subcategorías (LLM) ---
  console.log('Asignando subcategorías...');
  const { subcategorias, usage: uSub, llamadas: llSub } = await asignarSubcategorias(
    seleccionadas.map((p) => ({
      categoria: p.categoria,
      texto: p.texto,
      direccionDetectada: (p.ubicacion && p.ubicacion.direccion) || p.pista,
    }))
  );
  usage = sumarUsage(usage, uSub);
  seleccionadas.forEach((p, i) => {
    p.subcategoria = subcategorias[i] || '';
  });

  // --- 7. Geocodificar ---
  //
  // Se geocodifica DURANTE la importación, no después: es el mismo trabajo que
  // haría el worker, pero hacerlo acá permite decir en el resumen POR QUÉ cada
  // fila no llegó al mapa. Sin esto, "sin dirección en el texto", "USIG no la
  // resolvió" y "es de otro partido" quedarían todas como un mismo número, que
  // no sirve para saber si el pipeline anda bien o si hay algo roto.
  //
  // Muchas filas no van a terminar en pin, y eso es lo esperable con este tipo
  // de dato: direcciones incompletas, ambiguas o inexistentes.
  const conDireccion = seleccionadas.filter((p) => p.ubicacion && p.ubicacion.direccion);
  console.log(`\nGeocodificando ${conDireccion.length} direcciones...`);

  let hechas = 0;
  for (const p of seleccionadas) {
    p.geo = null;

    if (!p.ubicacion.direccion) {
      p.motivo = 'sin_direccion_en_texto';
      continue;
    }

    // Coordenadas del archivo, si son usables: no hace falta molestar a USIG.
    if (p.coords) {
      const territorio = await ubicarPunto(p.coords.lon, p.coords.lat);
      p.geo = {
        geoStatus: territorio ? 'ok' : 'fuera_caba',
        x: p.coords.lon,
        y: p.coords.lat,
        comuna: territorio ? territorio.comuna : null,
        barrio: territorio ? territorio.barrio : null,
        direccionNormalizada: p.ubicacion.direccion,
        calle: null,
        altura: null,
        cruce: null,
        fuente: 'archivo',
      };
      p.motivo = territorio ? 'con_pin' : 'fuera_caba';
      hechas += 1;
      process.stdout.write(`\r  ${hechas}/${conDireccion.length}`);
      continue;
    }

    try {
      const g = await geocodeAddress(p.ubicacion.direccion, { soloLectura: opts.dryRun });
      if (g.geoStatus === 'ok') {
        const territorio = await ubicarPunto(g.x, g.y);
        p.geo = {
          ...g,
          geoStatus: territorio ? 'ok' : 'fuera_caba',
          comuna: territorio ? territorio.comuna : null,
          barrio: territorio ? territorio.barrio : null,
          fuente: 'usig',
        };
        p.motivo = territorio ? 'con_pin' : 'fuera_caba';
      } else {
        p.geo = { ...g, comuna: null, barrio: null, fuente: 'usig' };
        p.motivo = g.geoStatus === 'fuera_caba' ? 'fuera_caba' : 'usig_no_resolvio';
      }
    } catch (err) {
      // Falla transitoria de USIG: queda 'pendiente' y lo reintenta el worker.
      p.geo = { geoStatus: 'pendiente', fuente: 'usig' };
      p.motivo = 'geocoding_pendiente';
    }
    hechas += 1;
    process.stdout.write(`\r  ${hechas}/${conDireccion.length}`);
  }
  if (conDireccion.length > 0) process.stdout.write('\n');

  // --- 8. Armar filas finales + dedupe ---
  const ahora = new Date().toISOString();
  const porId = new Map();
  let duplicadosEnArchivo = 0;

  for (const p of seleccionadas) {
    // La dirección ORIGINAL del archivo se guarda siempre, aunque el modelo la
    // haya descartado: es lo que permite auditar después si el criterio está
    // descartando de más.
    const direccionDetectada = p.ubicacion.direccion || p.pista || null;
    const g = p.geo;

    const id = construirId(p.link, p.ubicacion.direccion || p.pista, p.categoria, p.indice);
    if (porId.has(id)) {
      duplicadosEnArchivo += 1;
      continue;
    }

    porId.set(id, {
      id,
      comentarioId: id,
      plataforma: 'x',
      postUrl: null,
      commentUrl: p.link || null,
      autor: p.autor || null,
      fecha: p.fecha,
      precisionFecha: p.precisionFecha,
      detectedAt: ahora,
      textoOriginal: p.texto,
      categoria: p.categoria,
      subcategoria: p.subcategoria,
      direccionDetectada,
      direccionNormalizada: g && g.geoStatus === 'ok' ? g.direccionNormalizada : null,
      calle: g ? g.calle || null : null,
      altura: g ? g.altura ?? null : null,
      cruce: g ? g.cruce || null : null,
      x: g && g.geoStatus === 'ok' ? g.x : null,
      y: g && g.geoStatus === 'ok' ? g.y : null,
      comuna: g && g.geoStatus === 'ok' ? (g.comuna ?? (Number.isFinite(p.comuna) ? p.comuna : null)) : null,
      barrio: g && g.geoStatus === 'ok' ? g.barrio : null,
      precision:
        p.ubicacion.tipo === 'lugar_nombrado' ? 'aproximada' : p.ubicacion.direccion ? 'exacta' : null,
      // Ninguna fila se pierde: la que no llega al mapa igual se guarda, con el
      // geo_status que explica por qué.
      geoStatus: g ? g.geoStatus : 'sin_direccion',
      estado: 'Pendiente',
      _motivo: p.motivo,
      _tipoUbicacion: p.ubicacion.tipo,
      _pista: p.pista,
      _descartoPista: Boolean(p.pista) && !p.ubicacion.direccion,
    });
  }

  const finales = [...porId.values()];

  // --- 9. Resumen ---
  const MOTIVOS = [
    ['con_pin', 'con pin (geocodificadas ok)'],
    ['sin_direccion_en_texto', 'sin dirección accionable en el texto'],
    ['usig_no_resolvio', 'con dirección detectada, USIG no la resolvió'],
    ['fuera_caba', 'fuera de CABA'],
    ['geocoding_pendiente', 'geocoding pendiente (falla transitoria de USIG)'],
  ];
  const conteo = {};
  finales.forEach((r) => {
    conteo[r._motivo] = (conteo[r._motivo] || 0) + 1;
  });

  console.log('\n========== RESUMEN ==========');
  console.log(`  filas leídas          : ${filas.length}`);
  console.log(`  filas procesables     : ${preparadas.length}`);
  console.log(`  duplicados en archivo : ${duplicadosEnArchivo}  (clave: link + dirección + categoría)`);
  console.log(`  filas a guardar       : ${finales.length}   <- ninguna se descarta`);

  console.log('\n  POR QUÉ CADA FILA LLEGA O NO AL MAPA:');
  for (const [clave, etiqueta] of MOTIVOS) {
    const n = conteo[clave] || 0;
    if (n === 0 && clave === 'geocoding_pendiente') continue;
    console.log(`     ${String(n).padStart(6)}  ${pct(n, finales.length).padStart(4)}  ${etiqueta}`);
  }

  // --- Ejemplos por motivo, para poder juzgar si el criterio descarta de más ---
  // En modo muestra, las filas evaluadas y descartadas no se importan, pero
  // son las que dicen si el criterio de "ubicación accionable" está bien
  // calibrado o si está tirando cosas que sí eran ubicables.
  if (descartadas.length > 0) {
    const evaluadas = Object.values(evaluadasPorCat).reduce((a, b) => a + b, 0);
    console.log('\n  DESCARTADAS AL BUSCAR LA MUESTRA (no se importan):');
    console.log(`     ${String(descartadas.length).padStart(6)}  ${pct(descartadas.length, evaluadas).padStart(4)}  de ${evaluadas} filas evaluadas, sin dirección accionable en el texto`);
    console.log('\n   --- ejemplos, para juzgar si el criterio descarta de más ---');
    for (const p of descartadas.slice(0, 6)) {
      console.log(`     texto : ${p.texto.slice(0, 130).replace(/\s+/g, ' ')}`);
      console.log(`     pista descartada: ${p.pista || '(el archivo tampoco traía)'}`);
      console.log('');
    }
  }

  console.log('\n  EJEMPLOS DE CADA MOTIVO:');
  for (const [clave, etiqueta] of MOTIVOS) {
    const muestra = finales.filter((r) => r._motivo === clave).slice(0, 3);
    if (muestra.length === 0) continue;
    console.log(`\n   --- ${etiqueta} ---`);
    for (const r of muestra) {
      console.log(`     texto : ${r.textoOriginal.slice(0, 120).replace(/\s+/g, ' ')}`);
      if (clave === 'sin_direccion_en_texto') {
        console.log(`     pista descartada: ${r._pista || '(el archivo tampoco traía)'}`);
      } else {
        console.log(`     dirección: ${r.direccionDetectada}${r.barrio ? `  ->  ${r.barrio}` : ''}`);
      }
    }
  }

  const porTipo = {};
  finales.forEach((r) => {
    if (r._tipoUbicacion) porTipo[r._tipoUbicacion] = (porTipo[r._tipoUbicacion] || 0) + 1;
  });
  if (Object.keys(porTipo).length > 0) {
    console.log('\n  tipos de ubicación detectados:');
    Object.entries(porTipo)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`     ${String(v).padStart(6)}  ${k}`));
  }

  console.log('\n  distribución por categoría:');
  const porCat = {};
  finales.forEach((r) => {
    const k = `${r.categoria}${r.subcategoria ? ` / ${r.subcategoria}` : ' / (sin subcategoría)'}`;
    porCat[k] = (porCat[k] || 0) + 1;
  });
  Object.entries(porCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([k, v]) => console.log(`     ${String(v).padStart(6)}  ${k}`));
  if (Object.keys(porCat).length > 15) {
    console.log(`     ... y ${Object.keys(porCat).length - 15} combinaciones más`);
  }

  console.log('\n  costo real del LLM:');
  if (usage) {
    console.log(`     llamadas : ${llUbic + llSub}  (${llUbic} ubicación + ${llSub} subcategoría)`);
    console.log(
      `     tokens   : ${usage.inputTokens.toLocaleString('es-AR')} entrada, ${usage.outputTokens.toLocaleString('es-AR')} salida`
    );
    console.log(`     costo    : ${usage.costUsd != null ? `USD ${usage.costUsd.toFixed(4)}` : '(no informado por la API)'}`);
  } else {
    console.log('     (sin datos de uso)');
  }

  // --- 10. Escribir ---
  if (opts.dryRun) {
    console.log('\n--dry-run: NO se escribió nada en la base (ni en la caché de geocoding).\n');
    return;
  }

  let guardadas = 0;
  for (const r of finales) {
    const { _motivo, _tipoUbicacion, _pista, _descartoPista, ...fila } = r;
    db.upsertReclamo(fila);
    guardadas += 1;
  }
  console.log(`\n✅ ${guardadas} reclamos guardados (upsert idempotente).`);
  const pendientes = conteo.geocoding_pendiente || 0;
  if (pendientes > 0) {
    console.log(`   ${pendientes} quedaron en 'pendiente': los reintenta el worker de geocoding.\n`);
  } else {
    console.log('');
  }
}

main().catch((err) => {
  console.error('\n❌ Falló la importación:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
