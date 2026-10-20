'use strict';

// src/replicaToken.js: el token de lectura que se pega en el modal de la
// réplica. Se prueba contra el repo de datos antes de guardarlo y se guarda
// en el .env local sin tocar las otras líneas. git simulado, .env temporal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { writeEnvValue, verifyToken } = require('../src/replicaToken');

function envFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-token-'));
  const file = path.join(dir, '.env');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('writeEnvValue reemplaza la línea y deja las demás como estaban', () => {
  const file = envFile('# réplica\r\nAPP_MODE=replica\r\nDATA_REPO_TOKEN=\r\nPORT=3000\r\n');
  writeEnvValue(file, 'DATA_REPO_TOKEN', 'nuevo-valor');
  assert.equal(fs.readFileSync(file, 'utf8'), '# réplica\r\nAPP_MODE=replica\r\nDATA_REPO_TOKEN=nuevo-valor\r\nPORT=3000\r\n');
});

test('writeEnvValue agrega la línea si no estaba, y crea el archivo si no existe', () => {
  const file = envFile('APP_MODE=replica\n');
  writeEnvValue(file, 'DATA_REPO_TOKEN', 'abc');
  assert.equal(fs.readFileSync(file, 'utf8'), 'APP_MODE=replica\nDATA_REPO_TOKEN=abc\n');
  const nuevo = envFile();
  writeEnvValue(nuevo, 'DATA_REPO_TOKEN', 'abc');
  assert.equal(fs.readFileSync(nuevo, 'utf8'), 'DATA_REPO_TOKEN=abc\n');
});

test('writeEnvValue saca el BOM y no deja temporales', () => {
  const file = envFile('\uFEFFAPP_MODE=replica\nDATA_REPO_TOKEN=viejo\n');
  writeEnvValue(file, 'DATA_REPO_TOKEN', 'abc');
  assert.equal(fs.readFileSync(file, 'utf8'), 'APP_MODE=replica\nDATA_REPO_TOKEN=abc\n');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.env']);
});

function runnerFactory(result) {
  const created = [];
  const factory = (options) => {
    const calls = [];
    created.push({ options, calls });
    return {
      run: async (args) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    };
  };
  return { factory, created };
}

test('verifyToken prueba un ls-remote del repo de datos con ESE token', async () => {
  const { factory, created } = runnerFactory('');
  const out = await verifyToken({ repoUrl: 'https://github.com/x/datos.git', token: 'tok', gitPath: 'C:/mingit/git.exe', createGitRunnerFn: factory });
  assert.deepEqual(out, { ok: true });
  assert.equal(created[0].options.token, 'tok');
  assert.equal(created[0].options.gitPath, 'C:/mingit/git.exe');
  assert.equal(created[0].options.machineCredentials, false);
  assert.deepEqual(created[0].calls, [['ls-remote', 'https://github.com/x/datos.git', 'refs/heads/snapshot']]);
});

test('verifyToken: sin acceso al repo es "acceso"; sin conexión es "red"', async () => {
  const sinAcceso = runnerFactory(new Error("git ls-remote falló: | remote: Repository not found. fatal: Authentication failed"));
  assert.equal((await verifyToken({ repoUrl: 'u', token: 't', createGitRunnerFn: sinAcceso.factory })).reason, 'acceso');
  const sinRed = runnerFactory(new Error("git ls-remote falló: | fatal: unable to access: Could not resolve host: github.com"));
  assert.equal((await verifyToken({ repoUrl: 'u', token: 't', createGitRunnerFn: sinRed.factory })).reason, 'red');
});

test('verifyToken sin URL del repo no llama a git', async () => {
  const { factory, created } = runnerFactory('');
  const out = await verifyToken({ repoUrl: '', token: 't', createGitRunnerFn: factory });
  assert.deepEqual(out, { ok: false, reason: 'sin-repo' });
  assert.equal(created.length, 0);
});
