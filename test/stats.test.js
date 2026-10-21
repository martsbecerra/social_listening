'use strict';

// Estadísticas (fase 2 del rediseño, estadisticas-backend): las lecturas de
// la base para la sección (db.listPostsForStats, getFirstPostedAt,
// listFollowersForStats), los bloques de src/stats.js y la respuesta armada
// desde la base. Base temporal; nunca toca data/monitoring.db, ni llama a
// Apify o a un LLM. Las fechas de los posteos se escriben en hora de
// Argentina (UTC-3) con enArgentina().

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-stats-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
// La regla del alcance con sus valores por defecto (colchón 2000 / 300).
for (const name of Object.keys(process.env)) if (name.startsWith('REACH_')) delete process.env[name];

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const stats = require('../src/stats');
const { CATEGORIA_FALLBACK } = require('../src/categoriasConfig');

/** ISO UTC de una fecha y hora de Argentina (UTC-3, sin horario de verano). */
function enArgentina(fecha, hora, minuto = 0) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora + 3, minuto)).toISOString();
}

let siguienteId = 1000;
function guardar(campos) {
  const id = String(campos.id || siguienteId++);
  const plataforma = campos.plataforma || 'instagram';
  const url = plataforma === 'x' ? `https://x.com/cuenta/status/${id}` : `https://www.instagram.com/p/C${id}/`;
  assert.equal(
    db.saveDetectedPost({
      id,
      plataforma,
      url,
      account: 'cuenta',
      caption: 'texto',
      matchedReason: 'Búsqueda: x',
      likes: 10,
      comments: 2,
      ...campos,
      id,
    }),
    true
  );
  return id;
}

describe('db: lecturas para Estadísticas', { concurrency: false }, () => {
  test('sin posteos: getFirstPostedAt da null y las listas vienen vacías', () => {
    assert.equal(db.getFirstPostedAt('instagram'), null);
    assert.deepEqual(db.listPostsForStats({ plataforma: 'instagram', desdeIso: '2026-01-01T00:00:00.000Z', hastaIso: '2027-01-01T00:00:00.000Z' }), []);
    assert.equal(db.listFollowersForStats('instagram').size, 0);
  });

  test('listPostsForStats: rango [desde, hasta), solo visibles y de esa plataforma, en orden de publicación', () => {
    const a = guardar({ postedAt: '2026-10-02T12:00:00.000Z' });
    const b = guardar({ postedAt: '2026-10-01T03:00:00.000Z' }); // justo en el borde de abajo: entra
    guardar({ postedAt: '2026-10-03T03:00:00.000Z' }); // justo en el borde de arriba: no entra
    const ignorado = guardar({ postedAt: '2026-10-02T13:00:00.000Z' });
    assert.equal(db.ignorePost(ignorado, 'instagram'), true);
    guardar({ plataforma: 'x', postedAt: '2026-10-02T14:00:00.000Z' });

    const filas = db.listPostsForStats({ plataforma: 'instagram', desdeIso: '2026-10-01T03:00:00.000Z', hastaIso: '2026-10-03T03:00:00.000Z' });
    assert.deepEqual(filas.map((f) => f.id), [b, a]);
    assert.deepEqual(
      Object.keys(filas[0]).sort(),
      ['account', 'caption', 'comments', 'followers', 'id', 'likes', 'post_type', 'posted_at', 'sentiment', 'tema', 'title'].sort()
    );
  });

  test('getFirstPostedAt: el primer posteo visible de la plataforma', () => {
    const viejo = guardar({ postedAt: '2026-09-01T10:00:00.000Z' });
    assert.equal(db.ignorePost(viejo, 'instagram'), true); // ignorado: no cuenta
    assert.equal(db.getFirstPostedAt('instagram'), '2026-10-01T03:00:00.000Z');
    assert.equal(db.getFirstPostedAt('x'), '2026-10-02T14:00:00.000Z');
  });

  test('listFollowersForStats: manda la caché; sin caché, el posteo más reciente que lo trae', () => {
    guardar({ account: 'medio', followers: 500, postedAt: '2026-10-05T10:00:00.000Z' });
    guardar({ account: 'chica', followers: 90, postedAt: '2026-10-04T10:00:00.000Z' });
    const t = Date.now();
    while (Date.now() - t < 3); // detected_at distinto del anterior
    guardar({ account: 'chica', followers: 120, postedAt: '2026-10-01T10:00:00.000Z' }); // detectado después: más reciente
    guardar({ account: 'sin_numero', followers: null, postedAt: '2026-10-05T10:00:00.000Z' });
    db.upsertAccountFollowers({ account: 'medio', plataforma: 'instagram', followers: 800 });
    db.upsertAccountFollowers({ account: 'medio', plataforma: 'x', followers: 5 });

    const seguidores = db.listFollowersForStats('instagram');
    assert.equal(seguidores.get('medio'), 800);
    assert.equal(seguidores.get('chica'), 120);
    assert.equal(seguidores.has('sin_numero'), false);
  });

  test('sin plataforma tiran, como el resto de las funciones por plataforma', () => {
    assert.throws(() => db.listPostsForStats({ desdeIso: 'a', hastaIso: 'b' }), /falta plataforma/);
    assert.throws(() => db.getFirstPostedAt(), /falta plataforma/);
    assert.throws(() => db.listFollowersForStats(''), /falta plataforma/);
  });
});

describe('stats: período y fechas en hora de Argentina', () => {
  const MEDIODIA_10_OCT = Date.parse('2026-10-10T15:00:00.000Z'); // 12:00 en Argentina

  test('sin fechas: los últimos 30 días hasta hoy, y el anterior de igual largo pegado antes', () => {
    assert.deepEqual(stats.resolverPeriodo({ ahora: MEDIODIA_10_OCT }), {
      periodo: { desde: '2026-09-11', hasta: '2026-10-10', dias: 30 },
      anterior: { desde: '2026-08-12', hasta: '2026-09-10' },
    });
  });

  test('"hoy" es el de Argentina: a las 23:30 del 10/10 (02:30 UTC del 11) sigue siendo el 10', () => {
    const r = stats.resolverPeriodo({ ahora: Date.parse('2026-10-11T02:30:00.000Z') });
    assert.equal(r.periodo.hasta, '2026-10-10');
  });

  test('con fechas: el período pedido y el anterior', () => {
    assert.deepEqual(stats.resolverPeriodo({ desde: '2026-10-01', hasta: '2026-10-07' }), {
      periodo: { desde: '2026-10-01', hasta: '2026-10-07', dias: 7 },
      anterior: { desde: '2026-09-24', hasta: '2026-09-30' },
    });
  });

  test('fechas mal pedidas: 400 con un mensaje para la pantalla', () => {
    const casos = [
      [{ desde: '2026-10-01' }, /juntas/],
      [{ hasta: '2026-10-01' }, /juntas/],
      [{ desde: '2026-10-1', hasta: '2026-10-07' }, /AAAA-MM-DD/],
      [{ desde: '2026-02-30', hasta: '2026-03-07' }, /AAAA-MM-DD/],
      [{ desde: '2026-10-08', hasta: '2026-10-07' }, /posterior/],
      [{ desde: '2025-01-01', hasta: '2026-01-02' }, /366/],
    ];
    for (const [pedido, mensaje] of casos) {
      assert.throws(
        () => stats.resolverPeriodo(pedido),
        (err) => err.status === 400 && mensaje.test(err.userMessage),
        JSON.stringify(pedido)
      );
    }
  });

  test('un posteo de las 23:30 en Argentina cae en la hora 23 de ese día, no en el siguiente', () => {
    assert.equal(stats.inicioDelDia('2026-10-04'), Date.parse('2026-10-04T03:00:00.000Z'));
    const post = stats.prepararPosteo({ id: '1', posted_at: enArgentina('2026-10-04', 23, 30), sentiment: null, tema: null });
    assert.equal(post.posted_at, '2026-10-05T02:30:00.000Z');
    assert.equal(post.fecha, '2026-10-04');
    assert.equal(post.hora, 23);
    assert.equal(post.dow, 6); // domingo: el lunes es el 0
    const mapa = stats.mapaPorHora([post]);
    assert.equal(mapa.length, 7);
    assert.ok(mapa.every((fila) => fila.length === 24));
    assert.equal(mapa[6][23], 1);
    assert.equal(mapa.flat().reduce((a, b) => a + b, 0), 1);
  });

  test('el período efectivo arranca en el primer día con datos y termina hoy', () => {
    const periodo = { desde: '2026-09-01', hasta: '2026-10-30' };
    assert.deepEqual(stats.rangoEfectivo(periodo, '2026-09-20', '2026-10-10'), { desde: '2026-09-20', hasta: '2026-10-10', dias: 21 });
    assert.equal(stats.rangoEfectivo(periodo, '2026-11-01', '2026-11-05'), null); // entero antes del primer posteo
    assert.equal(stats.rangoEfectivo(periodo, null, '2026-10-10'), null); // base sin posteos
  });
});

describe('stats: bloques', () => {
  const preparar = (campos) =>
    stats.prepararPosteo({ id: String(siguienteId++), account: 'cuenta', likes: 0, comments: 0, sentiment: 'neutral', tema: null, posted_at: enArgentina('2026-10-01', 12), ...campos });

  test('palabras: frases de la lista enteras, sin palabras vacías, hashtags, menciones, links ni números, con la forma más usada', () => {
    const posts = [
      preparar({ title: 'Jorge Macri inauguró la plaza', caption: 'Hoy Jorge Macri recorrió la plaza con vecinos. #BuenosAires @gcba https://t.co/abc más info en la bio' }),
      preparar({ title: 'Plaza renovada', caption: 'La PLAZA quedó así. jorge macri dijo que hay más obras en 2026' }),
      preparar({ title: null, caption: 'Vecinos y vecinas de la Ciudad: #JorgeMacri' }),
    ];
    const palabras = stats.contarPalabras(posts, ['Jorge Macri', '#JorgeMacri', 'gobierno de la ciudad']);
    assert.deepEqual(palabras.slice(0, 3), [
      { palabra: 'Jorge Macri', n: 2 },
      { palabra: 'plaza', n: 2 },
      { palabra: 'vecinos', n: 2 },
    ]);
    const mostradas = palabras.map((p) => p.palabra.toLowerCase());
    assert.ok(mostradas.includes('#jorgemacri'), 'un hashtag de la lista cuenta');
    for (const fuera of ['hoy', 'con', 'más', 'info', 'bio', 'hay', 'que', 'dijo', '#buenosaires', '@gcba', 'abc', 'https', '2026', 'jorge', 'macri']) {
      assert.ok(!mostradas.includes(fuera), `no cuenta "${fuera}"`);
    }
    assert.ok(mostradas.includes('obras'));
  });

  test('palabras: a lo sumo 60', () => {
    const caption = Array.from({ length: 80 }, (_, i) => `palabra${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ');
    assert.equal(stats.contarPalabras([preparar({ caption })]).length, 60);
  });

  test('menciones: Jorge Macri, la Ciudad y los dos, por palabra entera y con hashtags o menciones', () => {
    const posts = [
      'Jorge Macri recorrió la plaza',
      'El GCBA anunció obras',
      'Blackri en la Ciudad',
      '#JorgeMacri y @gcba',
      'Una cabaña en Bariloche',
      'El jefe de gobierno habló',
    ].map((caption) => preparar({ caption }));
    assert.deepEqual(stats.contarMenciones(posts), { jorge: 4, ciudad: 3, ambos: 2 });
  });

  test('picos: días con el doble de lo habitual; con lo habitual en 0 no hay picos', () => {
    const porDia = [
      { fecha: '2026-10-01', total: 2 },
      { fecha: '2026-10-02', total: 5 },
      { fecha: '2026-10-03', total: 2 },
      { fecha: '2026-10-04', total: 4 },
      { fecha: '2026-10-05', total: 1 },
    ];
    const habitual = stats.habitualDe(porDia);
    assert.equal(habitual, 2);
    const picos = stats.calcularPicos(porDia, habitual, []);
    assert.deepEqual(
      picos.map((p) => [p.fecha, p.total, p.razon, p.posteo]),
      [
        ['2026-10-02', 5, 2.5, null],
        ['2026-10-04', 4, 2, null],
      ]
    );
    assert.deepEqual(stats.calcularPicos([{ fecha: '2026-10-01', total: 3 }, { fecha: '2026-10-02', total: 0 }, { fecha: '2026-10-03', total: 0 }], 0, []), []);
    assert.equal(stats.habitualDe([]), null);
  });

  test('tramos de los temas: por día hasta 14 días; más, de a 7 desde el primero', () => {
    assert.deepEqual(stats.tramosDeTemas({ desde: '2026-10-01', hasta: '2026-10-03', dias: 3 }), [
      { desde: '2026-10-01', hasta: '2026-10-01' },
      { desde: '2026-10-02', hasta: '2026-10-02' },
      { desde: '2026-10-03', hasta: '2026-10-03' },
    ]);
    assert.deepEqual(stats.tramosDeTemas({ desde: '2026-10-01', hasta: '2026-10-16', dias: 16 }), [
      { desde: '2026-10-01', hasta: '2026-10-07' },
      { desde: '2026-10-08', hasta: '2026-10-14' },
      { desde: '2026-10-15', hasta: '2026-10-16' },
    ]);
    assert.deepEqual(stats.tramosDeTemas(null), []);
  });
});

describe('stats: la respuesta armada desde la base', { concurrency: false }, () => {
  // Hoy es el 20/3/2026 a las 12:00 de Argentina. El primer posteo de la
  // base (de Instagram) es del 12/3: los posteos del bloque de arriba son de
  // septiembre y octubre, "en el futuro" de este reloj, y no entran en
  // ningún período de estos tests.
  const AHORA = Date.parse('2026-03-20T15:00:00.000Z');
  const FRASES = ['Jorge Macri', 'gobierno de la ciudad'];

  // diario: medianas de 100 likes y 10 comentarios en 10 posteos (con
  // colchón, 5000 likes da 7000 / 2100 = 3,33: alto). vecina: sin medianas,
  // sin referencia de alcance.
  const FIXTURE = [
    ['2026-03-12', 10, 0, 'diario', 150, 10, 'positivo', 'Transporte', 'Subte con vagones nuevos en la Ciudad'],
    ['2026-03-12', 18, 0, 'vecina', 20, 3, null, null, 'Jorge Macri no contesta los reclamos'],
    ['2026-03-13', 9, 0, 'diario', 120, 8, 'negativo', 'Seguridad', 'Robos en la plaza del barrio'],
    ['2026-03-13', 21, 0, 'vecina', 15, 1, 'neutral', 'Seguridad', 'Otra noche de robos en la plaza'],
    ['2026-03-15', 12, 0, 'diario', 130, 9, 'positivo', 'Transporte', 'El gobierno de la ciudad suma colectivos'],
    ['2026-03-15', 23, 30, 'vecina', 30, 2, 'negativo', null, 'Basura en la esquina hace días'],
    ['2026-03-16', 8, 0, 'diario', 5000, 12, 'negativo', 'Seguridad', 'Jorge Macri y el operativo en la plaza'],
    ['2026-03-16', 9, 0, 'diario', 3500, 11, 'positivo', 'Transporte', 'Jorge Macri inauguró la estación'],
    ['2026-03-16', 11, 0, 'diario', 100, 10, 'neutral', 'Transporte', 'Cortes por obras en el subte'],
    ['2026-03-16', 14, 0, 'diario', 160, 9, 'negativo', 'Seguridad', 'Polémica por el operativo'],
    ['2026-03-16', 17, 0, 'vecina', 40, 4, 'negativo', 'Seguridad', 'Vecinos contra el operativo en la plaza'],
    ['2026-03-16', 20, 0, 'vecina', 25, 2, null, 'Seguridad', 'Más quejas por el operativo'],
    ['2026-03-17', 10, 0, 'diario', 110, 10, 'neutral', 'Transporte', 'Horarios del subte'],
    ['2026-03-17', 15, 0, 'vecina', 12, 1, 'positivo', 'Transporte', 'Por fin anda el ascensor'],
    ['2026-03-18', 13, 0, 'diario', 90, 9, 'neutral', null, 'Pronóstico del fin de semana'],
    ['2026-03-19', 9, 0, 'diario', 140, 10, 'positivo', 'Transporte', 'Bicisendas nuevas en la Ciudad'],
    ['2026-03-19', 22, 0, 'vecina', 18, 2, 'negativo', 'Seguridad', 'Jorge Macri y la seguridad'],
  ];
  const ids = {};

  test('carga: posteos, medianas de la cuenta y seguidores', () => {
    for (const [fecha, hora, minuto, account, likes, comments, sentiment, tema, caption] of FIXTURE) {
      const id = guardar({
        account,
        likes,
        comments,
        sentiment,
        tema,
        caption,
        title: caption,
        postType: 'imagen',
        followers: account === 'diario' ? 900 : 50,
        postedAt: enArgentina(fecha, hora, minuto),
      });
      ids[`${fecha} ${account} ${likes}`] = id;
    }
    db.upsertAccountStats({ account: 'diario', plataforma: 'instagram', postType: null, nPosts: 10, medianLikes: 100, medianComments: 10 });
    db.upsertAccountFollowers({ account: 'diario', plataforma: 'instagram', followers: 1000 });
    assert.equal(db.getFirstPostedAt('instagram'), enArgentina('2026-03-12', 10));
  });

  test('30 días: porDia y lo habitual arrancan en el primer día con datos; sin datos antes, los *Anterior van en null', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', frases: FRASES, conAlcance: true, ahora: AHORA });

    assert.deepEqual(r.periodo, {
      desde: '2026-02-19',
      hasta: '2026-03-20',
      dias: 30,
      desdeEfectivo: '2026-03-12',
      hastaEfectivo: '2026-03-20',
      diasEfectivos: 9,
    });
    assert.deepEqual(r.anterior, { desde: '2026-01-20', hasta: '2026-02-18', desdeEfectivo: null, hastaEfectivo: null, diasEfectivos: 0 });

    assert.deepEqual(
      r.porDia.map((d) => [d.fecha, d.total]),
      [
        ['2026-03-12', 2],
        ['2026-03-13', 2],
        ['2026-03-14', 0],
        ['2026-03-15', 2],
        ['2026-03-16', 6],
        ['2026-03-17', 2],
        ['2026-03-18', 1],
        ['2026-03-19', 2],
        ['2026-03-20', 0],
      ]
    );
    assert.deepEqual(r.porDia[0], { fecha: '2026-03-12', total: 2, positivo: 1, neutral: 1, negativo: 0 }); // sentimiento null = neutral
    assert.equal(r.habitual, 2);

    assert.equal(r.picos.length, 1);
    assert.deepEqual(r.picos[0], {
      fecha: '2026-03-16',
      total: 6,
      razon: 3,
      posteo: { id: ids['2026-03-16 diario 5000'], titulo: 'Jorge Macri y el operativo en la plaza', cuenta: 'diario' },
    });

    const res = r.resumen;
    assert.equal(res.relevantes, 17);
    assert.equal(res.seDespegaron, 2);
    assert.equal(res.negativoPct, 35.3); // 6 de 17
    assert.equal(res.positivoPct, 29.4); // 5 de 17 (los dos null cuentan como neutrales)
    assert.equal(res.conversacion, FIXTURE.reduce((s, f) => s + f[4] + f[5], 0));
    for (const campo of ['relevantesAnterior', 'seDespegaronAnterior', 'negativoPctAnterior', 'positivoPctAnterior', 'conversacionAnterior']) {
      assert.equal(res[campo], null, campo);
    }
    for (const serie of Object.values(res.tendencias)) assert.equal(serie.length, 12);
    assert.equal(res.tendencias.relevantes.reduce((a, b) => a + b, 0), 17);
    assert.equal(res.tendencias.seDespegaron.reduce((a, b) => a + b, 0), 2);

    assert.equal(r.porHora[6][23], 1); // el domingo 15/3 a las 23:30
    assert.equal(r.porHora.flat().reduce((a, b) => a + b, 0), 17);
  });

  test('30 días: temas, cuentas, ranking, palabras y menciones', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', frases: FRASES, conAlcance: true, ahora: AHORA });

    assert.equal(r.semanas.length, 9); // 9 días con datos: la evolución va por día
    assert.deepEqual(
      r.temas.map((t) => [t.tema, t.n]),
      [
        ['Seguridad', 7],
        ['Transporte', 7],
        [CATEGORIA_FALLBACK, 3],
      ]
    );
    const otros = r.temas.find((t) => t.tema === CATEGORIA_FALLBACK);
    assert.deepEqual([otros.negativo, otros.neutral, otros.positivo], [1, 2, 0]);
    assert.deepEqual(otros.porSemana, [1, 0, 0, 1, 0, 0, 1, 0, 0]);

    const diario = r.cuentas.find((c) => c.cuenta === 'diario');
    const vecina = r.cuentas.find((c) => c.cuenta === 'vecina');
    assert.equal(diario.publicaciones, 10);
    assert.equal(diario.impacto, FIXTURE.filter((f) => f[3] === 'diario').reduce((s, f) => s + f[4] + f[5], 0));
    assert.equal(diario.seguidores, 1000); // manda account_followers
    assert.equal(diario.seDespego, 2);
    assert.ok(Math.abs(diario.mejorRazon - 7000 / 2100) < 1e-9);
    assert.equal(vecina.seguidores, 50); // sin caché: el del posteo
    assert.equal(vecina.mejorRazon, null);
    assert.equal(vecina.seDespego, 0);
    assert.deepEqual([vecina.negativo, vecina.neutral, vecina.positivo], [3, 3, 1]);

    assert.equal(r.ranking.length, 10); // los 10 de diario, que son los únicos con referencia
    assert.deepEqual(r.ranking[0], {
      id: ids['2026-03-16 diario 5000'],
      titulo: 'Jorge Macri y el operativo en la plaza',
      cuenta: 'diario',
      fecha: enArgentina('2026-03-16', 8),
      metrica: 'likes',
      valor: 5000,
      mediana: 100,
      razon: r.ranking[0].razon,
      sentimiento: 'negativo',
    });
    assert.ok(Math.abs(r.ranking[0].razon - 7000 / 2100) < 1e-9);
    assert.equal(r.ranking[1].id, ids['2026-03-16 diario 3500']);
    for (let i = 1; i < r.ranking.length; i++) assert.ok(r.ranking[i - 1].razon >= r.ranking[i].razon);

    // "Jorge Macri", "operativo" y "plaza" están en 4 posteos cada una: a igual
    // cantidad, en orden alfabético.
    assert.deepEqual(r.palabras.slice(0, 3), [
      { palabra: 'Jorge Macri', n: 4 },
      { palabra: 'operativo', n: 4 },
      { palabra: 'plaza', n: 4 },
    ]);
    assert.ok(r.palabras.some((p) => p.palabra === 'gobierno de la ciudad' && p.n === 1));
    assert.deepEqual(r.menciones, { jorge: 4, ciudad: 3, ambos: 0 });
  });

  test('el período anterior con datos en parte: cuenta solo lo que hay, y el posteo de las 23:30 del 15 queda en el 15', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', desde: '2026-03-16', hasta: '2026-03-20', conAlcance: true, ahora: AHORA });
    assert.deepEqual(r.anterior, { desde: '2026-03-11', hasta: '2026-03-15', desdeEfectivo: '2026-03-12', hastaEfectivo: '2026-03-15', diasEfectivos: 4 });
    assert.equal(r.resumen.relevantes, 11);
    assert.equal(r.resumen.relevantesAnterior, 6);
    assert.equal(r.resumen.seDespegaronAnterior, 0);
    assert.equal(r.resumen.negativoPctAnterior, 33.3); // 2 de 6
    assert.equal(r.porDia[0].fecha, '2026-03-16');
  });

  test('un período anterior con datos pero sin posteos da 0, no null (y los porcentajes, null)', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', desde: '2026-03-15', hasta: '2026-03-15', conAlcance: true, ahora: AHORA });
    assert.equal(r.resumen.relevantes, 2);
    assert.equal(r.resumen.relevantesAnterior, 0); // el 14 tiene datos (es después del primer posteo) y ninguna publicación
    assert.equal(r.resumen.negativoPctAnterior, null);
    assert.equal(r.resumen.conversacionAnterior, 0);
  });

  test('sin alcance (plataforma sin benchmark): nadie se despega y no hay ranking', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', conAlcance: false, ahora: AHORA });
    assert.equal(r.resumen.seDespegaron, 0);
    assert.deepEqual(r.ranking, []);
    assert.ok(r.cuentas.every((c) => c.mejorRazon == null && c.seDespego === 0));
    assert.equal(r.picos[0].posteo.id, ids['2026-03-16 diario 5000']); // sin razón, el de más likes + comentarios
  });

  test('un período sin datos (todo antes del primer posteo): bloques vacíos, nunca días en cero', () => {
    const r = stats.armarEstadisticas({ plataforma: 'instagram', desde: '2026-02-01', hasta: '2026-02-07', conAlcance: true, ahora: AHORA });
    assert.equal(r.periodo.diasEfectivos, 0);
    assert.deepEqual(r.porDia, []);
    assert.equal(r.habitual, null);
    assert.deepEqual(r.picos, []);
    assert.deepEqual(r.semanas, []);
    assert.equal(r.resumen.relevantes, 0);
    assert.equal(r.resumen.negativoPct, null);
    assert.equal(r.resumen.relevantesAnterior, null);
  });

  test('sin plataforma: 400', () => {
    assert.throws(() => stats.armarEstadisticas({ ahora: AHORA }), (err) => err.status === 400);
  });
});

// La ruta, en una app de prueba en un puerto local de esta máquina, montada
// con statsRoutes.register como en server.js (el login y el chequeo de
// plataforma de /api/monitoring quedan en server.js). Usa los posteos de
// marzo del bloque de arriba con fechas explícitas: el resultado no depende
// del día en que corra el test.
describe('GET /api/monitoring/stats', { concurrency: false }, () => {
  const express = require('express');
  const statsRoutes = require('../src/statsRoutes');
  let server;
  let base;
  let configFor = () => ({ keywords: ['Jorge Macri'], searches: ['gobierno de la ciudad'] });

  test('arranca la app de prueba', async () => {
    const app = express();
    statsRoutes.register(app, { configFor: (p) => configFor(p), conAlcance: (p) => p === 'instagram' });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test('responde todos los bloques del período en un solo JSON', async () => {
    const res = await fetch(`${base}/api/monitoring/stats?plataforma=instagram&desde=2026-03-12&hasta=2026-03-20`);
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.deepEqual(Object.keys(r), [
      'periodo',
      'anterior',
      'resumen',
      'porDia',
      'habitual',
      'picos',
      'porHora',
      'palabras',
      'menciones',
      'semanas',
      'temas',
      'cuentas',
      'ranking',
    ]);
    assert.equal(r.resumen.relevantes, 17);
    assert.equal(r.resumen.relevantesAnterior, null); // el anterior (3 al 11 de marzo) es antes del primer posteo
    assert.equal(r.resumen.seDespegaron, 2);
    assert.ok(r.palabras.some((p) => p.palabra === 'gobierno de la ciudad'), 'las búsquedas también son frases');
  });

  test('fechas mal pedidas: 400 con el mensaje', async () => {
    for (const [query, mensaje] of [
      ['desde=2026-03-12', /juntas/],
      ['desde=12/03/2026&hasta=2026-03-20', /AAAA-MM-DD/],
      ['desde=2026-03-20&hasta=2026-03-12', /posterior/],
    ]) {
      const res = await fetch(`${base}/api/monitoring/stats?plataforma=instagram&${query}`);
      assert.equal(res.status, 400, query);
      assert.match((await res.json()).error, mensaje);
    }
  });

  test('sin plataforma: 400', async () => {
    const res = await fetch(`${base}/api/monitoring/stats`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /plataforma/);
  });

  test('un error inesperado: 500 con un mensaje genérico', async () => {
    configFor = () => {
      throw new Error('config ilegible');
    };
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${base}/api/monitoring/stats?plataforma=instagram`);
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /No se pudieron armar las estadísticas/);
    } finally {
      console.error = errorOriginal;
    }
  });

  test('cierra la app de prueba', async () => {
    await new Promise((resolve) => server.close(resolve));
  });
});
