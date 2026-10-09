'use strict';

// Regla del alcance de una métrica (src/reachRule.js): razón con colchón,
// piso para llegar a alto, cortes de alto y de medio, y lectura de los seis
// números desde el .env. Módulo puro: sin base, sin red, sin reloj.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, resolveReachRule, reachLevel, describeReachRule } = require('../src/reachRule');

// La regla por defecto, sin depender de lo que haya en el entorno.
const rule = resolveReachRule({});
const level = (metric, value, median, r = rule) => reachLevel(metric, value, median, r).level;
const ratio = (metric, value, median, r = rule) => reachLevel(metric, value, median, r).ratio;

describe('alcance: regla con colchón y piso', () => {
  test('valores por defecto: likes 2000 / 1000, comentarios 300 / 150, alto 1,5 y medio 1,1', () => {
    assert.deepEqual(rule, {
      highRatio: 1.5,
      midRatio: 1.1,
      likes: { cushion: 2000, floor: 1000 },
      comments: { cushion: 300, floor: 150 },
    });
    assert.deepEqual(resolveReachRule({ REACH_LIKES_CUSHION: '', REACH_MID_RATIO: '   ' }), rule, 'vacío = valor por defecto');
    assert.equal(DEFAULTS.REACH_LIKES_CUSHION, 2000);
  });

  test('colchón: una cuenta chica ya no da alto por unos pocos likes de más', () => {
    // Antes: 100 likes contra mediana 2 = 50 veces = alto.
    const chica = reachLevel('likes', 100, 2, rule);
    assert.equal(chica.level, 'bajo');
    assert.equal(chica.ratio, 2100 / 2002);
    assert.equal(chica.cushion, 2000, 'la respuesta dice con qué colchón se calculó');
    assert.equal(chica.floor, 1000);

    assert.equal(level('likes', 180, 1.5), 'bajo', '180 contra 1,5: 1,09');
    assert.equal(level('comments', 45, 0.5), 'normal', '45 contra 0,5: 1,15');
    assert.equal(level('comments', 20, 2), 'bajo', '20 contra 2: 1,06');

    // Una cuenta grande se mide casi igual que sin colchón.
    assert.equal(level('likes', 6136, 3206), 'alto', '1,56');
    assert.equal(level('likes', 1244, 3063), 'bajo', '0,64');
    assert.equal(level('likes', 3723, 2784), 'normal', '1,196');
  });

  test('bordes de likes: 1,09 es bajo, 1,10 es medio, 1,50 es alto', () => {
    // Mediana 0: la razón es (likes + 2000) / 2000.
    assert.equal(ratio('likes', 180, 0), 1.09);
    assert.equal(level('likes', 180, 0), 'bajo');
    assert.equal(level('likes', 199, 0), 'bajo', '1,0995 no llega');
    assert.equal(ratio('likes', 200, 0), 1.1);
    assert.equal(level('likes', 200, 0), 'normal', 'justo en el corte ya es medio');
    assert.equal(level('likes', 999, 0), 'normal', '1,4995 no llega a alto');
    assert.equal(ratio('likes', 1000, 0), 1.5);
    assert.equal(level('likes', 1000, 0), 'alto', 'justo en el corte ya es alto');

    // Con mediana: medio desde 1,1 x mediana + 200; alto desde 1,5 x mediana + 1000.
    assert.equal(level('likes', 309, 100), 'bajo');
    assert.equal(level('likes', 310, 100), 'normal');
    assert.equal(level('likes', 1149, 100), 'normal');
    assert.equal(level('likes', 1150, 100), 'alto');
  });

  test('bordes de comentarios: 1,09 es bajo, 1,10 es medio, 1,50 es alto', () => {
    assert.equal(ratio('comments', 27, 0), 1.09);
    assert.equal(level('comments', 27, 0), 'bajo');
    assert.equal(level('comments', 29, 0), 'bajo');
    assert.equal(ratio('comments', 30, 0), 1.1);
    assert.equal(level('comments', 30, 0), 'normal');
    assert.equal(level('comments', 149, 0), 'normal');
    assert.equal(ratio('comments', 150, 0), 1.5);
    assert.equal(level('comments', 150, 0), 'alto');

    // Con mediana 10: medio desde 41, alto desde 165.
    assert.equal(level('comments', 40, 10), 'bajo');
    assert.equal(level('comments', 41, 10), 'normal');
    assert.equal(level('comments', 164, 10), 'normal');
    assert.equal(level('comments', 165, 10), 'alto');
    // Medianas con medio punto (cantidad par de posteos).
    assert.equal(level('comments', 162, 7.5), 'alto', '462 / 307,5 = 1,502');
    assert.equal(level('comments', 161, 7.5), 'normal');
  });

  test('mediana 0: 0 es lo normal de la cuenta (1x, bajo) y la razón nunca divide por cero', () => {
    assert.deepEqual(reachLevel('likes', 0, 0, rule), { level: 'bajo', ratio: 1, cushion: 2000, floor: 1000 });
    assert.deepEqual(reachLevel('comments', 0, 0, rule), { level: 'bajo', ratio: 1, cushion: 300, floor: 150 });
    assert.equal(level('likes', 2, 0), 'bajo', 'antes 2 likes contra mediana 0 daban alto');
    assert.equal(level('comments', 1, 0), 'bajo');
    // Por debajo de lo normal también es bajo: no hay un cuarto nivel.
    assert.equal(level('likes', 0, 500), 'bajo');
  });

  test('piso: sin el mínimo absoluto no hay alto, aunque la razón alcance; nunca baja a bajo', () => {
    // Con los valores por defecto el colchón ya exige más que el piso. El
    // piso actúa cuando el colchón se achica.
    const colchonChico = resolveReachRule({ REACH_LIKES_CUSHION: '200', REACH_COMMENTS_CUSHION: '20' });
    assert.equal(ratio('likes', 600, 0, colchonChico), 4);
    assert.equal(level('likes', 600, 0, colchonChico), 'normal', '4x, pero menos de 1.000 likes');
    assert.equal(level('likes', 999, 0, colchonChico), 'normal');
    assert.equal(level('likes', 1000, 0, colchonChico), 'alto');
    assert.equal(level('comments', 149, 0, colchonChico), 'normal', '8,45x, pero menos de 150 comentarios');
    assert.equal(level('comments', 150, 0, colchonChico), 'alto');
    // El piso es de cada métrica: 150 likes no alcanzan.
    assert.equal(level('likes', 150, 0, colchonChico), 'normal');

    const sinPiso = resolveReachRule({ REACH_LIKES_CUSHION: '200', REACH_LIKES_FLOOR: '0' });
    assert.equal(level('likes', 600, 0, sinPiso), 'alto', 'piso 0 = sin piso');
  });

  test('colchón 0: la razón es valor / mediana, y contra mediana 0 se calcula contra 1', () => {
    const sinColchon = resolveReachRule({ REACH_LIKES_CUSHION: '0', REACH_LIKES_FLOOR: '0' });
    assert.equal(ratio('likes', 150, 100, sinColchon), 1.5);
    assert.equal(level('likes', 150, 100, sinColchon), 'alto');
    assert.equal(level('likes', 100, 100, sinColchon), 'bajo', '1x');
    assert.deepEqual(reachLevel('likes', 0, 0, sinColchon), { level: 'bajo', ratio: 1, cushion: 0, floor: 0 });
    assert.equal(ratio('likes', 2, 0, sinColchon), 2);
    assert.equal(level('likes', 2, 0, sinColchon), 'alto');
  });

  test('vuelta atrás desde el .env: colchón 0, piso 0 y medio en 0,5 dan la regla anterior', () => {
    // La de antes: razón = valor / mediana (contra 1 si la mediana es 0),
    // bajo por debajo de 0,5, alto desde 1,5.
    const anterior = resolveReachRule({
      REACH_LIKES_CUSHION: '0',
      REACH_LIKES_FLOOR: '0',
      REACH_COMMENTS_CUSHION: '0',
      REACH_COMMENTS_FLOOR: '0',
      REACH_MID_RATIO: '0.5',
    });
    for (const metric of ['likes', 'comments']) {
      assert.equal(ratio(metric, 180, 1.5, anterior), 120, metric);
      assert.equal(level(metric, 180, 1.5, anterior), 'alto');
      assert.equal(level(metric, 49, 100, anterior), 'bajo');
      assert.equal(level(metric, 50, 100, anterior), 'normal');
      assert.equal(level(metric, 149, 100, anterior), 'normal');
      assert.equal(level(metric, 150, 100, anterior), 'alto');
      assert.equal(level(metric, 0, 0, anterior), 'normal', 'mediana 0: 0 o 1 era normal');
      assert.equal(level(metric, 1, 0, anterior), 'normal');
      assert.equal(level(metric, 2, 0, anterior), 'alto', 'mediana 0: 2 o más era alto');
    }
  });

  test('.env: los seis números se leen del entorno; la coma decimal vale', () => {
    const custom = resolveReachRule({
      REACH_LIKES_CUSHION: '500',
      REACH_LIKES_FLOOR: ' 300 ',
      REACH_COMMENTS_CUSHION: '100',
      REACH_COMMENTS_FLOOR: '50',
      REACH_HIGH_RATIO: '2',
      REACH_MID_RATIO: '1,25',
    });
    assert.deepEqual(custom, {
      highRatio: 2,
      midRatio: 1.25,
      likes: { cushion: 500, floor: 300 },
      comments: { cushion: 100, floor: 50 },
    });
    // Los cortes del entorno son los que deciden.
    assert.equal(level('likes', 100, 0, custom), 'bajo', '1,2 con corte de medio en 1,25');
    assert.equal(level('likes', 125, 0, custom), 'normal');
    assert.equal(level('likes', 499, 0, custom), 'normal', '1,998 con corte de alto en 2');
    assert.equal(level('likes', 500, 0, custom), 'alto');
    assert.equal(resolveReachRule({ REACH_MID_RATIO: '1.2' }).midRatio, 1.2);
  });

  test('.env: un valor mal escrito aborta con el nombre de la variable', () => {
    const falla = (env, variable) =>
      assert.throws(
        () => resolveReachRule(env),
        (err) => {
          assert.match(err.message, new RegExp(variable));
          assert.equal(err.userMessage, err.message);
          return true;
        },
        JSON.stringify(env)
      );
    // "2.000" se leería como 2: no se acepta.
    falla({ REACH_LIKES_CUSHION: '2.000' }, 'REACH_LIKES_CUSHION');
    falla({ REACH_LIKES_FLOOR: '1,5' }, 'REACH_LIKES_FLOOR');
    falla({ REACH_COMMENTS_CUSHION: '-300' }, 'REACH_COMMENTS_CUSHION');
    falla({ REACH_COMMENTS_FLOOR: 'ciento cincuenta' }, 'REACH_COMMENTS_FLOOR');
    falla({ REACH_HIGH_RATIO: 'alto' }, 'REACH_HIGH_RATIO');
    falla({ REACH_HIGH_RATIO: '-1.5' }, 'REACH_HIGH_RATIO');
    falla({ REACH_MID_RATIO: '0' }, 'REACH_MID_RATIO');
    falla({ REACH_MID_RATIO: '1.1x' }, 'REACH_MID_RATIO');
    // El corte de medio tiene que quedar por debajo del de alto.
    falla({ REACH_MID_RATIO: '1.5' }, 'REACH_MID_RATIO');
    falla({ REACH_MID_RATIO: '2', REACH_HIGH_RATIO: '1.8' }, 'REACH_HIGH_RATIO');
  });

  test('la línea del arranque muestra los números en uso', () => {
    assert.equal(
      describeReachRule(rule),
      'likes colchón 2000 / piso 1000 · comentarios colchón 300 / piso 150 · alto desde 1,5x · medio desde 1,1x'
    );
  });
});
