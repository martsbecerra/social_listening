// ==========================================================================
// geo-reprocesar.js — El reproceso de los reclamos sin punto (fase H,
// openspec/changes/geo-pro).
// --------------------------------------------------------------------------
// Una sola pasada del modelo sobre los reclamos guardados que no tienen un
// punto (Instagram y X) para extraer su ubicación estructurada, con las
// reglas de la tanda del análisis; no vuelve a clasificar tono ni temas. Lo
// extraído queda en un JSON que el piloto aplica una vez al arrancar
// (src/geo/reproceso.js): guarda cada ubicación y la pasa por el resolver.
//
//   node scripts/geo-reprocesar.js --base <copia.db> --costo
//        SOLO INFORMA: cuántos reclamos, cuántas llamadas y el costo (sin red)
//   node scripts/geo-reprocesar.js --base <copia.db> --simulado --salida <json>
//        prueba el script con un modelo falso
//   node scripts/geo-reprocesar.js --base <copia.db> --si --salida <json> [--tope 0.6]
//        GASTA EN EL MODELO: la corrida, una sola vez (se niega si ya existe
//        el JSON de salida); corta si lo gastado llega al tope
//   node scripts/geo-reprocesar.js --base <copia.db> --aplicar --salida <json>
//        aplica el JSON sobre la COPIA (USIG y los datasets, gratis) y dice
//        cómo quedó: lo que va a hacer el piloto al arrancar
//
// La base es SIEMPRE una copia: con data/monitoring.db no arranca. Para el
// piloto, --salida es data/geo/reproceso-ubicaciones.json del repo.
// ==========================================================================

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

function leerArgs(argv) {
  const out = { modo: null, base: null, salida: null, tope: 0.6 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (['--costo', '--simulado', '--si', '--aplicar'].includes(a)) out.modo = a.slice(2);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--salida') out.salida = argv[++i];
    else if (a === '--tope') out.tope = Number(String(argv[++i]).replace(',', '.'));
  }
  return out;
}

const AYUDA = `Uso:
  node scripts/geo-reprocesar.js --base <copia.db> --costo
  node scripts/geo-reprocesar.js --base <copia.db> --simulado --salida <json>
  node scripts/geo-reprocesar.js --base <copia.db> --si --salida <json> [--tope 0.6]
  node scripts/geo-reprocesar.js --base <copia.db> --aplicar --salida <json>`;

const usd = (n) => `US$ ${n.toFixed(3).replace('.', ',')}`;

async function main(argv = process.argv) {
  const args = leerArgs(argv);
  if (!args.modo || !args.base || (args.modo !== 'costo' && !args.salida) || !(args.tope > 0)) {
    console.error(AYUDA);
    return 1;
  }
  const base = path.resolve(args.base);
  if (base === path.resolve(REPO, 'data', 'monitoring.db') || !fs.existsSync(base)) {
    console.error(`La base tiene que ser una COPIA existente, nunca data/monitoring.db: ${base}`);
    return 1;
  }
  if (args.modo === 'si' && fs.existsSync(path.resolve(args.salida))) {
    console.error(`Ya existe ${args.salida}: el reproceso corre una sola vez.`);
    return 1;
  }
  // ANTES de cargar nada de src/ (db.js abre la base al cargarse).
  process.env.MONITORING_DB_PATH = base;
  if (args.modo === 'si') require('dotenv').config({ path: path.join(REPO, '.env'), quiet: true });

  const reproceso = require('../src/geo/reproceso');
  const extraccion = require('../src/geo/extraccion');

  if (args.modo === 'aplicar') {
    const geoWorker = require('../src/geoWorker');
    const db = require('../src/db');
    db.setRefreshState(reproceso.MARCA, ''); // la copia puede traer la marca de una prueba anterior
    const r = await reproceso.aplicarSiHay({ archivo: path.resolve(args.salida), procesar: () => geoWorker.processPendingReclamos() });
    console.log(JSON.stringify(r ? r.resumen : null, null, 1));
    return 0;
  }

  const items = reproceso.candidatos();
  const porPlataforma = items.reduce((m, it) => ({ ...m, [it.plataforma]: (m[it.plataforma] || 0) + 1 }), {});
  const costo = extraccion.estimarCosto(items);
  console.log(`Reclamos sin punto: ${items.length} (${Object.entries(porPlataforma).map(([p, n]) => `${p} ${n}`).join(', ')})`);
  console.log(`Llamadas: ${costo.llamadas} (de a ${extraccion.TANDA})`);
  console.log(`Entrada: ${costo.caracteres} caracteres ≈ ${costo.tokensEntrada} tokens (a US$ ${extraccion.PRECIO.entradaPorMillon} el millón)`);
  console.log(`Salida: entre ${costo.tokensSalida.minimo} y ${costo.tokensSalida.maximo} tokens (a US$ ${extraccion.PRECIO.salidaPorMillon} el millón)`);
  console.log(`Costo: entre ${usd(costo.usd.minimo)} y ${usd(costo.usd.maximo)}; tope de la corrida ${usd(args.tope)}`);
  if (args.modo === 'costo') return 0;

  const modelo =
    args.modo === 'simulado'
      ? {
          requestStructuredAnalysis: async ({ userPrompt }) => ({
            parsed: { ubicaciones: [...userPrompt.matchAll(/^(\d+)\. /gm)].map((m) => ({ i: Number(m[1]), ubicacion: { tipo: 'ninguna', calle: '', altura: 0, calle2: '', nombre_lugar: '', barrio_o_comuna: '', texto_original: '', confianza: 'baja', fuera_de_caba: false } })) },
            usage: { totalTokens: 1000, costUsd: 0.01 },
          }),
        }
      : undefined;
  const res = await extraccion.extraerUbicaciones(items, {
    tope: args.tope,
    modelo,
    onProgress: (hechos, total, gastado) => console.log(`  ${hechos}/${total} · ${usd(gastado)}`),
  });
  const { getAnalysisModel } = require('../src/llm/providerConfig');
  const datos = reproceso.escribirArchivo(path.resolve(args.salida), { items, extraccion: res, modelo: args.modo === 'simulado' ? 'simulado' : getAnalysisModel() });
  console.log(`Listo: ${Object.keys(datos.ubicaciones).length} de ${items.length} con su ubicación · ${res.llamadas} llamadas (${res.fallidas} fallidas) · ${usd(res.usd)}${res.cortadoPorTope ? ' · CORTADO POR EL TOPE' : ''}`);
  console.log(`Archivo: ${path.resolve(args.salida)}`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = { main, leerArgs };
