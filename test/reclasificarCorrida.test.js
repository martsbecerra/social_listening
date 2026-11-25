'use strict';

// scripts/reclasificar-corrida.js (rama clasificacion-foto-y-exclusiones):
// clasifica de nuevo lo que una corrida guardó "sin clasificar".
//
// - Sin --si: solo informa (cuántas, por término, tono a mano, excluidas,
//   costo) y no escribe nada.
// - Con --si: no arranca con la app prendida ni con la clave del modelo
//   rota; hace un backup verificado antes de escribir.
// - Relevante: se completa como en el ciclo; no relevante: sale de la tabla,
//   con sus fotos, y queda `descartado` en search_seen; de una cuenta
//   excluida: sale como `excluido` sin pasar por el modelo; con el tono a
//   mano: no se borra (y si es relevante, el tono queda); lo de fuera de la
//   corrida, ignorado o ya clasificado, no se toca. Se puede volver a correr.
// - Frena con 3 fallas seguidas del modelo y antes de pasar el tope.
//
// El modelo y la portada stubeados; base y carpeta de fotos temporales.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-reclasificar-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
const MEDIA = path.join(tmp, 'media');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.MONITORING_MEDIA_DIR = MEDIA;
process.env.POST_IMAGES = '0';
delete process.env.CLASIFICAR_CON_FOTO;
delete process.env.CLASIFICADOR_FOTO_MAX;
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: ['jefe de gobierno porteño'], searches: ['gobierno porteño'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const llm = require('../src/llm');
const llamadas = [];
llm.requestStructuredAnalysis = async (req) => {
  llamadas.push(req);
  const texto = req.userPrompt.split('POSTEO:\n')[1] || '';
  if (/FALLA/.test(texto)) throw Object.assign(new Error('HTTP 500'), { isApiFailure: true, tokenUsage: null });
  const relevante = /RELEVANTE/.test(texto);
  return {
    parsed: { relevant: relevante, title: relevante ? 'Obra porteña' : 'Otra cosa', sentiment: 'positivo', tema: 'Infraestructura', motivo: relevante ? 'habla de CABA' : 'no habla de la Ciudad', necesitaImagen: false },
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.012 },
    attempts: 1,
  };
};
const postImages = require('../src/postImages');
postImages.imageForModel = async () => null;

const db = require('../src/db');
const script = require('../scripts/reclasificar-corrida');

const raw = new DatabaseSync(DB_PATH);
const fila = (id) => raw.prepare('SELECT id, title, sentiment, tema, matched_reason, ignored FROM detected_posts WHERE id = ?').get(id);
const visto = (id) => raw.prepare("SELECT outcome, motivo, llm_usd, run_id FROM search_seen WHERE post_id = ? AND plataforma = 'instagram'").get(id);
const SIN = 'Búsqueda: gobierno porteño — sin clasificar (falló el clasificador, relevancia sin verificar)';

function guardar(id, { account = 'vecino', caption, title = null, sentiment = null, matchedReason = SIN } = {}) {
  assert.equal(
    db.saveDetectedPost({ id, plataforma: 'instagram', account, url: `https://www.instagram.com/p/${id}/`, caption, matchedReason, likes: 1, comments: 1, postedAt: new Date().toISOString(), title, sentiment, postType: 'imagen' }),
    true
  );
  db.markSearchSeen({ postId: id, plataforma: 'instagram', url: `https://www.instagram.com/p/${id}/`, term: 'gobierno porteño', outcome: 'guardado', runId: 61 });
}

async function correr(args, deps = {}) {
  const salida = [];
  const code = await script.main(['node', 'reclasificar-corrida.js', ...args], {
    out: (l) => salida.push(String(l)),
    appCorriendo: async () => false,
    claveAnda: async () => ({ ok: true }),
    loadEnv: () => {},
    ...deps,
  });
  return { code, texto: salida.join('\n') };
}

const LARGO = 'del gobierno porteño sobre la obra del nuevo hospital en Villa Lugano, con los vecinos del barrio';

before(() => {
  const ahora = Date.now();
  raw.prepare("INSERT INTO monitoring_runs (id, started_at, finished_at, trigger, plataforma, new_posts) VALUES (61, ?, ?, 'cron', 'instagram', 0)").run(new Date(ahora - 3600e3).toISOString(), new Date(ahora + 3600e3).toISOString());
  guardar('REL', { caption: `RELEVANTE: anuncio ${LARGO}` });
  guardar('NADA', { caption: `NADA que ver, una receta de pan ${LARGO}` });
  guardar('MANO_NO', { caption: `NADA que ver tampoco ${LARGO}`, sentiment: 'negativo' });
  guardar('MANO_SI', { caption: `RELEVANTE también ${LARGO}`, sentiment: 'negativo' });
  guardar('SEVILLA', { account: 'Populares_Sevilla', caption: `Con Feijóo tendremos presupuestos ${LARGO}` });
  guardar('YA', { caption: `RELEVANTE ${LARGO}`, title: 'Ya clasificada', sentiment: 'neutral', matchedReason: 'Búsqueda: gobierno porteño (relacionado por contenido) · habla de CABA' });
  guardar('IGN', { caption: `NADA ${LARGO}` });
  db.ignorePost('IGN', 'instagram');
  // Fotos de la que va a salir.
  const dir = path.join(MEDIA, 'instagram');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of ['thumb', 'full']) fs.writeFileSync(path.join(dir, `NADA_${s}.jpg`), 'x');
});

describe('reclasificar-corrida', { concurrency: false }, () => {
  test('argumentos y término del motivo', () => {
    assert.equal(script.parseArgs(['n', 's']).error, 'Falta --corrida N.');
    assert.deepEqual(
      (({ corrida, si, tope, concurrencia }) => ({ corrida, si, tope, concurrencia }))(script.parseArgs(['n', 's', '--corrida', '61', '--si', '--tope', '2,5'.replace(',', '.'), '--concurrencia', '20'])),
      { corrida: 61, si: true, tope: 2.5, concurrencia: 8 }
    );
    assert.match(script.parseArgs(['n', 's', '--corrida', 'x']).error, /--corrida/);
    assert.equal(script.terminoDe(SIN), 'gobierno porteño');
    assert.equal(script.terminoDe('Búsqueda: macri (coincidencia: "macri") · x'), 'macri');
  });

  test('sin --si: informa (por término, tono a mano, excluidas, costo) y no escribe nada', async () => {
    const antes = raw.prepare('SELECT COUNT(*) n FROM detected_posts').get().n;
    const { code, texto } = await correr(['--corrida', '61']);
    assert.equal(code, 0);
    assert.match(texto, /Corrida #61 .*: 5 publicación\/es sin clasificar\./);
    assert.match(texto, /gobierno porteño: 5/);
    assert.match(texto, /De cuentas excluidas \(salen sin pasar por el modelo\): 1/);
    assert.match(texto, /Con el tono puesto a mano \(no se borran\): 2/);
    assert.match(texto, /Al modelo: 4 · costo estimado US\$ 0,05/);
    assert.match(texto, /--corrida 61 --si/);
    assert.equal(llamadas.length, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM detected_posts').get().n, antes);
    assert.equal(fs.existsSync(path.join(tmp, 'backups')), false);
  });

  test('con --si no arranca con la app prendida ni con la clave rota', async () => {
    const prendida = await correr(['--corrida', '61', '--si'], { appCorriendo: async () => true });
    assert.equal(prendida.code, 1);
    assert.match(prendida.texto, /La app está corriendo/);
    const rota = await correr(['--corrida', '61', '--si'], { claveAnda: async () => ({ ok: false, motivo: 'OpenRouter respondió 401' }) });
    assert.equal(rota.code, 1);
    assert.match(rota.texto, /La clave del modelo no anda \(OpenRouter respondió 401\)/);
    assert.equal(llamadas.length, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'backups')), false);
  });

  test('con --si: backup verificado y cada una como la habría dejado el ciclo', async () => {
    const { code, texto } = await correr(['--corrida', '61', '--si']);
    assert.equal(code, 0, texto);
    // (abrir la copia para verificarla deja también su -wal y su -shm)
    const backups = fs.readdirSync(path.join(tmp, 'backups')).filter((n) => n.endsWith('.db'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^monitoring-.*-antes-de-reclasificar-61\.db$/);
    assert.match(texto, /Backup verificado: /);

    // Relevante: completa, como en el ciclo.
    assert.equal(fila('REL').title, 'Obra porteña');
    assert.equal(fila('REL').tema, 'Infraestructura');
    assert.doesNotMatch(fila('REL').matched_reason, /sin clasificar/);
    assert.match(fila('REL').matched_reason, /· habla de CABA$/);
    assert.equal(visto('REL').outcome, 'guardado');
    assert.equal(visto('REL').llm_usd, 0.012);

    // No relevante: sale de la tabla, con sus fotos; descartado en search_seen.
    assert.equal(fila('NADA'), undefined);
    assert.deepEqual({ ...visto('NADA') }, { outcome: 'descartado', motivo: 'no habla de la Ciudad', llm_usd: 0.012, run_id: 61 });
    assert.equal(fs.existsSync(path.join(MEDIA, 'instagram', 'NADA_full.jpg')), false);

    // Tono a mano: no se borra; si es relevante, se completa sin tocar el tono.
    assert.equal(fila('MANO_NO').title, null);
    assert.equal(fila('MANO_NO').sentiment, 'negativo');
    assert.equal(fila('MANO_SI').title, 'Obra porteña');
    assert.equal(fila('MANO_SI').sentiment, 'negativo');
    assert.match(texto, /tono a mano, no se borró: MANO_NO @vecino \(el modelo dice que no es relevante: no habla de la Ciudad\)/);

    // Cuenta excluida: sale sin pasar por el modelo.
    assert.equal(fila('SEVILLA'), undefined);
    assert.match(visto('SEVILLA').outcome, /^excluido$/);
    assert.match(visto('SEVILLA').motivo, /^Cuenta excluida: Partido Popular de Sevilla/);
    assert.ok(!llamadas.some((l) => /Feijóo/.test(l.userPrompt)), 'la de Sevilla no fue al modelo');

    // Lo que no es de esta reclasificación, intacto.
    assert.equal(fila('YA').title, 'Ya clasificada');
    assert.equal(fila('IGN').ignored, 1);
    assert.equal(fila('IGN').title, null);

    assert.match(texto, /relevantes \(clasificadas\): 2/);
    assert.match(texto, /no relevantes \(salieron, descartadas en search_seen\): 1/);
    assert.match(texto, /de cuentas excluidas \(salieron sin modelo\): 1/);
    assert.match(texto, /costo del modelo: US\$ 0,05/);
    assert.equal(llamadas.length, 4);

    // Otra vez: solo queda la del tono a mano.
    const otra = await correr(['--corrida', '61']);
    assert.match(otra.texto, /1 publicación\/es sin clasificar/);
  });

  test('frena con 3 fallas seguidas del modelo y deja todo como estaba', async () => {
    for (let i = 1; i <= 5; i += 1) guardar(`FALLA${i}`, { caption: `FALLA ${i} ${LARGO}` });
    llamadas.length = 0;
    const { code, texto } = await correr(['--corrida', '61', '--si', '--concurrencia', '1']);
    assert.equal(code, 1);
    assert.match(texto, /Frenó: 3 fallas seguidas del modelo/);
    // Primero la del tono a mano (detectada antes: va al modelo y se conserva),
    // después tres fallas y frena: la cuarta y la quinta ni se intentan.
    assert.equal(llamadas.length, 4);
    assert.match(texto, /sin procesar: 2/);
    for (let i = 1; i <= 5; i += 1) assert.equal(fila(`FALLA${i}`).title, null);
    for (let i = 1; i <= 5; i += 1) raw.prepare('DELETE FROM detected_posts WHERE id = ?').run(`FALLA${i}`);
  });

  test('frena antes de pasar el tope', async () => {
    for (let i = 1; i <= 4; i += 1) guardar(`TOPE${i}`, { caption: `RELEVANTE ${i} ${LARGO}` });
    llamadas.length = 0;
    // Con US$ 0,012 por llamada y 0,03 reservado por cada una en vuelo: entran dos.
    const { texto } = await correr(['--corrida', '61', '--si', '--concurrencia', '1', '--tope', '0.05']);
    assert.match(texto, /Frenó: tope de US\$ 0,05/);
    assert.equal(llamadas.length, 2);
    assert.match(texto, /sin procesar: 3/, 'entran la del tono a mano y TOPE1; quedan TOPE2 a TOPE4');
    assert.match(texto, /Al modelo: 5 · costo estimado US\$ 0,06 \(tope US\$ 0,05\)/);
  });
});
