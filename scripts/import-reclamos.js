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
const { normalizeClasificacion } = require('../src/categoriasConfig');
const { getLlmProvider, getClassifierModel } = require('../src/llm/providerConfig');
const db = require('../src/db');

// Precio del modelo clasificador en OpenRouter (USD por millón de tokens).
// Sólo se usa para la estimación previa; el costo real sale de la API.
const PRECIO_ESTIMADO = { inputPorMTok: 1, outputPorMTok: 5 };

// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, limit: null, si: false, map: {}, archivo: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--si' || a === '--yes') opts.si = true;
    else if (a === '--limit') opts.limit = Number(args[++i]);
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length));
    else if (a === '--map') {
      const [campo, ...resto] = String(args[++i] || '').split('=');
      if (campo && resto.length) opts.map[campo.trim()] = resto.join('=').trim();
    } else if (!a.startsWith('--')) opts.archivo = a;
  }
  return opts;
}

function uso() {
  console.error('Uso: node scripts/import-reclamos.js <archivo.xlsx|csv> [--dry-run] [--limit N] [--si] [--map campo=Columna]');
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
  const charsTexto = preparadas.reduce((n, p) => n + p.texto.length + p.pista.length, 0);
  // ~4 caracteres por token, más el system prompt por lote.
  const lotesUbic = Math.ceil(preparadas.length / 15);
  const lotesSub = Math.ceil(preparadas.length / 25);
  const inputEstimado = Math.round(charsTexto / 4 + charsTexto / 8) + lotesUbic * 700 + lotesSub * 1200;
  const outputEstimado = preparadas.length * 40;
  const costoEstimado =
    (inputEstimado * PRECIO_ESTIMADO.inputPorMTok + outputEstimado * PRECIO_ESTIMADO.outputPorMTok) / 1e6;

  console.log('\n--- COSTO ESTIMADO ---');
  console.log(`  proveedor : ${provider}  |  modelo: ${modelo}`);
  console.log(`  filas     : ${preparadas.length}`);
  console.log(`  llamadas  : ~${lotesUbic} (ubicación) + ~${lotesSub} (subcategoría) = ~${lotesUbic + lotesSub}`);
  console.log(`  tokens    : ~${inputEstimado.toLocaleString('es-AR')} entrada, ~${outputEstimado.toLocaleString('es-AR')} salida`);
  console.log(`  costo     : ~USD ${costoEstimado.toFixed(3)}`);
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
  console.log('\nExtrayendo ubicaciones...');
  let usage = null;
  const { ubicaciones, usage: uUbic, llamadas: llUbic } = await extraerUbicaciones(
    preparadas.map((p) => ({ texto: p.texto, pista: p.pista })),
    {
      onProgress: (hechas, total) => {
        process.stdout.write(`\r  ${hechas}/${total} filas`);
      },
    }
  );
  process.stdout.write('\n');
  usage = sumarUsage(usage, uUbic);

  preparadas.forEach((p, i) => {
    p.ubicacion = ubicaciones[i] || { direccion: null, tipo: null };
  });

  // --- 6. Subcategorías (LLM) ---
  console.log('Asignando subcategorías...');
  const { subcategorias, usage: uSub, llamadas: llSub } = await asignarSubcategorias(
    preparadas.map((p) => ({
      categoria: p.categoria,
      texto: p.texto,
      direccionDetectada: p.ubicacion.direccion || p.pista,
    }))
  );
  usage = sumarUsage(usage, uSub);
  preparadas.forEach((p, i) => {
    p.subcategoria = subcategorias[i] || '';
  });

  // --- 7. Armar filas finales + dedupe ---
  const ahora = new Date().toISOString();
  const porId = new Map();
  let duplicadosEnArchivo = 0;

  for (const p of preparadas) {
    // La dirección ORIGINAL del archivo se guarda siempre, aunque el modelo la
    // haya descartado: es lo que permite auditar después si el criterio está
    // descartando de más. La que se geocodifica es la que validó el modelo.
    const direccionDetectada = p.ubicacion.direccion || p.pista || null;
    const tieneUbicacion = Boolean(p.ubicacion.direccion);

    const id = construirId(p.link, p.ubicacion.direccion || p.pista, p.categoria, p.indice);
    if (porId.has(id)) {
      duplicadosEnArchivo += 1;
      continue;
    }

    const usaCoords = tieneUbicacion && p.coords;
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
      direccionNormalizada: usaCoords ? p.ubicacion.direccion : null,
      calle: null,
      altura: null,
      cruce: null,
      x: usaCoords ? p.coords.lon : null,
      y: usaCoords ? p.coords.lat : null,
      comuna: usaCoords && Number.isFinite(p.comuna) ? p.comuna : null,
      barrio: null,
      precision: p.ubicacion.tipo === 'lugar_nombrado' ? 'aproximada' : tieneUbicacion ? 'exacta' : null,
      // Con ubicación pero sin coordenadas usables -> 'pendiente', lo resuelve
      // el worker de siempre. Sin ubicación -> 'sin_direccion': la fila se
      // guarda igual, no se pierde, sólo no va al mapa.
      geoStatus: !tieneUbicacion ? 'sin_direccion' : usaCoords ? 'ok' : 'pendiente',
      estado: 'Pendiente',
      _tipoUbicacion: p.ubicacion.tipo,
      _descartoPista: Boolean(p.pista) && !tieneUbicacion,
    });
  }

  const finales = [...porId.values()];

  // --- 8. Resumen ---
  const conUbic = finales.filter((r) => r.geoStatus !== 'sin_direccion').length;
  const sinUbic = finales.length - conUbic;
  const conCoords = finales.filter((r) => r.geoStatus === 'ok').length;
  const aGeocodificar = finales.filter((r) => r.geoStatus === 'pendiente').length;
  const descartes = finales.filter((r) => r._descartoPista).length;

  console.log('\n========== RESUMEN ==========');
  console.log(`  filas leídas          : ${filas.length}`);
  console.log(`  filas procesables     : ${preparadas.length}`);
  console.log(`  duplicados en archivo : ${duplicadosEnArchivo}  (clave: link + dirección + categoría)`);
  console.log(`  filas a guardar       : ${finales.length}`);
  console.log('');
  console.log(`  con ubicación accionable : ${conUbic}  (${pct(conUbic, finales.length)})`);
  console.log(`     - con coordenadas del archivo : ${conCoords}`);
  console.log(`     - a geocodificar con USIG     : ${aGeocodificar}`);
  console.log(`  sin ubicación (sin_direccion)    : ${sinUbic}  (${pct(sinUbic, finales.length)})`);
  console.log(`     de ésas, con pista descartada : ${descartes}`);

  const porTipo = {};
  finales.forEach((r) => {
    if (r._tipoUbicacion) porTipo[r._tipoUbicacion] = (porTipo[r._tipoUbicacion] || 0) + 1;
  });
  if (Object.keys(porTipo).length > 0) {
    console.log('\n  tipos de ubicación:');
    Object.entries(porTipo).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${String(v).padStart(6)}  ${k}`));
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
    console.log(`     tokens   : ${usage.inputTokens.toLocaleString('es-AR')} entrada, ${usage.outputTokens.toLocaleString('es-AR')} salida`);
    console.log(`     costo    : ${usage.costUsd != null ? `USD ${usage.costUsd.toFixed(4)}` : '(no informado por la API)'}`);
  } else {
    console.log('     (sin datos de uso)');
  }

  // --- 9. Escribir ---
  if (opts.dryRun) {
    console.log('\n--dry-run: NO se escribió nada en la base.\n');
    console.log('  Muestra de las primeras 5 filas que se guardarían:');
    finales.slice(0, 5).forEach((r) => {
      console.log(`   - [${r.geoStatus}] ${r.categoria} / ${r.subcategoria || '(sin sub)'}`);
      console.log(`     dirección: ${r.direccionDetectada || '(ninguna)'}${r._descartoPista ? '   <- pista descartada por el texto' : ''}`);
      console.log(`     texto: ${r.textoOriginal.slice(0, 90)}`);
    });
    console.log('');
    return;
  }

  let guardadas = 0;
  for (const r of finales) {
    const { _tipoUbicacion, _descartoPista, ...fila } = r;
    db.upsertReclamo(fila);
    guardadas += 1;
  }
  console.log(`\n✅ ${guardadas} reclamos guardados (upsert idempotente).`);
  if (aGeocodificar > 0) {
    console.log(`   ${aGeocodificar} quedaron en 'pendiente': los resuelve el worker de geocoding.\n`);
  }
}

main().catch((err) => {
  console.error('\n❌ Falló la importación:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
