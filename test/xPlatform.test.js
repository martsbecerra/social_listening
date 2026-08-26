'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-x-'));
process.env.MONITORING_DB_PATH = path.join(dbDir, 'monitoring.db');

const db = require('../src/db');
const { parseCount } = require('../src/x/parseCount');
const {
  parseAndMergeInfluencerCsvs,
  normalizeHandle,
} = require('../src/x/influencersParse');
const { isValidXPostUrl, parseXPostUrl } = require('../src/x/url');
const {
  levelFromViews,
  levelFromInteractions,
  computePerformanceLevels,
  computeWeightedSentimentPercentages,
} = require('../src/x/kpis');
const { dropQuoteOfQuotes, normalizeThread } = require('../src/x/threadNormalize');
const { buildTop6, formatInsightBlock, buildReclamosCsv, buildWhatsAppReport } = require('../src/x/reportBuilder');
const { EMPTY_INSIGHT } = require('../src/x/validate');
const { buildReclamosFromAnalysis } = require('../src/x/reclamosFromAnalysis');
const { extractJsonObject, getFetchConfig, openRouterGrokModel } = require('../src/x/grokFetch');

const NUMERIC_CSV = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'x-influencers', 'antik-pro.csv'),
  'utf8'
);
const EXTRA_CSV = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'x-influencers', 'antik-pro-extra.csv'),
  'utf8'
);

describe('x-platform parse/kpis/url', { concurrency: false }, () => {
  test('parseCount: Mil no es millón; millones sí', () => {
    assert.equal(parseCount('163,2 Mil'), 163200);
    assert.equal(parseCount('86,6 Mil'), 86600);
    assert.equal(parseCount('1,6 millones'), 1600000);
    assert.equal(parseCount('45K'), 45000);
    assert.equal(parseCount('1.2M'), 1200000);
    assert.equal(parseCount(164000), 164000);
    assert.equal(parseCount('638'), 638);
  });

  test('merge de ambos CSV: una fila por handle, preferir numéricos (REQ-X-05)', () => {
    const merged = parseAndMergeInfluencerCsvs(NUMERIC_CSV, EXTRA_CSV);
    const byHandle = new Map(merged.map((r) => [r.handle, r]));
    assert.equal(byHandle.get('cbuteler').seguidores, 88100);
    assert.equal(byHandle.get('pablolanusse').seguidores, 164000);
    assert.ok(byHandle.has('winston_dunhill'));
    assert.equal(normalizeHandle('@Winston_Dunhill\n'), 'winston_dunhill');
    assert.ok(byHandle.size > 31);
    assert.equal(merged.filter((r) => r.handle === 'cbuteler').length, 1);
  });

  test('URLs de X (REQ-X-01)', () => {
    assert.equal(isValidXPostUrl('https://x.com/usuario/status/1234567890'), true);
    assert.equal(isValidXPostUrl('https://twitter.com/usuario/status/1234567890'), true);
    assert.equal(isValidXPostUrl('https://x.com/i/web/status/123'), true);
    assert.equal(isValidXPostUrl('https://www.instagram.com/p/AAA/'), false);
    assert.equal(parseXPostUrl('https://x.com/foo/status/99').id, '99');
  });

  test('KPIs independientes y +5% (REQ-X-04)', () => {
    const levels = computePerformanceLevels({
      views: 80_000,
      likes: 100,
      retweets: 100,
      quotes: 100,
      replies: 200,
    });
    assert.equal(levels.viewsLevel, 'Alto');
    assert.equal(levels.interactionsLevel, 'Bajo');
    assert.equal(levelFromViews(44999), 0);
    assert.equal(levelFromViews(45000), 1);
    assert.equal(levelFromViews(100000), 2);
    assert.equal(levelFromViews(100001), 3);
    assert.equal(levelFromInteractions(599), 0);
    assert.equal(levelFromInteractions(1500), 1);
    assert.equal(levelFromInteractions(1501), 2);
    assert.equal(levelFromInteractions(2501), 3);

    const sample = [
      { retweets: 10, likes: 0, replies: 0 },
      { retweets: 10, likes: 0, replies: 0 },
    ];
    const classifications = [
      { sentiment: 'positivo', accountType: 'vecino' },
      { sentiment: 'negativo', accountType: 'vecino' },
    ];
    const metrics = computeWeightedSentimentPercentages(sample, classifications);
    assert.equal(metrics.positivoPct, 55);
    assert.equal(metrics.negativoPct, 45);
  });

  test('descarta QT de QT (REQ-X-02)', () => {
    const kept = dropQuoteOfQuotes('orig', [
      { kind: 'reply', quotedId: null },
      { kind: 'quote', quotedId: 'orig' },
      { kind: 'quote', quotedId: 'otro-qt' },
    ]);
    assert.equal(kept.length, 2);
    assert.equal(kept.some((i) => i.quotedId === 'otro-qt'), false);

    const thread = normalizeThread(
      {
        post: { id: 'orig', url: 'https://x.com/a/status/orig', likes: 1, retweets: 0, quotes: 1, replies: 0, views: 10, authorHandle: 'a', text: 'hola' },
        items: [
          { id: 'q1', kind: 'quote', quotedId: 'orig', authorHandle: 'b', text: 'ok', likes: 0, retweets: 0 },
          { id: 'q2', kind: 'quote', quotedId: 'q1', authorHandle: 'c', text: 'no', likes: 0, retweets: 0 },
        ],
      },
      'https://x.com/a/status/orig'
    );
    assert.equal(thread.items.length, 1);
    assert.equal(thread.items[0].id, 'q1');
  });

  test('Top 6 por RTs y Sin registros (REQ-X-03)', () => {
    const sample = [
      { username: 'autor', text: 'post', retweets: 50, url: 'https://x.com/autor/status/1', kind: 'original' },
      { username: 'uno', text: 'bien', retweets: 20, url: 'https://x.com/uno/status/2' },
      { username: 'dos', text: 'mal', retweets: 80, url: 'https://x.com/dos/status/3' },
    ];
    const classifications = [
      { sentiment: 'positivo', accountType: 'oficial' },
      { sentiment: 'positivo', accountType: 'vecino' },
      { sentiment: 'negativo', accountType: 'opositor' },
    ];
    const pos = buildTop6(sample, classifications, 'positivo', new Map());
    assert.equal(pos.length, 2);
    assert.match(pos[0], /@autor/);
    assert.equal(formatInsightBlock([]), EMPTY_INSIGHT);

    const report = buildWhatsAppReport({
      url: 'https://x.com/autor/status/1',
      post: { authorName: 'Autor', authorHandle: 'autor', likes: 1, retweets: 50, quotes: 0, replies: 0, bookmarks: 0, views: 1000 },
      sample,
      isPartial: false,
      classifications,
      qualitative: {
        posteoSobre: 'tema',
        insightApoyo: [],
        insightCriticas: [],
        insightReclamos: [],
        insightMedios: [],
        insightOrganica: [],
        insightEstetica: [],
      },
      influencerMap: new Map(),
    });
    assert.match(report.report, /ANÁLISIS DE POSTEO EN X/);
    assert.match(report.report, /Sin registros en esta categoría/);
    assert.doesNotMatch(report.report, /Postura de la Audiencia Orgánica/);
    assert.match(report.csv, /^Direccion_o_Ubicacion,Tematica,Link_Comentario,Usuario_Perfil/);
  });

  test('CSV de reclamos X y upsert plataforma=x (REQ-X-06)', () => {
    const sample = [
      {
        id: 'c1',
        username: 'vecino',
        url: 'https://x.com/vecino/status/9',
        text: 'hay un bache en Av. Rivadavia 1000',
        timestamp: '2026-08-01',
      },
    ];
    const classifications = [
      {
        sentiment: 'negativo',
        accountType: 'vecino',
        reclamosGeo: [
          { direccionDetectada: 'Av. Rivadavia 1000', tematica: 'bacheo', categoria: 'Otros' },
        ],
      },
    ];
    const csv = buildReclamosCsv(sample, classifications);
    assert.match(csv, /Av\. Rivadavia 1000/);
    assert.match(csv, /@vecino/);

    const rows = buildReclamosFromAnalysis({
      url: 'https://x.com/autor/status/1',
      sample,
      classifications,
    });
    assert.equal(rows[0].plataforma, 'x');
    db.upsertReclamo(rows[0]);
    const listed = db.listReclamosFiltered({});
    assert.ok(listed.some((r) => r.plataforma === 'x' && r.commentUrl === 'https://x.com/vecino/status/9'));
  });

  test('import padrón a SQLite', () => {
    const merged = parseAndMergeInfluencerCsvs(NUMERIC_CSV, EXTRA_CSV);
    db.upsertXInfluencers(merged);
    assert.equal(db.countXInfluencers(), merged.length);
    assert.equal(db.getXInfluencer('cbuteler').seguidores, 88100);
    assert.equal(db.getXInfluencerMap().get('cbuteler').tipoIdentidad, 'con_identidad');
  });

  test('extractJsonObject ignora fences markdown', () => {
    const obj = extractJsonObject('```json\n{"post":{"id":"1"}}\n```');
    assert.equal(obj.post.id, '1');
  });

  test('Grok fetch prefiere OpenRouter y prefija x-ai/', () => {
    const prevOr = process.env.OPENROUTER_API_KEY;
    const prevXai = process.env.XAI_API_KEY;
    const prevModel = process.env.XAI_MODEL;
    const prevXModel = process.env.OPENROUTER_X_MODEL;
    process.env.OPENROUTER_API_KEY = 'or-test';
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_MODEL;
    delete process.env.OPENROUTER_X_MODEL;
    try {
      const cfg = getFetchConfig();
      assert.equal(cfg.backend, 'openrouter');
      assert.equal(cfg.model, 'x-ai/grok-4.3');
      process.env.XAI_MODEL = 'grok-4.3';
      assert.equal(openRouterGrokModel(), 'x-ai/grok-4.3');
      process.env.XAI_MODEL = 'x-ai/grok-4.6';
      assert.equal(openRouterGrokModel(), 'x-ai/grok-4.6');
      process.env.OPENROUTER_X_MODEL = 'grok-4.3';
      assert.equal(openRouterGrokModel(), 'x-ai/grok-4.3');
    } finally {
      if (prevOr == null) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevOr;
      if (prevXai == null) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prevXai;
      if (prevModel == null) delete process.env.XAI_MODEL;
      else process.env.XAI_MODEL = prevModel;
      if (prevXModel == null) delete process.env.OPENROUTER_X_MODEL;
      else process.env.OPENROUTER_X_MODEL = prevXModel;
    }
  });
});
