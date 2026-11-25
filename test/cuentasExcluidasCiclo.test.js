'use strict';

// Cuentas excluidas en el ciclo (src/monitor.js, rama
// clasificacion-foto-y-exclusiones): una publicación nueva de una cuenta de
// la lista se descarta sin pasar por el modelo, con el motivo en search_seen
// (outcome 'excluido'). Si la búsqueda ya trae la cuenta, antes del detalle
// (no se paga); si la cuenta recién llega con el detalle, después. La
// corrida siguiente no la vuelve a evaluar. Adapters y clasificador
// stubeados; base temporal; sin Apify ni modelo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-excluidas-ciclo-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
const CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.APIFY_API_TOKEN = 'token-de-test';
process.env.APIFY_REAL_COST = '0';
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = CONFIG_PATH;
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
process.env.POST_IMAGES = '0';
delete process.env.SEARCH_ENRICH_LIMIT;
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: [], keywords: [], searches: ['gobierno porteño'] }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

// Clasificador stubeado ANTES de cargar monitor.js (que lo destructura).
const classifier = require('../src/classifier');
const clasificados = [];
classifier.clasificarPosteo = async (caption, { autor } = {}) => {
  clasificados.push(autor);
  return { relevant: true, title: 'gestión porteña', sentiment: 'neutral', tema: 'Coyuntura / Otros', motivo: 'habla de CABA' };
};

const db = require('../src/db');
const monitor = require('../src/monitor');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const visto = (id) => raw.prepare("SELECT outcome, motivo FROM search_seen WHERE post_id = ? AND plataforma = 'instagram'").get(id);

function resultado({ id, account, caption = '' }) {
  return {
    id,
    account,
    url: `https://www.instagram.com/p/${id}/`,
    caption,
    hashtagsText: '',
    likes: null,
    comments: null,
    postedAt: new Date().toISOString(),
    postType: 'imagen',
    followers: null,
    sourceType: 'search',
    sourceQuery: 'gobierno porteño',
  };
}

describe('cuentas excluidas en el ciclo', { concurrency: false }, () => {
  test('antes del detalle si la búsqueda trae la cuenta, después si la trae el detalle; sin modelo; anotado con el motivo', async () => {
    db.addCuentaExcluida({ plataforma: 'instagram', cuenta: 'otra_excluida', motivo: 'medio de Valparaíso' });
    const pedidas = [];
    const originals = {};
    for (const key of ['isConfigured', 'scrapeAccount', 'scrapeHashtag', 'scrapeSearch', 'fetchPostDetails']) originals[key] = instagram[key];
    Object.assign(instagram, {
      isConfigured: () => true,
      scrapeAccount: async () => [],
      scrapeHashtag: async () => [],
      scrapeSearch: async () => [
        resultado({ id: 'SEV1', account: 'populares_sevilla' }),
        resultado({ id: 'SEV2', account: 'Populares_Sevilla', caption: 'Con Feijóo tendremos presupuestos' }),
        resultado({ id: 'NOSE', account: 'N/D' }),
        resultado({ id: 'BIEN', account: 'vecino' }),
      ],
      fetchPostDetails: async (urls) => {
        pedidas.push(...urls);
        return [
          { ...resultado({ id: 'NOSE', account: 'otra_excluida', caption: 'El gobierno porteño de Valparaíso' }), sourceType: 'search', sourceQuery: null },
          { ...resultado({ id: 'BIEN', account: 'vecino', caption: 'El gobierno porteño anunció veredas' }), sourceType: 'search', sourceQuery: null },
        ];
      },
    });
    const logs = [];
    const consoleLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const r = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });

      // Las de Sevilla no se pidieron al detalle; la de cuenta desconocida sí.
      assert.deepEqual(pedidas.sort(), ['https://www.instagram.com/p/BIEN/', 'https://www.instagram.com/p/NOSE/']);
      // Al modelo llegó solo la legítima.
      assert.deepEqual(clasificados, ['vecino']);
      assert.equal(r.porPlataforma.instagram.newCount, 1);
      assert.equal(r.porPlataforma.instagram.excluidas, 3);
      for (const id of ['SEV1', 'SEV2']) {
        assert.equal(visto(id).outcome, 'excluido', id);
        assert.match(visto(id).motivo, /^Cuenta excluida: Partido Popular de Sevilla/);
      }
      assert.deepEqual({ ...visto('NOSE') }, { outcome: 'excluido', motivo: 'Cuenta excluida: medio de Valparaíso' });
      assert.equal(visto('BIEN').outcome, 'guardado');
      assert.ok(logs.some((l) => l.includes('[monitor] instagram: 3 publicaciones de cuentas excluidas, descartadas sin pasar por el modelo (@populares_sevilla: 2, @otra_excluida: 1)')));

      // La corrida siguiente no vuelve a pedir ni a evaluar nada de eso.
      pedidas.length = 0;
      clasificados.length = 0;
      const r2 = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      assert.deepEqual(pedidas, []);
      assert.deepEqual(clasificados, []);
      assert.equal(r2.porPlataforma.instagram.excluidas, undefined);
    } finally {
      console.log = consoleLog;
      Object.assign(instagram, originals);
    }
  });
});
