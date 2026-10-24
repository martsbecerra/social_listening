'use strict';

// La migración de la fase F (src/db.js) sobre una base de la fase E: la
// tabla `analisis` sin las columnas de la galería y con análisis ya
// terminados. Al cargar db.js aparecen pct_neg, tiene_hecho, n_verificados
// y tema_estrella, completadas con lo que esos análisis guardaron (los
// comentarios con su tono y su tilde de verificada, los temas con sus
// comentarios) y con la misma cuenta que la vista, y la tabla
// figuras_publicas. Base temporal armada a mano antes del require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-analisis-migracion-f-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js

// La tabla como la dejó la fase E.
const vieja = new DatabaseSync(DB_PATH);
vieja.exec(`
  CREATE TABLE analisis (
    id INTEGER PRIMARY KEY AUTOINCREMENT, plataforma TEXT NOT NULL, url TEXT NOT NULL, post_code TEXT, post_id TEXT,
    estado TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, analizado_por TEXT, cuenta TEXT,
    cuenta_nombre TEXT, caption TEXT, posted_at TEXT, post_type TEXT, likes INTEGER, comentarios_total INTEGER,
    vistas INTEGER, traidos INTEGER, unicos INTEGER, enviados INTEGER, analizados INTEGER, positivos INTEGER,
    neutrales INTEGER, negativos INTEGER, ruido INTEGER, positivo_pct INTEGER, negativo_pct INTEGER, nivel TEXT,
    resultado TEXT, temas TEXT, comentarios TEXT, cuando TEXT, reporte_antes TEXT, reporte_despues TEXT, csv TEXT,
    reclamos INTEGER, usd_apify REAL, usd_modelo REAL, tokens INTEGER, image_source_url TEXT, image_status TEXT,
    image_saved_at TEXT, image_width INTEGER, image_height INTEGER
  )
`);
const insertar = vieja.prepare(`
  INSERT INTO analisis (plataforma, url, post_code, estado, started_at, finished_at, cuenta, positivos, neutrales, negativos, ruido, comentarios, temas)
  VALUES ('instagram', ?, ?, ?, '2026-10-20T10:00:00.000Z', '2026-10-20T10:05:00.000Z', 'gcba', ?, ?, ?, 0, ?, ?)
`);
insertar.run(
  'https://www.instagram.com/p/VIEJO1/',
  'VIEJO1',
  'ok',
  30,
  50,
  20,
  JSON.stringify([
    { n: 1, usuario: 'Periodista1', verificada: true, texto: 'a', tono: 'negativo' },
    { n: 2, usuario: 'periodista1', verificada: true, texto: 'b', tono: 'negativo' },
    { n: 3, usuario: 'medio2', verificada: true, texto: 'c', tono: 'neutral' },
    { n: 4, usuario: 'vecina', verificada: false, texto: 'd', tono: 'positivo' },
  ]),
  JSON.stringify([
    { titulo: 'Tránsito', texto: 'x', comentarios: [1] },
    { titulo: 'Seguridad', texto: 'y', comentarios: [1, 2, 3] },
  ])
);
insertar.run('https://www.instagram.com/p/VIEJO2/', 'VIEJO2', 'ok', 0, 0, 0, '[]', '[]');
insertar.run('https://www.instagram.com/p/VIEJO3/', 'VIEJO3', 'error', null, null, null, null, null);
vieja.close();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

test('las columnas nuevas aparecen y se completan en los análisis viejos terminados', () => {
  const base = new DatabaseSync(DB_PATH, { readOnly: true });
  const columnas = base.prepare('PRAGMA table_info(analisis)').all().map((c) => c.name);
  for (const col of ['pct_neg', 'tiene_hecho', 'n_verificados', 'tema_estrella']) assert.ok(columnas.includes(col), col);
  const filas = base.prepare('SELECT url, pct_neg, tiene_hecho, n_verificados, tema_estrella FROM analisis ORDER BY id').all();
  base.close();
  // Con la misma cuenta que la vista (analysisMetrics): 2 negativos de los 4 comentarios con tono (los
  // tonos sueltos de la fila no mandan); dos verificados distintos (el mismo con otra mayúscula cuenta una
  // vez); la estrella, el tema con más comentarios de su propia lista (Seguridad: 3; Tránsito: 1).
  assert.deepEqual({ ...filas[0] }, { url: 'https://www.instagram.com/p/VIEJO1/', pct_neg: 50, tiene_hecho: 0, n_verificados: 2, tema_estrella: 'Seguridad' });
  assert.deepEqual({ ...filas[1] }, { url: 'https://www.instagram.com/p/VIEJO2/', pct_neg: null, tiene_hecho: 0, n_verificados: 0, tema_estrella: null });
  assert.equal(filas[2].n_verificados, null, 'uno que no terminó bien no se toca');
});

test('la galería lee las columnas completadas y la tabla de figuras existe', () => {
  const { items, total } = db.listAnalisisGaleria({ plataforma: 'instagram' });
  assert.equal(total, 2);
  const viejo = items.find((a) => a.postCode === 'VIEJO1');
  assert.equal(viejo.pctNeg, 50);
  assert.equal(viejo.nVerificados, 2);
  assert.equal(viejo.temaEstrella, 'Seguridad');
  assert.equal(viejo.tieneHecho, false);
  assert.deepEqual(db.listFiguras(), []);
});
