'use strict';

// Figuras públicas (fase F): la validación de src/figuras.js (roles, la
// alineación solo para roles políticos o de prensa, el usuario) y la tabla
// figuras_publicas en src/db.js (alta del equipo, una sugerencia del
// modelo que nunca pisa al equipo, confirmar, borrar, el cruce por
// usuarios). Base temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-figuras-'));
process.env.MONITORING_DB_PATH = path.join(tmp, 'monitoring.db'); // ANTES de cargar db.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const figuras = require('../src/figuras');

describe('la validación', () => {
  test('el usuario: sin @, en minúsculas, con los caracteres de Instagram', () => {
    assert.equal(figuras.normalizeUsername('@Facundo.Delgado_Leg'), 'facundo.delgado_leg');
    assert.equal(figuras.normalizeUsername('con espacio'), '');
    assert.equal(figuras.normalizeUsername(''), '');
    assert.equal(figuras.normalizeUsername('a'.repeat(31)), '');
  });

  test('rol obligatorio y de la lista; alineación solo para roles políticos o de prensa', () => {
    assert.deepEqual(figuras.validarFigura({ username: '@leg1', nombre: ' Ana Leg ', rol: 'legislador', alineacion: 'oposicion' }), {
      username: 'leg1',
      nombre: 'Ana Leg',
      rol: 'legislador',
      alineacion: 'oposicion',
      notas: null,
    });
    assert.throws(() => figuras.validarFigura({ username: 'x1', rol: 'vecino' }), (e) => /rol de la lista/.test(e.userMessage));
    assert.throws(() => figuras.validarFigura({ username: 'x1', rol: 'creador', alineacion: 'oficialismo' }), (e) => /solo va para roles políticos/.test(e.userMessage));
    assert.throws(() => figuras.validarFigura({ username: 'x1', rol: 'medio', alineacion: 'peronismo' }), (e) => /oficialismo, oposición o ninguna/.test(e.userMessage));
    assert.equal(figuras.validarFigura({ username: 'x1', rol: 'organizacion', alineacion: '' }).alineacion, null);
    // Las claves del prototipo no son un rol ni una alineación.
    for (const rol of ['constructor', 'toString', '__proto__']) {
      assert.throws(() => figuras.validarFigura({ username: 'x1', rol }), (e) => /rol de la lista/.test(e.userMessage), rol);
    }
    assert.throws(() => figuras.validarFigura({ username: 'x1', rol: 'medio', alineacion: 'constructor' }), (e) => /oficialismo, oposición o ninguna/.test(e.userMessage));
    assert.equal(figuras.sanitizarSugerencia({ username: 'x1', rol: 'constructor' }), null);
    assert.equal(figuras.rolTexto({ rol: 'toString' }), '');
  });

  test('una sugerencia del modelo: sin rol válido se descarta; la alineación de un rol que no la lleva se borra', () => {
    assert.equal(figuras.sanitizarSugerencia({ username: 'x', rol: 'vecino' }), null);
    assert.deepEqual(figuras.sanitizarSugerencia({ username: '@Cre1', rol: 'creador', alineacion: 'oposicion' }), { username: 'cre1', rol: 'creador', alineacion: null });
    assert.deepEqual(figuras.sanitizarSugerencia({ username: 'per1', rol: 'periodista', alineacion: 'inventada' }), { username: 'per1', rol: 'periodista', alineacion: null });
  });

  test('el texto del rol, sin género', () => {
    assert.equal(figuras.rolTexto({ rol: 'legislador', alineacion: 'oposicion' }), 'Legislador/a · oposición');
    assert.equal(figuras.rolTexto({ rol: 'junta_comunal', alineacion: null }), 'Junta comunal');
    assert.equal(figuras.rolTexto(null), '');
  });
});

describe('la tabla', { concurrency: false }, () => {
  test('alta del equipo; repetida, error; el cruce por usuarios', () => {
    const f = db.createFigura({ username: '@Leg1', nombre: 'Ana Leg', rol: 'legislador', alineacion: 'oposicion' }, { creadoPor: 'equipo@test.local' });
    assert.equal(f.origen, 'equipo');
    assert.equal(f.creadoPor, 'equipo@test.local');
    assert.throws(() => db.createFigura({ username: 'leg1', rol: 'medio' }), (e) => e.code === 'FIGURA_EXISTE');
    const mapa = db.getFigurasPorUsernames(['LEG1', 'nadie', '', null]);
    assert.deepEqual([...mapa.keys()], ['leg1']);
  });

  test('una sugerencia entra como sugerida, se actualiza, y nunca pisa al equipo', () => {
    assert.equal(db.upsertFiguraSugerida({ username: 'per1', rol: 'periodista', alineacion: 'oficialismo' }), 'nueva');
    assert.equal(db.getFigura('per1').origen, 'sugerida');
    assert.equal(db.upsertFiguraSugerida({ username: 'per1', rol: 'medio', alineacion: null }), 'actualizada');
    assert.equal(db.getFigura('per1').rol, 'medio');
    assert.equal(db.upsertFiguraSugerida({ username: 'leg1', rol: 'medio' }), 'del equipo');
    assert.equal(db.getFigura('leg1').rol, 'legislador', 'la del equipo no cambia');
    assert.equal(db.upsertFiguraSugerida({ username: 'x', rol: 'inventado' }), 'descartada');
  });

  test('confirmar una sugerencia (PATCH) la pasa al equipo; dar de alta una sugerida también', () => {
    const conf = db.updateFigura('per1', { alineacion: null }, { por: 'confirma@test.local' });
    assert.equal(conf.origen, 'equipo');
    assert.equal(conf.rol, 'medio', 'lo que no viene queda');
    assert.equal(conf.creadoPor, 'confirma@test.local', 'una sugerida no tenía quién: queda quien la confirmó');
    assert.equal(db.updateFigura('leg1', { notas: 'x' }, { por: 'otro@test.local' }).creadoPor, 'equipo@test.local', 'quien la cargó no cambia');
    db.upsertFiguraSugerida({ username: 'org1', rol: 'organizacion' });
    const alta = db.createFigura({ username: 'org1', nombre: 'Vecinos de Caballito', rol: 'organizacion' }, { creadoPor: 'alta@test.local' });
    assert.equal(alta.origen, 'equipo');
    assert.equal(alta.nombre, 'Vecinos de Caballito');
    assert.equal(alta.creadoPor, 'alta@test.local');
    assert.equal(db.updateFigura('nadie', { rol: 'medio' }), null);
    assert.throws(() => db.updateFigura('org1', { alineacion: 'oposicion' }), (e) => /solo va para roles políticos/.test(e.userMessage));
  });

  test('borrar', () => {
    assert.equal(db.deleteFigura('@ORG1'), true);
    assert.equal(db.deleteFigura('org1'), false);
    assert.equal(db.getFigura('org1'), null);
  });
});
