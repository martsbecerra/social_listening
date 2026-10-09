'use strict';

// Likes null (dato faltante: el autor oculta los likes, o el contador no
// llegó) en lo que alimenta la tabla de Monitoreo y el alcance contra la
// mediana de la cuenta (src/accountStats.js, lo que arma
// /api/monitoring/posts): un null NUNCA se compara como si fuera 0, el
// motivo de "sin referencia" es el verdadero (sin dato de este posteo /
// muestra chica / la cuenta no trae esa métrica), la mediana ignora los
// null, y un posteo con likes sin dato igual puede destacarse por sus
// comentarios (benchmark.top). La celda de la tabla muestra "—" para null
// (formatCount en public/js/monitoring.js). Fuente stubeada, base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

process.env.APIFY_API_TOKEN = 'token-de-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-likes-null-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');
// La regla del alcance (src/reachRule.js) con sus valores por defecto,
// aunque el entorno traiga otros: colchón 2000 para likes y 300 para
// comentarios, alto desde 1,5 y medio desde 1,1.
for (const name of Object.keys(process.env)) if (name.startsWith('REACH_')) delete process.env[name];
fs.writeFileSync(process.env.MONITORING_CONFIG_PATH, JSON.stringify({ instagram: { accounts: [], keywords: [] } }, null, 2) + '\n');

// Clasificador stubeado antes de cargar monitor.js (accountStats lo requiere).
const classifier = require('../src/classifier');
classifier.clasificarPosteo = async () => ({ relevant: true, title: 't', sentiment: 'neutral' });

const db = require('../src/db');
const accountStats = require('../src/accountStats');
const { getPlatform } = require('../src/platforms');
const instagram = getPlatform('instagram');

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();

instagram.isConfigured = () => true;
instagram.fetchAccountFollowers = async () => 1234;

function setStats(account, { nPosts = 12, medianLikes = 100, medianComments = 10, postType = null }) {
  db.upsertAccountStats({ account, plataforma: 'instagram', postType, nPosts, medianLikes, medianComments, computedAt: iso(1) });
}
const classify = (account, likes, comments) => accountStats.classifyPostAgainstBenchmark({ account, plataforma: 'instagram', likes, comments });

describe('likes null: nunca cuenta como 0', { concurrency: false }, () => {
  test('alcance: un likes null queda sin referencia por "sin-dato", no "bajo"; los comentarios se clasifican igual', () => {
    setStats('visible', { medianLikes: 16, medianComments: 100 });

    const conCero = classify('visible', 0, 500);
    assert.equal(conCero.likes.level, 'bajo', 'un 0 real contra una mediana de 16 sí es bajo');
    assert.equal(conCero.likes.ratio, 2000 / 2016);

    const sinDato = classify('visible', null, 500);
    assert.equal(sinDato.likes.level, 'sin-referencia', 'null no es 0: no se clasifica');
    assert.equal(sinDato.likes.reason, 'sin-dato');
    assert.equal(sinDato.likes.ratio, undefined);
    assert.equal(sinDato.comments.level, 'alto');
    assert.equal(sinDato.comments.ratio, 2, '(500 + 300) / (100 + 300)');

    const indefinido = classify('visible', undefined, 500);
    assert.equal(indefinido.likes.reason, 'sin-dato', 'undefined se trata igual que null');
  });

  test('motivo de "sin referencia": sin-dato (falta el valor), muestra-chica (pocos posteos o sin cálculo), sin-mediana (la cuenta no trae la métrica)', () => {
    setStats('chica', { nPosts: 3, medianLikes: 10, medianComments: 1 });
    setStats('oculta', { nPosts: 12, medianLikes: null, medianComments: 5 });

    assert.equal(classify('chica', 50, 5).likes.reason, 'muestra-chica');
    assert.equal(classify('nunca-calculada', 50, 5).likes.reason, 'muestra-chica');
    assert.equal(classify('nunca-calculada', 50, 5).likes.nPosts, 0);

    const oculta = classify('oculta', 5, 5);
    assert.equal(oculta.likes.level, 'sin-referencia');
    assert.equal(oculta.likes.reason, 'sin-mediana', 'hay muestra, pero ningún posteo de la cuenta trae likes');
    assert.equal(oculta.comments.level, 'bajo', 'los comentarios sí se clasifican: 5 contra una mediana de 5');

    assert.equal(classify('oculta', null, 5).likes.reason, 'sin-dato', 'si además falta el valor, manda eso');
    assert.equal(classify('chica', null, 5).likes.reason, 'sin-dato');

    // Con referencia no hay motivo.
    setStats('normalita', { medianLikes: 10, medianComments: 1 });
    assert.equal(classify('normalita', 10, 1).likes.reason, undefined);
  });

  test('destacado (benchmark.top): con likes sin dato se destaca por comentarios; con las dos gana la de mejor nivel y, a igual nivel, la de mayor razón; sin ninguna, null', () => {
    // Mediana 2000 de likes y 100 de comentarios: las razones salen redondas
    // ((valor + 2000) / 4000 y (valor + 300) / 400).
    setStats('despega', { medianLikes: 2000, medianComments: 100 });

    const soloComentarios = classify('despega', null, 500);
    assert.deepEqual(soloComentarios.top, { metric: 'comments', label: 'comentarios', level: 'alto', ratio: 2, best: 2 });

    const soloLikes = classify('despega', 10000, null);
    assert.deepEqual(soloLikes.top, { metric: 'likes', label: 'likes', level: 'alto', ratio: 3, best: 3 });

    assert.equal(classify('despega', 10000, 500).top.metric, 'likes', 'likes 3x contra comentarios 2x');
    assert.equal(classify('despega', 6000, 1300).top.metric, 'comments', 'comentarios 4x contra likes 2x');
    assert.equal(classify('despega', 6000, 500).top.metric, 'comments', 'empate en 2x: comentarios, como siempre');

    // El nivel va en la respuesta: "Se despegaron" muestra solo los alto.
    const comun = classify('despega', 2000, 100).top;
    assert.deepEqual(comun, { metric: 'comments', label: 'comentarios', level: 'bajo', ratio: 1, best: 1 });
    assert.equal(classify('despega', 2600, 100).top.level, 'normal', 'likes 1,15x: medio, no se destaca');
    assert.equal(classify('despega', 2600, 100).top.metric, 'likes');

    assert.equal(classify('despega', null, null).top, null);
    assert.equal(classify('cuenta-sin-benchmark', 10000, 500).top, null);

    // Cuenta que oculta los likes: mediana de likes null, comentarios con referencia.
    setStats('oculta2', { medianLikes: null, medianComments: 100 });
    const oculta = classify('oculta2', null, 1526);
    assert.equal(oculta.likes.level, 'sin-referencia');
    assert.deepEqual(oculta.top, { metric: 'comments', label: 'comentarios', level: 'alto', ratio: 4.565, best: 4.565 });

    // Manda el nivel antes que la razón: una métrica puede pasar el corte de
    // alto sin llegar a su piso (queda en normal) y no le gana a una que sí
    // es alto, aunque su razón sea mayor.
    const frenada = accountStats.highlightOf({ likes: { level: 'normal', ratio: 4 }, comments: { level: 'alto', ratio: 1.6 } });
    assert.deepEqual(frenada, { metric: 'comments', label: 'comentarios', level: 'alto', ratio: 1.6, best: 1.6 });
    assert.equal(accountStats.highlightOf({ likes: { level: 'alto', ratio: 1.6 }, comments: { level: 'normal', ratio: 4 } }).metric, 'likes');
    assert.equal(accountStats.highlightOf({ likes: { level: 'bajo', ratio: 1.05 }, comments: { level: 'bajo', ratio: 1 } }).metric, 'likes');

    assert.equal(accountStats.highlightOf({}), null);
    assert.equal(accountStats.highlightOf(), null);
  });

  test('mediana: ignora null y undefined (no los cuenta como 0); todo null da null', () => {
    assert.equal(accountStats.median([null, 10, undefined, 30]), 20);
    assert.equal(accountStats.median([null, null]), null);
    assert.equal(accountStats.median([0, null, 0, 4]), 0, 'un 0 real sí cuenta');
  });

  test('benchmark de una cuenta con likes ocultos: la mediana de likes queda null (no 0) y la de comentarios se calcula', async () => {
    const sample = (likesOf) =>
      Array.from({ length: 6 }, (_, i) => ({
        id: `ocu-${i}`, account: 'ocultadora', url: `https://www.instagram.com/p/ocu-${i}/`, caption: 'muestra', hashtagsText: '',
        likes: likesOf(i), comments: 10 + i, postedAt: iso(i + 1), postType: 'reel', sourceType: 'account', sourceQuery: null,
      }));

    // Todos los posteos con likes ocultos.
    instagram.scrapeAccount = async () => sample(() => null);
    await accountStats.computeAccountStats('ocultadora', 'instagram');
    const global = db.getAccountStats('ocultadora', 'instagram', null);
    assert.equal(global.medianLikes, null, 'sin ningún dato de likes no hay mediana: nunca 0');
    assert.equal(global.medianComments, 12.5);
    const posteo = classify('ocultadora', null, 400);
    assert.equal(posteo.likes.level, 'sin-referencia');
    assert.equal(posteo.comments.level, 'alto', '(400 + 300) / (12,5 + 300) = 2,24');
    assert.equal(posteo.top.metric, 'comments');

    // La mitad con likes ocultos: la mediana sale solo de los que traen dato.
    instagram.scrapeAccount = async () => sample((i) => (i % 2 === 0 ? null : 100 + i));
    await accountStats.computeAccountStats('ocultadora', 'instagram');
    assert.equal(db.getAccountStats('ocultadora', 'instagram', null).medianLikes, 103, 'mediana de 101, 103 y 105');
  });

  test('lo que recibe la tabla: un posteo guardado con likes null llega como null (la celda muestra "—"), y un refresco sin ese dato lo deja null', () => {
    assert.equal(
      db.saveDetectedPost({
        id: 'sin-likes', account: 'visible', url: 'https://www.instagram.com/p/sin-likes/', caption: 'obras', matchedReason: 'test',
        likes: null, comments: 7, postedAt: iso(1), title: 't', sentiment: 'neutral', postType: null, followers: null, plataforma: 'instagram',
      }),
      true
    );
    const leer = () => db.listDetectedPosts({ page: 1, pageSize: 100, plataforma: 'instagram' }).posts.find((p) => p.id === 'sin-likes');
    assert.equal(leer().likes, null);
    assert.equal(leer().comments, 7);

    db.applyMetricsRefresh('sin-likes', { likes: null, comments: 9 });
    assert.equal(leer().likes, null, 'sigue sin dato: no se inventa un 0');
    assert.equal(leer().comments, 9);

    db.applyMetricsRefresh('sin-likes', { likes: -1, comments: 9 });
    assert.equal(leer().likes, null, 'el centinela -1 tampoco se guarda');

    db.applyMetricsRefresh('sin-likes', { likes: 0, comments: 9 });
    assert.equal(leer().likes, 0, 'un 0 real sí se escribe');
  });
});
