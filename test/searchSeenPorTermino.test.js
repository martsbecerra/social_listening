'use strict';

// Los descartados quedan anotados con su búsqueda (noviembre 2026,
// openspec/changes/ventana-por-fuente): search_seen anota TODO lo que
// decidió el clasificador sobre un resultado de búsqueda, se haya pagado o no
// su detalle, con todos los términos que lo trajeron, el motivo, lo que costó
// clasificarlo y su fecha de publicación. Un posteo ya decidido no se vuelve
// a clasificar en la corrida siguiente. Base y config temporales; el
// clasificador es un stub; nada llama a Apify ni a un modelo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.IG_ACTOR = 'apidojo';
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.POST_IMAGES = '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-seen-termino-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
delete process.env.SEARCH_ENRICH_LIMIT;
delete process.env.SEARCH_RESULTS_LIMIT;
delete process.env.MONITOR_LOOKBACK;

fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: [], searches: ['macri', 'gobierno porteño', 'gcba'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura):
// "gestión" es relevante, "se cayó" simula el modelo caído, el resto se
// descarta con su motivo. Cada llamada avisa lo que costó.
const classifier = require('../src/classifier');
const llamadas = [];
classifier.clasificarPosteo = async (caption, { onUsage } = {}) => {
  llamadas.push(caption);
  if (typeof onUsage === 'function') onUsage({ inputTokens: 1000, outputTokens: 100, costUsd: 0.003 });
  if (/se cayó/i.test(caption)) return { relevant: true, title: null, sentiment: null, tema: null, motivo: null, unclassified: true };
  if (/gestión/i.test(caption)) return { relevant: true, title: 'La gestión', sentiment: 'positivo', tema: 'Coyuntura / Otros', motivo: 'habla de la gestión porteña' };
  return { relevant: false, title: 'otra cosa', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'no habla de la Ciudad' };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const { runWithContext } = require('../src/usageContext');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const POSTED = '2026-11-10T15:00:00.000Z';
function resultado({ id, caption, term }) {
  return {
    id: String(id),
    account: 'alguien',
    url: `https://www.instagram.com/p/${id}/`,
    caption,
    hashtagsText: '',
    likes: 5,
    comments: 1,
    postedAt: POSTED,
    postType: 'imagen',
    followers: null,
    sourceType: 'search',
    sourceQuery: term,
  };
}

/** Stub del adapter: `porTermino` dice qué devuelve cada búsqueda. */
function stubInstagram(porTermino, extra = {}) {
  const originals = {};
  for (const key of ['isConfigured', 'scrapeSearch', 'fetchPostDetails']) originals[key] = instagram[key];
  instagram.isConfigured = () => true;
  instagram.scrapeSearch = async (term) => (porTermino[term] || []).map((p) => ({ ...p, sourceQuery: term }));
  instagram.fetchPostDetails = async () => [];
  Object.assign(instagram, extra);
  return () => Object.assign(instagram, originals);
}

const cycle = (runId = null) => runWithContext({ runId, phase: 'monitoreo' }, () => monitor.runMonitoringCycle({ plataformas: ['instagram'] }));
const guardado = (id) => db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === id);

describe('search_seen: lo que decidió el modelo queda anotado con su búsqueda', { concurrency: false }, () => {
  test('un descartado CON texto (sin detalle pagado) queda anotado con todos sus términos, el motivo, el costo, la corrida y su fecha', async () => {
    const receta = resultado({ id: 'receta', caption: 'receta de pan casero' });
    const obra = resultado({ id: 'obra', caption: 'La gestión inauguró una obra' });
    const restore = stubInstagram({ macri: [receta, obra], 'gobierno porteño': [receta], gcba: [] });
    try {
      llamadas.length = 0;
      const result = await cycle(41);
      assert.equal(llamadas.length, 2, 'una clasificación por posteo, aunque lo traigan dos búsquedas');
      assert.equal(result.porPlataforma.instagram.newCandidates, 2);
      assert.equal(result.porPlataforma.instagram.newCount, 1);

      const visto = db.getSearchSeen('receta', 'instagram');
      assert.equal(visto.outcome, 'descartado');
      assert.equal(visto.term, 'macri', 'el término del motivo es el de la primera búsqueda que lo trajo');
      assert.deepEqual(visto.terminos, ['macri', 'gobierno porteño']);
      assert.equal(visto.motivo, 'no habla de la Ciudad');
      assert.equal(visto.llmUsd, 0.003);
      assert.equal(visto.runId, 41);
      assert.equal(visto.postedAt, POSTED);
      assert.equal(guardado('receta'), undefined);

      const entro = db.getSearchSeen('obra', 'instagram');
      assert.equal(entro.outcome, 'guardado');
      assert.deepEqual(entro.terminos, ['macri']);
      assert.equal(entro.motivo, 'habla de la gestión porteña');
      assert.equal(guardado('obra').title, 'La gestión');
    } finally {
      restore();
    }
  });

  test('la corrida siguiente no lo vuelve a clasificar, y si otra búsqueda lo trae suma el término', async () => {
    const receta = resultado({ id: 'receta', caption: 'receta de pan casero' });
    const obra = resultado({ id: 'obra', caption: 'La gestión inauguró una obra' });
    const restore = stubInstagram({ macri: [receta], 'gobierno porteño': [], gcba: [receta, obra] });
    try {
      llamadas.length = 0;
      const primerVisto = db.getSearchSeen('receta', 'instagram').firstSeenAt;
      const result = await cycle(42);
      assert.equal(llamadas.length, 0, 'ni el descartado ni el guardado se vuelven a clasificar');
      assert.equal(result.porPlataforma.instagram.newCandidates, 0);
      assert.equal(result.porPlataforma.instagram.newCount, 0);

      const visto = db.getSearchSeen('receta', 'instagram');
      assert.deepEqual(visto.terminos, ['macri', 'gobierno porteño', 'gcba']);
      assert.equal(visto.term, 'macri', 'el término del motivo no cambia');
      assert.equal(visto.outcome, 'descartado');
      assert.equal(visto.runId, 41, 'la corrida que lo decidió');
      assert.equal(visto.firstSeenAt, primerVisto);
      assert.deepEqual(db.getSearchSeen('obra', 'instagram').terminos, ['macri', 'gcba'], 'al guardado también se le suma');
    } finally {
      restore();
    }
  });

  test('con el modelo caído el posteo se guarda sin clasificar y queda anotado como guardado', async () => {
    const restore = stubInstagram({ macri: [resultado({ id: 'caido', caption: 'se cayó el modelo justo acá' })], 'gobierno porteño': [], gcba: [] });
    try {
      await cycle(43);
      assert.equal(guardado('caido').title, null);
      assert.equal(db.getSearchSeen('caido', 'instagram').outcome, 'guardado');
    } finally {
      restore();
    }
  });

  test('sin texto y sin detalle no hubo decisión del modelo: no se anota y la corrida siguiente lo vuelve a ver como nuevo', async () => {
    const mudo = resultado({ id: 'mudo', caption: '' });
    const restore = stubInstagram({ macri: [mudo], 'gobierno porteño': [], gcba: [] });
    process.env.SEARCH_ENRICH_LIMIT = '0';
    try {
      llamadas.length = 0;
      let result = await cycle(44);
      assert.equal(llamadas.length, 0);
      assert.equal(db.getSearchSeen('mudo', 'instagram'), null);
      result = await cycle(45);
      assert.equal(result.porPlataforma.instagram.newCandidates, 1);
    } finally {
      delete process.env.SEARCH_ENRICH_LIMIT;
      restore();
    }
  });

  test('guardarEvaluado: solo anota resultados de búsqueda (una cuenta o una keyword de X no escriben en search_seen)', () => {
    const x = getPlatform('x');
    const tuit = { id: 'tuit-1', account: 'alguien', url: 'https://x.com/alguien/status/1', caption: 'un tuit', postedAt: POSTED, sourceType: 'keyword', sourceQuery: 'macri' };
    assert.equal(monitor.guardarEvaluado(tuit, { relevant: false, motivo: 'no' }, { platform: x, platformId: 'x' }), null);
    assert.equal(db.getSearchSeen('tuit-1', 'x'), null);
    const saved = monitor.guardarEvaluado(tuit, { relevant: true, title: 't', sentiment: 'neutral', tema: null, matchedReason: 'Búsqueda por palabra clave: "macri"' }, { platform: x, platformId: 'x' });
    assert.equal(saved.plataforma, 'x');
    assert.equal(db.getSearchSeen('tuit-1', 'x'), null);
  });
});

describe('db: términos de un resultado anotado', { concurrency: false }, () => {
  test('markSearchSeen junta términos sin repetir (sin distinguir mayúsculas) y no pisa lo guardado con un dato ausente', () => {
    db.markSearchSeen({ postId: 't1', plataforma: 'instagram', term: 'macri', outcome: 'descartado', motivo: 'no', llmUsd: 0.01, runId: 7, postedAt: POSTED, terminos: ['macri', 'GCBA'] });
    db.markSearchSeen({ postId: 't1', plataforma: 'instagram', term: 'gcba', outcome: 'descartado', terminos: ['Macri', 'jorgemacri'] });
    const fila = db.getSearchSeen('t1', 'instagram');
    assert.deepEqual(fila.terminos, ['macri', 'GCBA', 'jorgemacri']);
    assert.equal(fila.term, 'macri');
    assert.equal(fila.motivo, 'no');
    assert.equal(fila.llmUsd, 0.01);
    assert.equal(fila.runId, 7);
    assert.equal(fila.postedAt, POSTED);
  });

  test('addSearchSeenTerms: suma a una fila que existe, no crea una, y exige plataforma', () => {
    assert.equal(db.addSearchSeenTerms('t1', 'instagram', ['jorgemacri', 'policía de la ciudad']), true);
    assert.deepEqual(db.getSearchSeen('t1', 'instagram').terminos, ['macri', 'GCBA', 'jorgemacri', 'policía de la ciudad']);
    assert.equal(db.addSearchSeenTerms('t1', 'instagram', ['Policía de la Ciudad']), false, 'nada nuevo');
    assert.equal(db.addSearchSeenTerms('no-existe', 'instagram', ['macri']), false);
    assert.equal(db.getSearchSeen('no-existe', 'instagram'), null);
    assert.equal(db.addSearchSeenTerms('t1', 'x', ['macri']), false, 'por plataforma');
    assert.throws(() => db.addSearchSeenTerms('t1', undefined, ['macri']), /falta plataforma/);
  });
});
