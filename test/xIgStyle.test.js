'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-xig-'));
process.env.MONITORING_DB_PATH = path.join(dbDir, 'monitoring.db');

const db = require('../src/db');
const {
  normalizeTemas,
  formatTemasSection,
  assembleReport,
  MAX_TEMAS,
} = require('../src/temasConversacion');
const { buildWhatsAppReport: buildIgReport } = require('../src/reportBuilder');
const { buildWhatsAppReport: buildXReport } = require('../src/x/reportBuilder');
const { validateAndNormalizeAnalysis } = require('../src/x/validate');
const { buildReclamosFromAnalysis } = require('../src/x/reclamosFromAnalysis');
const { CLASSIFICATION_SYSTEM_PROMPT } = require('../src/x/prompt');
const { isValidReclamosPlataforma, isValidReclamosSeleccion, parseReclamosFilters } = require('../src/reclamosQuery');
const { CATEGORIA_FALLBACK } = require('../src/categoriasConfig');

describe('x-ig-style temas / geo / mapa', { concurrency: false }, () => {
  test('normalizeTemas recorta a 8 y tira vacíos', () => {
    const raw = [
      { titulo: '  A  ', texto: 'uno' },
      { titulo: '', texto: 'no' },
      { titulo: 'B', texto: '  ' },
      { titulo: 'C', texto: 'tres' },
      ...Array.from({ length: 10 }, (_, i) => ({ titulo: `T${i}`, texto: `x${i}` })),
    ];
    const temas = normalizeTemas(raw);
    assert.equal(temas.length, MAX_TEMAS);
    assert.equal(temas[0].titulo, 'A');
    assert.equal(formatTemasSection([]), '');
    assert.equal(formatTemasSection(null), '');
  });

  test('sección de temas se omite si está vacía y roundtrip before+temas+after', () => {
    const before = '2️⃣ KPI.';
    const after = '3️⃣ Apoyo.';
    const empty = assembleReport(before, [], after);
    assert.equal(empty, '2️⃣ KPI.\n\n3️⃣ Apoyo.');
    assert.doesNotMatch(empty, /TEMAS DE LA CONVERSACIÓN/);

    const temas = [{ titulo: 'Celular', texto: 'Quejas por distracción.' }];
    const full = assembleReport(before, temas, after);
    assert.match(full, /2️⃣ KPI/);
    assert.match(full, /TEMAS DE LA CONVERSACIÓN/);
    assert.match(full, /1\. Celular: Quejas por distracción\./);
    assert.match(full, /3️⃣ Apoyo/);
    assert.ok(full.indexOf('2️⃣') < full.indexOf('TEMAS DE LA CONVERSACIÓN'));
    assert.ok(full.indexOf('TEMAS DE LA CONVERSACIÓN') < full.indexOf('3️⃣'));
  });

  test('reporte IG inserta temas entre 2 y 3 (REQ-TEMAS-02)', () => {
    const result = buildIgReport({
      url: 'https://www.instagram.com/p/AAA/',
      post: { ownerFullName: 'GCBA', ownerUsername: 'gcba', likesCount: 1, commentsCount: 2, videoPlayCount: 3 },
      sample: [],
      isPartial: false,
      sampleSize: 0,
      totalComments: 0,
      classifications: [],
      qualitative: {
        posteoSobre: 'un anuncio',
        insightApoyo: ['a', 'b'],
        insightCriticas: ['c', 'd'],
        insightReclamos: ['e', 'f'],
        insightMedios: ['g', 'h'],
        posturaAudiencia: 'mixto',
        lecturaEstrategica: 'seguir',
        temasConversacion: [{ titulo: 'Coimas', texto: 'Menciones a sobornos.' }],
      },
    });
    assert.match(result.report, /ANÁLISIS DE POSTEO EN INSTAGRAM/);
    assert.ok(result.report.indexOf('2️⃣') < result.report.indexOf('TEMAS DE LA CONVERSACIÓN'));
    assert.ok(result.report.indexOf('TEMAS DE LA CONVERSACIÓN') < result.report.indexOf('3️⃣'));
    assert.equal(
      assembleReport(result.reportParts.beforeTemas, result.temas, result.reportParts.afterTemas),
      result.report
    );
  });

  test('reporte X con temas y roundtrip (REQ-TEMAS-02)', () => {
    const result = buildXReport({
      url: 'https://x.com/autor/status/1',
      post: {
        authorName: 'Autor',
        authorHandle: 'autor',
        likes: 1,
        retweets: 2,
        quotes: 0,
        replies: 0,
        bookmarks: 0,
        views: 1000,
      },
      sample: [],
      isPartial: false,
      classifications: [],
      qualitative: {
        posteoSobre: 'tema',
        insightApoyo: [],
        insightCriticas: [],
        insightReclamos: [],
        insightMedios: [],
        insightOrganica: [],
        insightEstetica: [],
        temasConversacion: [{ titulo: 'Zonas liberadas', texto: 'Quejas en el sur.' }],
      },
      influencerMap: new Map(),
    });
    assert.match(result.report, /TEMAS DE LA CONVERSACIÓN/);
    assert.match(result.report, /Zonas liberadas/);
    assert.doesNotMatch(result.report, /\*\*/);
    assert.equal(
      assembleReport(result.reportParts.beforeTemas, result.temas, result.reportParts.afterTemas),
      result.report
    );
  });

  test('validate X: barrio solo no genera reclamo; calle+altura sí; categoría inválida cae al fallback', () => {
    const sample = [
      { id: '1', username: 'a', text: 'esto pasa en Palermo', url: 'https://x.com/a/status/1' },
      { id: '2', username: 'b', text: 'hay un bache en Salta 250', url: 'https://x.com/b/status/2' },
    ];
    const parsed = {
      posteoSobre: 'seguridad',
      classifications: [
        { index: 1, sentiment: 'negativo', accountType: 'vecino', reclamosGeo: [] },
        {
          index: 2,
          sentiment: 'negativo',
          accountType: 'vecino',
          reclamosGeo: [
            {
              direccionDetectada: 'Salta 250',
              direccionNormalizada: 'SALTA 250',
              tematica: 'bache',
              categoria: 'NoExisteXYZ',
              tipoUbicacion: 'calle_altura',
            },
          ],
        },
      ],
      insightApoyo: [],
      insightCriticas: [],
      insightReclamos: [],
      insightMedios: [],
      insightOrganica: [],
      insightEstetica: [],
      temasConversacion: [{ titulo: '', texto: 'drop' }, { titulo: 'Ok', texto: 'Patrón real.' }],
    };
    const { qualitative, classifications } = validateAndNormalizeAnalysis(parsed, 2, sample);
    assert.equal(classifications[0].reclamosGeo.length, 0);
    assert.equal(classifications[1].reclamosGeo[0].categoria, CATEGORIA_FALLBACK);
    assert.equal(classifications[1].reclamosGeo[0].tipoUbicacion, 'calle_altura');
    assert.equal(qualitative.temasConversacion.length, 1);
    assert.equal(qualitative.temasConversacion[0].titulo, 'Ok');

    const rows = buildReclamosFromAnalysis({ url: 'https://x.com/autor/status/9', sample, classifications });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].precision, 'exacta');
    assert.equal(rows[0].plataforma, 'x');
  });

  test('lugar_nombrado queda con precisión aproximada', () => {
    const sample = [{ id: '3', username: 'c', text: 'la Plaza Italia está destruida', url: 'https://x.com/c/status/3' }];
    const classifications = [
      {
        sentiment: 'negativo',
        accountType: 'vecino',
        reclamosGeo: [
          {
            direccionDetectada: 'Plaza Italia',
            tipoUbicacion: 'lugar_nombrado',
            tematica: 'plaza abandonada',
            categoria: 'Espacio Público',
          },
        ],
      },
    ];
    const rows = buildReclamosFromAnalysis({ url: 'https://x.com/autor/status/9', sample, classifications });
    assert.equal(rows[0].precision, 'aproximada');
  });

  test('prompt X ya no lista las 9 categorías viejas y pide dirección accionable', () => {
    assert.match(CLASSIFICATION_SYSTEM_PROMPT, /calle_altura/);
    assert.match(CLASSIFICATION_SYSTEM_PROMPT, /Coyuntura \/ Otros/);
    assert.match(CLASSIFICATION_SYSTEM_PROMPT, /temasConversacion/);
    assert.doesNotMatch(
      CLASSIFICATION_SYSTEM_PROMPT,
      /Estacionamientos truchos", "Trapitos"/
    );
  });

  test('GET reclamos acepta todas las redes o un subconjunto', () => {
    assert.equal(isValidReclamosSeleccion(undefined), true);
    assert.equal(isValidReclamosSeleccion(['instagram', 'x']), true);
    assert.equal(isValidReclamosSeleccion(['tiktok', 'facebook']), true);
    assert.equal(isValidReclamosSeleccion(['youtube']), false);
    assert.equal(isValidReclamosSeleccion([]), false);
    assert.equal(isValidReclamosPlataforma('instagram'), true);
    assert.equal(isValidReclamosPlataforma('tiktok'), true);
    assert.equal(isValidReclamosPlataforma('youtube'), false);
    const filters = parseReclamosFilters({ plataforma: 'x,instagram', q: 'bache' });
    assert.deepEqual(filters.plataforma, ['x', 'instagram']);
    assert.equal(filters.q, 'bache');
    assert.equal(parseReclamosFilters({}).plataforma, undefined);
  });

  test('conteo por categoría respeta plataforma', () => {
    const now = new Date().toISOString();
    db.upsertReclamo({
      id: 'ig-1',
      comentarioId: 'ig-1',
      plataforma: 'instagram',
      postUrl: 'https://instagram.com/p/a',
      detectedAt: now,
      textoOriginal: 'ig',
      categoria: 'Higiene',
      direccionDetectada: 'Salta 1',
      geoStatus: 'ok',
      estado: 'Pendiente',
      x: 1,
      y: 1,
    });
    db.upsertReclamo({
      id: 'x-1',
      comentarioId: 'x-1',
      plataforma: 'x',
      postUrl: 'https://x.com/a/status/1',
      detectedAt: now,
      textoOriginal: 'x',
      categoria: 'Seguridad',
      direccionDetectada: 'Salta 2',
      geoStatus: 'ok',
      estado: 'Pendiente',
      x: 1,
      y: 1,
    });
    const ig = db.contarReclamosPorCategoria('instagram');
    const x = db.contarReclamosPorCategoria('x');
    const todas = db.contarReclamosPorCategoria();
    assert.ok((ig.Higiene || 0) >= 1);
    assert.equal(ig.Seguridad, undefined);
    assert.ok((x.Seguridad || 0) >= 1);
    assert.equal(x.Higiene, undefined);
    assert.ok((todas.Higiene || 0) >= 1);
    assert.ok((todas.Seguridad || 0) >= 1);

    const soloIg = db.listReclamosFiltered({ plataforma: ['instagram'] });
    assert.ok(soloIg.some((row) => row.id === 'ig-1'));
    assert.equal(soloIg.some((row) => row.id === 'x-1'), false);
    const ambas = db.listReclamosFiltered({});
    assert.ok(ambas.some((row) => row.id === 'ig-1'));
    assert.ok(ambas.some((row) => row.id === 'x-1'));
  });
});
