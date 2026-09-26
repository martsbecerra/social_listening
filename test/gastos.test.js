'use strict';

// scripts/gastos.js: gasto en Apify por corrida, por corrida y fase, por
// término de búsqueda y total del período, a partir de apify_calls y
// monitoring_runs en una base temporal que el script abre en solo lectura.
// Horas en hora de Argentina, --desde, ninguna línea pasa de 80 columnas,
// y el script corrido como proceso aparte. Sin red, sin Apify, sin tocar
// data/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gastos-'));
const DB_PATH = path.join(tmp, 'monitoring.db');
process.env.MONITORING_DB_PATH = DB_PATH;
process.env.MONITORING_CONFIG_PATH = path.join(tmp, 'monitoring.json');
process.env.MONITORING_X_CONFIG_PATH = path.join(tmp, 'monitoring-x.json');

const db = require('../src/db');
const gastos = require('../scripts/gastos');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gastos.js');
const APIDOJO = 'apidojo~instagram-scraper-api';
const OFICIAL = 'apify~instagram-scraper';
// "Ahora" fijo: 26/09/2026 19:00 hora de Argentina (22:00 UTC). Período por
// defecto: desde el 25/09 19:00 (22:00 UTC del 25).
const NOW = Date.parse('2026-09-26T22:00:00.000Z');
const DESDE = '2026-09-25T22:00:00.000Z';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} ≈ ${b}`);

function llamada(runId, at, extra) {
  db.insertApifyCall({ runId, at, plataforma: 'instagram', actor: APIDOJO, ok: true, ...extra });
}

// Corrida vieja (23/09): fuera del período.
const runVieja = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-09-23T11:00:00.000Z' });
llamada(runVieja, '2026-09-23T11:01:00.000Z', { phase: 'refresco', queryType: 'user', target: 'cuenta1', items: 10, usd: 0.005, usdReal: 0.005, apifyRunId: 'r1' });
db.finishMonitoringRun(runVieja, { newPosts: 0, finishedAt: '2026-09-23T11:04:00.000Z' });

// Corrida que empezó antes del período (25/09 18:50) pero cuya última llamada cae adentro.
const runPrevia = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-09-25T21:50:00.000Z' });
llamada(runPrevia, '2026-09-25T21:55:00.000Z', { phase: 'refresco', queryType: 'user', target: 'cuenta2', items: 10, usd: 0.005, usdReal: 0.005, apifyRunId: 'r2' });
llamada(runPrevia, '2026-09-25T22:01:00.000Z', { phase: 'refresco', queryType: 'user', target: 'cuenta3', items: 10, usd: 0.005, usdReal: 0.005, apifyRunId: 'r3' });
db.finishMonitoringRun(runPrevia, { newPosts: 1, finishedAt: '2026-09-25T22:05:00.000Z' });

// Corrida cron completa: 25/09 20:00 → 20:31 hora de Argentina, con todas las fases.
const runCron = db.startMonitoringRun({ trigger: 'cron', plataforma: 'instagram', startedAt: '2026-09-25T23:00:00.000Z' });
llamada(runCron, '2026-09-25T23:01:00.000Z', { phase: 'busqueda', queryType: 'search', target: 'jorge macri', items: 25, usd: 0.018, usdReal: 0.019, apifyRunId: 'r4' });
llamada(runCron, '2026-09-25T23:02:00.000Z', { phase: 'busqueda', queryType: 'search', target: 'ciudad', items: 10, usd: 0.015, apifyRunId: 'r5' }); // sin conciliar
llamada(runCron, '2026-09-25T23:03:00.000Z', { phase: 'busqueda', queryType: 'post', actor: OFICIAL, target: 'https://www.instagram.com/p/AAA/', items: 30, usd: 0.069 });
llamada(runCron, '2026-09-25T23:10:00.000Z', { phase: 'benchmark', queryType: 'user', target: 'cuenta1', items: 12, usd: 0.006, usdReal: 0.006, apifyRunId: 'r6' });
llamada(runCron, '2026-09-25T23:11:00.000Z', { phase: 'benchmark', queryType: 'user', target: 'cuenta2', items: 0, ok: false, error: 'TIMEOUT', usd: 0 });
llamada(runCron, '2026-09-25T23:20:00.000Z', { phase: 'refresco', queryType: 'user', target: 'cuenta1', items: 10, usd: 0.005, usdReal: 0.005, apifyRunId: 'r7' });
llamada(runCron, '2026-09-25T23:21:00.000Z', { phase: 'monitoreo', queryType: 'hashtag', target: 'https://www.instagram.com/explore/tags/baires/', items: 30, usd: 0.015, usdReal: 0.015, apifyRunId: 'r8' });
db.finishMonitoringRun(runCron, { newPosts: 5, finishedAt: '2026-09-25T23:31:00.000Z' });

// Corrida manual en curso (26/09 18:50, sin cerrar), marcada por cuota.
const runManual = db.startMonitoringRun({ trigger: 'manual', plataforma: 'instagram', startedAt: '2026-09-26T21:50:00.000Z' });
llamada(runManual, '2026-09-26T21:51:00.000Z', { phase: 'busqueda', queryType: 'search', target: 'jorge macri', items: 20, usd: 0.015, apifyRunId: 'r9' });
{
  const w = new DatabaseSync(DB_PATH);
  w.exec(`UPDATE monitoring_runs SET quota_exceeded = 1 WHERE id = ${runManual}`);
  w.close();
}

// Sin corrida: validación de una cuenta agregada a mano.
llamada(null, '2026-09-26T12:00:00.000Z', { phase: 'validacion', queryType: 'user', target: 'nueva', items: 1, usd: 0.005, usdReal: 0.005, apifyRunId: 'r10' });

describe('scripts/gastos.js', { concurrency: false }, () => {
  test('hora de Argentina: ida y vuelta, formato corto y largo', () => {
    assert.equal(gastos.fechaHoraCorta('2026-09-25T23:00:00.000Z'), '25/09 20:00');
    assert.equal(gastos.fechaHoraLarga('2026-09-26T02:30:00.000Z'), '25/09/2026 23:30');
    assert.equal(gastos.fechaHoraCorta(null), '-');
    assert.equal(new Date(gastos.argentinaAUtc({ anio: 2026, mes: 9, dia: 25, hora: 20, minuto: 0 })).toISOString(), '2026-09-25T23:00:00.000Z');
    assert.equal(new Date(gastos.argentinaAUtc({ anio: 2026, mes: 1, dia: 1 })).toISOString(), '2026-01-01T03:00:00.000Z');
  });

  test('--desde: "AAAA-MM-DD HH:MM" en hora de Argentina o solo la fecha; por defecto 24 horas atrás; inválido tira', () => {
    assert.equal(gastos.parseDesde('2026-09-25 20:00'), '2026-09-25T23:00:00.000Z');
    assert.equal(gastos.parseDesde('2026-09-25T08:30'), '2026-09-25T11:30:00.000Z');
    assert.equal(gastos.parseDesde('2026-09-25'), '2026-09-25T03:00:00.000Z');
    for (const malo of ['ayer', '25/09/2026 20:00', '2026-13-01 10:00', '2026-09-31 10:00', '2026-09-25 25:00', '']) {
      assert.throws(() => gastos.parseDesde(malo), /--desde inválido/, malo);
    }
    assert.deepEqual(gastos.parseArgs([], NOW), { ayuda: false, desdeIso: DESDE, porDefecto: true });
    assert.deepEqual(gastos.parseArgs(['--desde', '2026-09-25 20:00'], NOW), { ayuda: false, desdeIso: '2026-09-25T23:00:00.000Z', porDefecto: false });
    assert.equal(gastos.parseArgs(['--desde=2026-09-25 20:00'], NOW).desdeIso, '2026-09-25T23:00:00.000Z');
    assert.equal(gastos.parseArgs(['--ayuda'], NOW).ayuda, true);
    assert.throws(() => gastos.parseArgs(['--desde'], NOW), /--desde necesita un valor/);
    assert.throws(() => gastos.parseArgs(['--dias', '3'], NOW), /Opción desconocida/);
  });

  test('fase del reporte: search es búsqueda en cualquier fase; el resto de busqueda es detalle; lo demás, otras', () => {
    assert.equal(gastos.faseDe({ phase: 'busqueda', query_type: 'search' }), 'busqueda');
    assert.equal(gastos.faseDe({ phase: 'monitoreo', query_type: 'search' }), 'busqueda');
    assert.equal(gastos.faseDe({ phase: 'busqueda', query_type: 'post' }), 'detalle');
    assert.equal(gastos.faseDe({ phase: 'benchmark', query_type: 'user' }), 'benchmark');
    assert.equal(gastos.faseDe({ phase: 'refresco', query_type: 'user' }), 'refresco');
    for (const phase of ['monitoreo', 'validacion', 'recalc-script', 'analisis', 'desconocida']) {
      assert.equal(gastos.faseDe({ phase, query_type: 'user' }), 'otras', phase);
    }
  });

  test('la base se abre en solo lectura y una ruta inexistente avisa', () => {
    const ro = gastos.abrirBase(DB_PATH);
    assert.throws(() => ro.exec("INSERT INTO apify_calls (at, phase, plataforma) VALUES ('x', 'y', 'z')"), /readonly/);
    ro.close();
    assert.throws(() => gastos.buildReport({ dbPath: path.join(tmp, 'no-existe.db'), desdeIso: DESDE, now: NOW }), /No existe la base/);
  });

  test('por corrida: solo las iniciadas en el período, con todas sus llamadas, duración, "en curso" y cuota', () => {
    const r = gastos.buildReport({ desdeIso: DESDE, now: NOW, porDefecto: true });
    assert.equal(r.dbPath, DB_PATH);
    assert.deepEqual(
      r.corridas.map((c) => c.id),
      [runCron, runManual]
    );
    const [cron, manual] = r.corridas;
    assert.equal(cron.trigger, 'cron');
    assert.equal(cron.duracion, '31 min');
    assert.equal(cron.newPosts, 5);
    assert.equal(cron.quotaExceeded, false);
    assert.equal(cron.calls, 7);
    assert.equal(cron.failed, 1);
    assert.equal(cron.results, 117);
    near(cron.usdEst, 0.128);
    near(cron.usdReal, 0.114, 'real = conciliado + oficial por resultado; la búsqueda sin conciliar y la fallida no suman');
    assert.equal(cron.pendientes, 1);
    assert.equal(manual.trigger, 'manual');
    assert.equal(manual.finishedAt, null);
    assert.equal(manual.duracion, 'en curso');
    assert.equal(manual.quotaExceeded, true);
    assert.equal(manual.calls, 1);
    assert.equal(manual.pendientes, 1);
    near(manual.usdReal, 0);
  });

  test('por corrida y fase: búsqueda, detalle, benchmark, refresco y otras con la fase real', () => {
    const r = gastos.buildReport({ desdeIso: DESDE, now: NOW });
    const f = r.corridas[0].porFase;
    assert.deepEqual(Object.keys(f), ['busqueda', 'detalle', 'benchmark', 'refresco', 'otras']);
    assert.equal(f.busqueda.calls, 2);
    assert.equal(f.busqueda.results, 35);
    near(f.busqueda.usdEst, 0.033);
    near(f.busqueda.usdReal, 0.019);
    assert.equal(f.busqueda.pendientes, 1);
    assert.equal(f.detalle.calls, 1);
    assert.equal(f.detalle.results, 30);
    near(f.detalle.usdEst, 0.069);
    near(f.detalle.usdReal, 0.069, 'el oficial cobra por resultado: su estimado vale como real');
    assert.equal(f.detalle.pendientes, 0);
    assert.equal(f.benchmark.calls, 2);
    assert.equal(f.benchmark.failed, 1);
    assert.equal(f.benchmark.results, 12);
    near(f.benchmark.usdEst, 0.006);
    near(f.benchmark.usdReal, 0.006);
    assert.equal(f.benchmark.pendientes, 0, 'una fallida sin run no queda pendiente de conciliar');
    assert.equal(f.refresco.calls, 1);
    near(f.refresco.usdEst, 0.005);
    assert.equal(f.otras.calls, 1);
    assert.deepEqual(f.otras.fases, ['monitoreo']);
    near(f.otras.usdEst, 0.015);
    assert.deepEqual(Object.keys(r.corridas[1].porFase), ['busqueda']);
  });

  test('por término y total del período: llamadas por fecha, con las de fuera de corridas y de corridas previas aparte', () => {
    const r = gastos.buildReport({ desdeIso: DESDE, now: NOW });
    assert.deepEqual(
      r.terminos.map((t) => [t.termino, t.calls, t.results]),
      [
        ['jorge macri', 2, 45],
        ['ciudad', 1, 10],
      ]
    );
    near(r.terminos[0].usdEst, 0.033);
    near(r.terminos[0].usdReal, 0.019);
    assert.equal(r.terminos[0].pendientes, 1);
    near(r.terminos[1].usdReal, 0);
    assert.equal(r.terminos[1].pendientes, 1);

    const t = r.total;
    assert.equal(t.calls, 10);
    assert.equal(t.failed, 1);
    assert.equal(t.results, 148);
    near(t.usdEst, 0.153);
    near(t.usdReal, 0.124);
    assert.equal(t.pendientes, 2);
    assert.deepEqual(Object.keys(t.porFase), ['busqueda', 'detalle', 'benchmark', 'refresco', 'otras']);
    assert.equal(t.porFase.busqueda.calls, 3);
    assert.equal(t.porFase.refresco.calls, 2);
    assert.equal(t.porFase.otras.calls, 2);
    assert.deepEqual(t.porFase.otras.fases, ['monitoreo', 'validacion']);
    assert.equal(r.fueraDeCorridas.calls, 1);
    assert.deepEqual(r.fueraDeCorridas.fases, ['validacion']);
    assert.equal(r.deCorridasPrevias.calls, 1);
    near(r.deCorridasPrevias.usdEst, 0.005);

    // Con --desde más atrás entra la corrida previa entera; la vieja sigue afuera.
    const r2 = gastos.buildReport({ desdeIso: '2026-09-25T21:00:00.000Z', now: NOW });
    assert.deepEqual(
      r2.corridas.map((c) => c.id),
      [runPrevia, runCron, runManual]
    );
    assert.equal(r2.deCorridasPrevias.calls, 0);
    assert.equal(r2.total.calls, 11, 'las 2 de la previa, 7 de la cron, 1 de la manual y la validación');
  });

  test('render: cuatro tablas, ninguna línea pasa de 80 columnas, horas de Argentina y marcas', () => {
    const r = gastos.buildReport({ desdeIso: DESDE, now: NOW, porDefecto: true });
    const lines = gastos.render(r);
    for (const line of lines) {
      if (!line.startsWith('Base:')) assert.ok(line.length <= gastos.ANCHO_MAX, `${line.length} columnas: ${line}`);
    }
    const texto = lines.join('\n');
    assert.match(texto, /Período: 25\/09\/2026 19:00 → 26\/09\/2026 19:00 \(últimas 24 horas\)/);
    assert.match(texto, /== 1\. Por corrida\n/);
    assert.match(texto, new RegExp(`#${runCron}\\s+25/09 20:00\\s+25/09 20:31\\s+31 min\\s+7\\s+117\\s+0\\.128\\s+0\\.114\\*`));
    assert.match(texto, new RegExp(`#${runManual}\\*!\\s+26/09 18:50\\s+-\\s+en curso\\s+1\\s+20\\s+0\\.015\\s+0\\.000\\*`));
    assert.match(texto, /total\s+8\s+137\s+0\.143\s+0\.114\*/);
    assert.match(texto, /\* = corrida manual/);
    assert.match(texto, /! = alguna llamada cortó por la cuota/);
    assert.match(texto, /== 2\. Por corrida y fase/);
    assert.match(texto, new RegExp(`#${runCron}  25/09 20:00 → 25/09 20:31 · cron · instagram · 5 posteos nuevos`));
    assert.match(texto, new RegExp(`#${runManual}  26/09 18:50 → en curso · manual · instagram · 0 posteos nuevos`));
    assert.match(texto, /búsqueda\s+2\s+35\s+0\.033\s+0\.019\*/);
    assert.match(texto, /detalle\s+1\s+30\s+0\.069\s+0\.069\n/);
    assert.match(texto, /otras \(monitoreo\)\s+1\s+30\s+0\.015\s+0\.015/);
    assert.match(texto, /== 3\. Por término de búsqueda/);
    assert.match(texto, /jorge macri\s+2\s+45\s+0\.033\s+0\.019\*/);
    assert.match(texto, /ciudad\s+1\s+10\s+0\.015\s+0\.000\*/);
    assert.match(texto, /total \(2 términos\)\s+3\s+55\s+0\.048\s+0\.019\*/);
    assert.match(texto, /== 4\. Total del período/);
    assert.match(texto, /corridas: 2 \(1 cron, 1 manuales\) · posteos nuevos: 5/);
    assert.match(texto, /llamadas: 10 \(1 fallidas\) · resultados: 148/);
    assert.match(texto, /USD estimado: 0\.153 · USD real: 0\.124\* \(2 llamadas sin conciliar\)/);
    assert.match(texto, /otras \(monitoreo, validacion\)\s+2\s+31\s+0\.020\s+0\.020/);
    assert.match(texto, /fuera de corridas: 1 llamadas \(validacion\) ≈ 0\.005 USD est\./);
    assert.match(texto, /de corridas iniciadas antes del período: 1 llamadas ≈ 0\.005 USD est\./);
    assert.match(texto, /costo-apify\.js --conciliar/);

    const vacio = gastos.render(gastos.buildReport({ desdeIso: '2026-09-27T00:00:00.000Z', now: NOW })).join('\n');
    assert.match(vacio, /\(sin corridas en el período\)/);
    assert.match(vacio, /\(sin búsquedas en el período\)/);
    assert.match(vacio, /llamadas: 0 \(0 fallidas\) · resultados: 0/);
  });

  test('como proceso aparte: imprime las cuatro tablas, --ayuda muestra el uso y un --desde inválido sale con 1', () => {
    const env = { ...process.env, MONITORING_DB_PATH: DB_PATH };
    const salida = execFileSync(process.execPath, [SCRIPT, '--desde', '2026-09-25 20:00'], { env, encoding: 'utf8' });
    for (const titulo of ['== 1. Por corrida', '== 2. Por corrida y fase', '== 3. Por término de búsqueda', '== 4. Total del período']) {
      assert.ok(salida.includes(titulo), titulo);
    }
    assert.ok(salida.includes(`#${runCron} `), 'la corrida cron del 25/09 20:00 entra (inicio == desde)');
    assert.ok(salida.includes('jorge macri'));
    assert.ok(!salida.includes('(últimas 24 horas)'));

    const ayuda = execFileSync(process.execPath, [SCRIPT, '--ayuda'], { env, encoding: 'utf8' });
    assert.match(ayuda, /Uso: node scripts\/gastos\.js/);

    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, '--desde', 'ayer'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (err) => err.status === 1 && /--desde inválido/.test(String(err.stderr))
    );
  });
});
