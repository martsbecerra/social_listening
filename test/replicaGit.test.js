'use strict';

// src/replicaGit.js: corre git para publicar y traer el snapshot. El token
// del repo de datos va SOLO por variables de entorno del proceso hijo
// (GIT_CONFIG_*), nunca en los argumentos ni en una URL, y no puede salir en
// un mensaje de error (REQ-REP-09). execFile simulado: no corre git.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGitRunner } = require('../src/replicaGit');

const TOKEN = 'github_pat_SECRETO123';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

function fakeExecFile({ stdout = '', error = null, stderr = '' } = {}) {
  const calls = [];
  const fn = (file, args, options, cb) => {
    calls.push({ file, args, options });
    if (error) {
      const err = new Error(error);
      cb(err, '', stderr);
    } else {
      cb(null, stdout, '');
    }
  };
  return { fn, calls };
}

test('con token: va en el entorno del hijo como http.extraHeader, no en los argumentos', async () => {
  const exec = fakeExecFile({ stdout: 'abc123\n' });
  const git = createGitRunner({ token: TOKEN, execFileFn: exec.fn });
  const out = await git.run(['ls-remote', 'origin', 'refs/heads/snapshot'], { cwd: 'C:/datos' });

  assert.equal(out, 'abc123\n');
  const [call] = exec.calls;
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args, ['ls-remote', 'origin', 'refs/heads/snapshot']);
  assert.equal(call.options.cwd, 'C:/datos');
  assert.equal(call.options.env.GIT_CONFIG_COUNT, '1');
  assert.equal(call.options.env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(call.options.env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${BASIC}`);
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!JSON.stringify(call.args).includes(TOKEN));
});

test('sin token no agrega header (la principal usa el git ya autenticado)', async () => {
  const exec = fakeExecFile();
  const git = createGitRunner({ execFileFn: exec.fn });
  await git.run(['status']);
  const { env } = exec.calls[0].options;
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

function gitConfigOf(env) {
  const out = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT || 0); i++) out[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
  return out;
}

test('sin credenciales de la máquina (réplica): sin credential helper ni ventana de login, con o sin token', async () => {
  for (const token of [TOKEN, '']) {
    const exec = fakeExecFile();
    const git = createGitRunner({ token, machineCredentials: false, execFileFn: exec.fn });
    await git.run(['ls-remote', 'origin', 'refs/heads/snapshot']);
    const { env } = exec.calls[0].options;
    // Un credential.helper vacío borra los configurados: un token rechazado
    // corta con error en vez de abrir el login de Git Credential Manager.
    assert.equal(gitConfigOf(env)['credential.helper'], '');
    assert.equal(env.GCM_INTERACTIVE, 'never');
    if (token) assert.equal(gitConfigOf(env)['http.extraHeader'], `Authorization: Basic ${BASIC}`);
  }
});

test('por defecto usa las credenciales de la máquina (la principal publica con su git autenticado)', async () => {
  const exec = fakeExecFile();
  await createGitRunner({ execFileFn: exec.fn }).run(['push']);
  const { env } = exec.calls[0].options;
  assert.equal(gitConfigOf(env)['credential.helper'], undefined);
});

test('usa el ejecutable de gitPath (MinGit del instalador)', async () => {
  const exec = fakeExecFile();
  const git = createGitRunner({ gitPath: 'C:/app/mingit/cmd/git.exe', execFileFn: exec.fn });
  await git.run(['status']);
  assert.equal(exec.calls[0].file, 'C:/app/mingit/cmd/git.exe');
});

test('un error de git no deja ver el token, ni en claro ni en base64', async () => {
  const exec = fakeExecFile({
    error: `Command failed: git fetch\nAuthorization: Basic ${BASIC}`,
    stderr: `fatal: could not read from ${TOKEN}`,
  });
  const git = createGitRunner({ token: TOKEN, execFileFn: exec.fn });
  await assert.rejects(git.run(['fetch']), (err) => {
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(!err.message.includes(BASIC), err.message);
    assert.match(err.message, /git fetch/);
    assert.match(err.message, /\*\*\*/);
    return true;
  });
});
