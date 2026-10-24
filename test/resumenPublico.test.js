'use strict';

// GET /api/public/resumen (src/publicResumen.js): los números del login, sin
// sesión. Lo que importa: que pase el gate SIN sesión, que traiga solo
// cantidades y nombres de tema de la config (ningún título, texto, cuenta,
// término de búsqueda, URL ni dato de un reclamo), que guarde la respuesta
// 60 s y que un error no muestre detalles. Base temporal; app de prueba con
// el gate real. Nunca toca data/monitoring.db.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-resumen-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js
process.env.SESSION_SECRET = 'secreto-de-test';
process.env.APP_BASE_URL = 'http://localhost';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const publicResumen = require('../src/publicResumen');
const { createAuthGate } = require('../src/auth/gate');
const { CATEGORIAS, CATEGORIA_FALLBACK } = require('../src/categoriasConfig');

/** ISO UTC de una fecha y hora de Argentina (UTC-3). */
function enArgentina(fecha, hora, minuto = 0) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora + 3, minuto)).toISOString();
}

// Viernes 23/10/2026, 12:00 en Argentina.
let ahora = Date.parse(enArgentina('2026-10-23', 12));

// Textos que NO pueden aparecer en la respuesta.
const SECRETOS = ['TITULO-SECRETO', 'TEXTO-SECRETO', 'cuenta_secreta', 'termino-secreto', 'RECLAMO-SECRETO', 'autor_secreto', 'C-SECRETA'];

let siguiente = 5000;
function guardar({ plataforma = 'instagram', postedAt, tema = null, ignorado = false }) {
  const id = String(siguiente++);
  const url = plataforma === 'x' ? `https://x.com/cuenta_secreta/status/${id}` : `https://www.instagram.com/p/C-SECRETA${id}/`;
  assert.equal(
    db.saveDetectedPost({
      id,
      plataforma,
      url,
      account: 'cuenta_secreta',
      caption: 'TEXTO-SECRETO del posteo',
      title: 'TITULO-SECRETO del posteo',
      matchedReason: 'Búsqueda: termino-secreto · habla de algo',
      sentiment: 'positivo',
      tema,
      likes: 10,
      comments: 2,
      postedAt,
    }),
    true
  );
  if (ignorado) assert.equal(db.ignorePost(id, plataforma), true);
  return id;
}

let server;
let base;

before(async () => {
  guardar({ postedAt: enArgentina('2026-10-23', 10), tema: 'Seguridad' });
  guardar({ postedAt: enArgentina('2026-10-23', 0, 5), tema: null }); // sin tema: "Coyuntura / Otros"
  guardar({ plataforma: 'x', postedAt: enArgentina('2026-10-23', 9), tema: 'Transporte' }); // todas las redes
  guardar({ postedAt: enArgentina('2026-10-23', 11), tema: 'Seguridad', ignorado: true }); // ignorado: no cuenta
  guardar({ postedAt: enArgentina('2026-10-22', 23, 59), tema: 'Seguridad' }); // ayer: no es de hoy
  guardar({ postedAt: enArgentina('2026-10-03', 12), tema: 'Salud' }); // en los 30 días, fuera de los 7
  guardar({ postedAt: enArgentina('2026-09-13', 12), tema: 'Un tema que no existe' }); // el primero, fuera de los 30
  const reclamo = (id, geoStatus) =>
    db.upsertReclamo({
      id,
      comentarioId: id,
      plataforma: 'instagram',
      postUrl: 'https://www.instagram.com/p/C-SECRETA/',
      autor: 'autor_secreto',
      detectedAt: new Date(ahora).toISOString(),
      textoOriginal: 'RECLAMO-SECRETO en la vereda',
      categoria: 'Higiene',
      direccionDetectada: 'Salta 1',
      geoStatus,
      estado: 'Pendiente',
      x: 1,
      y: 1,
    });
  reclamo('r-1', 'ok');
  reclamo('r-2', 'fuera_caba'); // fuera de la Ciudad: no está en el mapa

  const app = express();
  app.use(createAuthGate());
  publicResumen.register(app, { runInfo: () => ({ runHours: [8, 12, 16, 20], corridasPorDia: 4 }), now: () => ahora });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /api/public/resumen', { concurrency: false }, () => {
  test('pasa sin sesión y trae solo cantidades y temas de la config', async () => {
    const res = await fetch(`${base}/api/public/resumen`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    const text = await res.text();
    for (const secreto of SECRETOS) assert.ok(!text.includes(secreto), `no sale "${secreto}"`);
    const r = JSON.parse(text);
    assert.deepEqual(Object.keys(r), [
      'generadoEn',
      'publicacionesHoy',
      'publicaciones30Dias',
      'reclamosEnMapa',
      'primerDia',
      'diasEscuchando',
      'corridasPorDia',
      'runHours',
      'temas',
    ]);
    assert.equal(r.publicacionesHoy, 3); // dos de Instagram y una de X, sin el ignorado
    assert.equal(r.publicaciones30Dias, 5); // más la de ayer y la del 3/10
    assert.equal(r.reclamosEnMapa, 1);
    assert.equal(r.primerDia, '2026-09-13');
    assert.equal(r.diasEscuchando, 41); // del 13/9 al 23/10, los dos incluidos
    assert.equal(r.corridasPorDia, 4);
    assert.deepEqual(r.runHours, [8, 12, 16, 20]);
    // Los 7 días: Seguridad (hoy y ayer), Transporte (X) y el sin tema.
    assert.deepEqual(
      r.temas.map((t) => [t.tema, t.n]),
      [
        ['Seguridad', 2],
        ...[['Transporte', 1], [CATEGORIA_FALLBACK, 1]].sort((a, b) => CATEGORIAS.indexOf(a[0]) - CATEGORIAS.indexOf(b[0])),
      ]
    );
    for (const t of r.temas) {
      assert.equal(t.orden, CATEGORIAS.indexOf(t.tema)); // el mismo color --cat-N que en la app
      assert.deepEqual(Object.keys(t), ['tema', 'n', 'orden']);
    }
  });

  test('guarda la respuesta 60 s', async () => {
    const antes = await (await fetch(`${base}/api/public/resumen`)).json();
    guardar({ postedAt: enArgentina('2026-10-23', 11, 30), tema: 'Seguridad' });
    ahora += 30 * 1000;
    const enCache = await (await fetch(`${base}/api/public/resumen`)).json();
    assert.equal(enCache.publicacionesHoy, antes.publicacionesHoy);
    assert.equal(enCache.generadoEn, antes.generadoEn);
    ahora += 31 * 1000;
    const nuevo = await (await fetch(`${base}/api/public/resumen`)).json();
    assert.equal(nuevo.publicacionesHoy, antes.publicacionesHoy + 1);
  });

  test('un error responde 503 genérico, sin detalles', async () => {
    const app = express();
    publicResumen.register(app, {
      runInfo: () => {
        throw new Error('detalle interno C:\\ruta\\secreta');
      },
    });
    const otro = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const r = await fetch(`http://127.0.0.1:${otro.address().port}/api/public/resumen`);
      assert.equal(r.status, 503);
      const body = await r.text();
      assert.deepEqual(JSON.parse(body), { error: 'No se pudo armar el resumen.' });
      assert.ok(!body.includes('ruta'));
    } finally {
      otro.closeAllConnections();
      await new Promise((resolve) => otro.close(resolve));
    }
  });
});

describe('temasDeLaSemana', () => {
  test('un tema que no está en la config cuenta como "Coyuntura / Otros", y van a lo sumo 8', () => {
    const filas = [
      { tema: 'Un tema inventado', n: 2 },
      { tema: null, n: 1 },
      ...CATEGORIAS.slice(0, 10).map((tema, i) => ({ tema, n: 20 - i })),
    ];
    const temas = publicResumen.temasDeLaSemana(filas);
    assert.equal(temas.length, 8);
    assert.ok(temas.every((t) => CATEGORIAS.includes(t.tema)));
    const fallback = publicResumen.temasDeLaSemana([{ tema: 'Un tema inventado', n: 2 }, { tema: null, n: 1 }]);
    assert.deepEqual(fallback, [{ tema: CATEGORIA_FALLBACK, n: 3, orden: CATEGORIAS.indexOf(CATEGORIA_FALLBACK) }]);
  });
});
