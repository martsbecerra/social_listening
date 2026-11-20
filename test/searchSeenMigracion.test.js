'use strict';

// La migración de search_seen (noviembre 2026, openspec/changes/
// ventana-por-fuente) sobre una base anterior: la tabla sin posted_at,
// motivo, llm_usd, run_id ni terminos, con filas ya anotadas. Al cargar
// db.js aparecen las cinco columnas, las filas viejas se leen igual (sus
// términos son el `term` de siempre) y cargar dos veces no rompe nada. Base
// temporal armada a mano antes del require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-seen-migracion-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH; // ANTES de cargar db.js

// La tabla como estaba antes del cambio.
const vieja = new DatabaseSync(DB_PATH);
vieja.exec(`
  CREATE TABLE search_seen (
    post_id TEXT NOT NULL,
    plataforma TEXT NOT NULL,
    url TEXT,
    term TEXT,
    outcome TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (post_id, plataforma)
  )
`);
const insertar = vieja.prepare('INSERT INTO search_seen (post_id, plataforma, url, term, outcome, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)');
insertar.run('viejo-1', 'instagram', 'https://www.instagram.com/p/viejo-1/', 'macri', 'descartado', '2026-10-02T10:00:00.000Z');
insertar.run('viejo-2', 'instagram', null, null, 'sin_detalle', '2026-10-03T10:00:00.000Z');
vieja.close();

const db = require('../src/db');

test('una base anterior gana las columnas nuevas y sus filas se leen igual', () => {
  const raw = new DatabaseSync(DB_PATH, { readOnly: true });
  const columnas = raw.prepare('PRAGMA table_info(search_seen)').all().map((c) => c.name);
  raw.close();
  for (const col of ['posted_at', 'motivo', 'llm_usd', 'run_id', 'terminos']) assert.ok(columnas.includes(col), `falta ${col}`);

  assert.deepEqual(db.getSearchSeen('viejo-1', 'instagram'), {
    postId: 'viejo-1',
    plataforma: 'instagram',
    url: 'https://www.instagram.com/p/viejo-1/',
    term: 'macri',
    outcome: 'descartado',
    firstSeenAt: '2026-10-02T10:00:00.000Z',
    postedAt: null,
    motivo: null,
    llmUsd: null,
    runId: null,
    terminos: ['macri'],
  });
  assert.deepEqual(db.getSearchSeen('viejo-2', 'instagram').terminos, []);
  assert.equal(db.isSearchSeen('viejo-1', 'instagram'), true);
});

test('una fila vieja admite sumar términos y completar datos sin perder su fecha', () => {
  assert.equal(db.addSearchSeenTerms('viejo-1', 'instagram', ['gcba']), true);
  db.markSearchSeen({ postId: 'viejo-1', plataforma: 'instagram', term: 'gcba', outcome: 'descartado', postedAt: '2026-10-01T22:00:00.000Z' });
  const fila = db.getSearchSeen('viejo-1', 'instagram');
  assert.deepEqual(fila.terminos, ['macri', 'gcba']);
  assert.equal(fila.term, 'macri');
  assert.equal(fila.firstSeenAt, '2026-10-02T10:00:00.000Z');
  assert.equal(fila.postedAt, '2026-10-01T22:00:00.000Z');
});

test('los descartados viejos (sin fecha de publicación) siguen contando por el día en que se vieron', () => {
  db.markSearchSeen({ postId: 'nuevo-1', plataforma: 'instagram', term: 'macri', outcome: 'descartado', firstSeenAt: '2026-10-09T10:00:00.000Z', postedAt: '2026-10-03T12:00:00.000Z' });
  db.markSearchSeen({ postId: 'viejo-3', plataforma: 'instagram', term: 'macri', outcome: 'descartado', firstSeenAt: '2026-10-03T12:00:00.000Z' });
  // El día 3: el nuevo por su publicación y el viejo-3 por el día en que se vio.
  const dia3 = db.countDiscardedSearchesForStats({ plataforma: 'instagram', desdeIso: '2026-10-03T03:00:00.000Z', hastaIso: '2026-10-04T03:00:00.000Z' });
  assert.deepEqual(dia3, [{ term: 'macri', n: 2 }]);
  // El día 9 (cuando se vio el nuevo) ya no lo cuenta.
  const dia9 = db.countDiscardedSearchesForStats({ plataforma: 'instagram', desdeIso: '2026-10-09T03:00:00.000Z', hastaIso: '2026-10-10T03:00:00.000Z' });
  assert.deepEqual(dia9, []);
});
