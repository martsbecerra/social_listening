'use strict';

// Clasificación con contexto (septiembre 2026): src/classifier.js pasa a una
// sola función, clasificarPosteo, que en UNA llamada con schema devuelve
// relevancia + título + sentimiento con el mismo modelo que el análisis. La
// coincidencia literal con una keyword es una pista para el modelo, no una
// garantía de relevancia. Sin red: llm.requestStructuredAnalysis stubeado con
// un "modelo" de reglas sobre el caption, así los casos se leen como los
// reales; lo que se prueba es el cableado (la decisión del modelo se
// respeta, la pista llega al prompt, un fallo deja "sin clasificar"), no el
// juicio del modelo real.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APIFY_API_TOKEN = 'token-de-test';
delete process.env.CLASSIFIER_MODEL;
delete process.env.OPENROUTER_CLASSIFIER_MODEL;
delete process.env.CLAUDE_MODEL;
delete process.env.OPENROUTER_MODEL;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-clasificacion-contexto-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
const KEYWORDS = ['jorge macri', 'jefe de gobierno', 'pdlc'];
fs.writeFileSync(
  process.env.MONITORING_CONFIG_PATH,
  JSON.stringify({ instagram: { accounts: ['cuenta'], keywords: KEYWORDS }, x: { accounts: [], keywords: [] } }, null, 2) + '\n'
);

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// El LLM se stubea en la capa src/llm (por el objeto del módulo) ANTES de
// cargar el clasificador y monitor.js.
const llm = require('../src/llm');
let modo = 'normal'; // 'normal' | 'falla' | 'ilegible'
const llamadas = [];
llm.requestStructuredAnalysis = async (req) => {
  llamadas.push(req);
  if (modo === 'falla') {
    const e = new Error('OpenRouter falló: HTTP 500');
    e.isApiFailure = true;
    throw e;
  }
  if (modo === 'ilegible') return { parsed: { relevant: 'sí', title: 'x', sentiment: 'neutral' }, usage: null, attempts: 1 };
  return { parsed: modeloDeReglas(req.userPrompt), usage: null, attempts: 1 };
};

/** "Modelo" de mentira: aplica sobre el caption las reglas que el prompt le pide al real. */
function modeloDeReglas(userPrompt) {
  const texto = (userPrompt.split('POSTEO:\n')[1] || '').toLowerCase();
  if (/jorge macri|\bcaba\b|ciudad de buenos aires|porteñ/.test(texto)) {
    return { relevant: true, title: 'Jorge Macri y la gestión porteña', sentiment: 'positivo', motivo: 'habla de CABA' };
  }
  if (/ciudad de méxico|cdmx|brugada|sheinbaum/.test(texto)) {
    return { relevant: false, title: 'Política de la Ciudad de México', sentiment: 'neutral', motivo: 'es de la Ciudad de México' };
  }
  if (/bogotá/.test(texto)) return { relevant: false, title: 'Policía en Bogotá', sentiment: 'neutral', motivo: 'es de Bogotá' };
  if (/mauricio macri/.test(texto)) {
    return { relevant: false, title: 'Mauricio Macri', sentiment: 'neutral', motivo: 'Mauricio Macri sin relación con la gestión porteña' };
  }
  if (/milei|adorni/.test(texto)) {
    return { relevant: false, title: 'Gobierno nacional', sentiment: 'neutral', motivo: 'política nacional sin relación con CABA' };
  }
  return { relevant: false, title: 'Otro tema', sentiment: 'neutral', motivo: 'no habla de la Ciudad' };
}

const classifier = require('../src/classifier');
const providerConfig = require('../src/llm/providerConfig');
const db = require('../src/db');
const monitor = require('../src/monitor');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');
const x = getPlatform('x');

const ultima = () => llamadas[llamadas.length - 1];
const evaluar = (post) => monitor.evaluateRelevance({ hashtagsText: '', ...post }, KEYWORDS, { platform: instagram });

beforeEach(() => {
  modo = 'normal';
  llamadas.length = 0;
});

describe('clasificarPosteo: una sola llamada, con schema', { concurrency: false }, () => {
  test('pide structured output (schema estricto, nombre, pocos tokens) y devuelve lo que decidió el modelo', async () => {
    const r = await classifier.clasificarPosteo('Jorge Macri inauguró una escuela en Villa Lugano', {
      platformLabel: 'Instagram',
      pista: { termino: 'jorge macri', cuenta: 'cuenta' },
    });
    assert.deepEqual(r, { relevant: true, title: 'Jorge Macri y la gestión porteña', sentiment: 'positivo' });

    assert.equal(llamadas.length, 1);
    const req = ultima();
    assert.equal(req.schemaName, 'clasificacion_posteo');
    assert.equal(req.maxTokens, 300);
    assert.equal(req.schema.additionalProperties, false);
    assert.deepEqual(req.schema.required, ['relevant', 'title', 'sentiment']);
    assert.deepEqual(req.schema.properties.sentiment.enum, ['positivo', 'neutral', 'negativo']);
    assert.match(req.system, /posteo de Instagram/);
    assert.equal(
      req.userPrompt,
      'CONTEXTO: el texto contiene el término "jorge macri" de nuestra lista de seguimiento; es de la cuenta trackeada @cuenta.\n' +
      'POSTEO:\nJorge Macri inauguró una escuela en Villa Lugano'
    );
  });

  test('sin pista no hay línea CONTEXTO; el caption se recorta a 2000 caracteres; sin caption no llama al modelo', async () => {
    const r = await classifier.clasificarPosteo('receta de pan casero');
    assert.deepEqual(r, { relevant: false, title: 'Otro tema', sentiment: 'neutral' });
    assert.equal(ultima().userPrompt, 'POSTEO:\nreceta de pan casero');

    await classifier.clasificarPosteo('a'.repeat(3000));
    assert.equal(ultima().userPrompt.length, 'POSTEO:\n'.length + 2000);

    const antes = llamadas.length;
    assert.deepEqual(await classifier.clasificarPosteo('   '), { relevant: false, title: 'Sin descripción', sentiment: 'neutral' });
    assert.equal(llamadas.length, antes, 'sin texto no hay nada que preguntar');
  });

  test('fallo de la API o respuesta fuera del schema: sin clasificar, nunca descartado en silencio', async () => {
    const sinClasificar = { relevant: true, title: null, sentiment: null, unclassified: true };
    const errores = [];
    const originalError = console.error;
    console.error = (msg) => errores.push(String(msg));
    try {
      modo = 'falla';
      assert.deepEqual(await classifier.clasificarPosteo('Jorge Macri inauguró una escuela'), sinClasificar);
      assert.match(errores[0], /falló la API del LLM/);
      modo = 'ilegible';
      assert.deepEqual(await classifier.clasificarPosteo('Jorge Macri inauguró una escuela'), sinClasificar);
      assert.match(errores[1], /respuesta inválida del modelo/);
    } finally {
      console.error = originalError;
    }
  });
});

describe('evaluateRelevance: el modelo decide, la keyword es una pista', { concurrency: false }, () => {
  test('coincidencia literal de keyword ya no da relevancia por hecho: un posteo de la Ciudad de México con "Jefe de Gobierno" no entra', async () => {
    const r = await evaluar({
      caption: 'Martí Batres, Jefe de Gobierno de la Ciudad de México, presentó el plan de movilidad del gobierno de la ciudad',
      sourceType: 'hashtag',
      account: 'noticiascdmx',
    });
    assert.equal(r.relevant, false);
    assert.match(ultima().userPrompt, /^CONTEXTO: el texto contiene el término "jefe de gobierno" de nuestra lista de seguimiento; llegó por un hashtag monitoreado/);
  });

  test('un posteo porteño con coincidencia literal entra, con el motivo base de siempre', async () => {
    const r = await evaluar({ caption: 'Jorge Macri recorrió la obra del Paseo del Bajo', sourceType: 'account', account: 'cuenta' });
    assert.equal(r.relevant, true);
    assert.equal(r.title, 'Jorge Macri y la gestión porteña');
    assert.equal(r.sentiment, 'positivo');
    assert.equal(r.matchedReason, 'Cuenta trackeada: @cuenta (coincidencia: "jorge macri")');
  });

  test('X en stand by: lo que llega por búsqueda por término entra directo, con título y sentimiento del modelo pero sin mirar relevant', async () => {
    const r = await monitor.evaluateRelevance(
      { caption: 'receta de pan casero', hashtagsText: '', sourceType: 'keyword', sourceQuery: 'Jorge Macri', account: 'alguien' },
      ['jorge macri'],
      { platform: x }
    );
    assert.deepEqual(r, { relevant: true, title: 'Otro tema', sentiment: 'neutral', unclassified: undefined, matchedReason: 'Búsqueda por palabra clave: "Jorge Macri"' });
    assert.match(ultima().system, /posteo de X/);
    assert.equal(ultima().userPrompt, 'CONTEXTO: llegó por la búsqueda del término "Jorge Macri" en X.\nPOSTEO:\nreceta de pan casero');
  });

  test('ciclo con el modelo caído: el posteo se guarda sin clasificar (motivo base, sin título) y el backfill lo completa después', async () => {
    const originals = { isConfigured: instagram.isConfigured, scrapeAccount: instagram.scrapeAccount, scrapeHashtag: instagram.scrapeHashtag, scrapeSearch: instagram.scrapeSearch };
    instagram.isConfigured = () => true;
    instagram.scrapeHashtag = async () => [];
    if (instagram.scrapeSearch) instagram.scrapeSearch = async () => [];
    instagram.scrapeAccount = async (account) => [
      { id: '9001', url: 'https://www.instagram.com/p/CAIDO/', caption: 'Jorge Macri anunció obras en Caballito', account, sourceType: 'account', likes: 1, comments: 1, postedAt: new Date().toISOString() },
    ];
    try {
      modo = 'falla';
      const originalError = console.error;
      console.error = () => {};
      let result;
      try {
        result = await monitor.runMonitoringCycle({ plataformas: ['instagram'] });
      } finally {
        console.error = originalError;
      }
      assert.equal(result.porPlataforma.instagram.newCount, 1);
      const guardado = db.listDetectedPosts({ plataforma: 'instagram' }).posts.find((p) => p.id === '9001');
      assert.ok(guardado, 'el posteo se guardó aunque el modelo haya fallado');
      assert.equal(guardado.title, null);
      assert.equal(guardado.sentiment, null);
      assert.equal(guardado.matched_reason, 'Cuenta trackeada: @cuenta (coincidencia: "jorge macri") — sin clasificar (falló el clasificador, relevancia sin verificar)');

      modo = 'normal';
      const backfill = await monitor.backfillClassification('instagram');
      assert.deepEqual(backfill, { classified: 1, stillPending: 0 });
      const completado = db.listDetectedPosts({ plataforma: 'instagram' }).posts.find((p) => p.id === '9001');
      assert.equal(completado.title, 'Jorge Macri y la gestión porteña');
      assert.equal(completado.sentiment, 'positivo');
    } finally {
      Object.assign(instagram, originals);
    }
  });
});

describe('un solo modelo LLM', { concurrency: false }, () => {
  test('providerConfig ya no conoce un modelo clasificador: el de análisis es el único', () => {
    assert.equal(providerConfig.getClassifierModel, undefined);
    assert.deepEqual(providerConfig.DEFAULT_MODELS, { anthropic: 'claude-sonnet-5', openrouter: 'anthropic/claude-sonnet-5' });
    assert.equal(providerConfig.getAnalysisModel('anthropic'), 'claude-sonnet-5');
    assert.equal(providerConfig.getAnalysisModel('openrouter'), 'anthropic/claude-sonnet-5');
    process.env.CLAUDE_MODEL = 'claude-opus-5';
    try {
      assert.equal(providerConfig.getAnalysisModel('anthropic'), 'claude-opus-5');
      assert.equal(providerConfig.getAnalysisModel('openrouter'), 'anthropic/claude-sonnet-5');
    } finally {
      delete process.env.CLAUDE_MODEL;
    }
  });

  test('CLASSIFIER_MODEL en el .env: aviso al arrancar, sin efecto sobre el modelo', () => {
    const avisos = [];
    assert.deepEqual(providerConfig.warnObsoleteModelVars((m) => avisos.push(m)), []);
    assert.equal(avisos.length, 0);

    process.env.CLASSIFIER_MODEL = 'claude-haiku-4-5';
    try {
      assert.deepEqual(providerConfig.warnObsoleteModelVars((m) => avisos.push(m)), ['CLASSIFIER_MODEL']);
      assert.equal(avisos.length, 1);
      assert.match(avisos[0], /CLASSIFIER_MODEL ya no se usa/);
      assert.match(avisos[0], /CLAUDE_MODEL/);
      assert.equal(providerConfig.getAnalysisModel('anthropic'), 'claude-sonnet-5', 'la variable vieja no pisa nada');
    } finally {
      delete process.env.CLASSIFIER_MODEL;
    }
  });
});
