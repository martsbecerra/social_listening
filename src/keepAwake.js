// ==========================================================================
// keepAwake.js
// --------------------------------------------------------------------------
// Le pide a Windows que no suspenda el sistema ni apague la pantalla
// mientras el server corre. Una notebook con Modern Standby (S0) entra en
// reposo apenas se apaga la pantalla y frena el proceso: el cron de las 8
// no dispara y la corrida se pierde en silencio.
//
// Node no puede llamar a la API de Windows sin un módulo nativo, así que
// el server lanza un PowerShell hijo (scripts/keep-awake.ps1) que llama a
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
// ES_DISPLAY_REQUIRED) — sin permisos de administrador — y se queda vivo
// leyendo su entrada estándar. Cuando el server termina (bien, mal o
// matado con taskkill), el pipe se cierra, el hijo sale solo y Windows
// vuelve a su política de energía normal: no queda nada colgado.
//
// Solo en Windows; KEEP_AWAKE=0 lo apaga. Nunca tira ni frena el arranque:
// si PowerShell no está o la llamada falla, se loguea y la app sigue. Los
// tests inyectan `spawnFn` y nunca lanzan PowerShell de verdad.
// ==========================================================================

const { spawn } = require('node:child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'keep-awake.ps1');
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH];

// El hijo vivo (uno por proceso), o null.
let child = null;

/** KEEP_AWAKE: activado salvo 0 / false / no / off. */
function keepAwakeEnabled(env = process.env) {
  const raw = String(env.KEEP_AWAKE ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

/**
 * Lanza el hijo que mantiene la máquina despierta. Devuelve el proceso, o
 * null si no corresponde (no es Windows, KEEP_AWAKE=0, o no se pudo
 * lanzar). Si ya hay uno vivo, devuelve ese.
 * @param {{ platform?: string, env?: object, spawnFn?: Function, log?: Function, error?: Function }} [options] para tests
 */
function startKeepAwake({ platform = process.platform, env = process.env, spawnFn = spawn, log = console.log, error = console.error } = {}) {
  if (child) return child;
  if (platform !== 'win32') return null;
  if (!keepAwakeEnabled(env)) {
    log('[keep-awake] apagado (KEEP_AWAKE=0): Windows puede suspender la máquina mientras la app corre.');
    return null;
  }

  let proc;
  try {
    proc = spawnFn('powershell.exe', POWERSHELL_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    error(`[keep-awake] no se pudo lanzar PowerShell: ${err.message}. Windows puede suspender la máquina.`);
    return null;
  }
  child = proc;

  const relay = (stream, out) => {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) out(`[keep-awake] ${text}`);
    });
  };
  relay(proc.stdout, log);
  relay(proc.stderr, error);
  proc.on('error', (err) => {
    error(`[keep-awake] no se pudo lanzar PowerShell: ${err.message}. Windows puede suspender la máquina.`);
    if (child === proc) child = null;
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    log(`[keep-awake] terminó (${signal || `código ${code}`}): Windows vuelve a poder suspender la máquina.`);
  });
  return proc;
}

/**
 * Corta el hijo (el server se está cerrando). Cerrar su stdin alcanza
 * (sale al leer EOF); kill() es por si no llegó a leer. Idempotente.
 * @returns {boolean} true si había un hijo vivo
 */
function stopKeepAwake() {
  const proc = child;
  if (!proc) return false;
  child = null;
  try {
    if (proc.stdin && typeof proc.stdin.end === 'function') proc.stdin.end();
  } catch (err) {
    // Ya cerrado: nada que hacer.
  }
  try {
    proc.kill();
  } catch (err) {
    // Ya terminó: nada que hacer.
  }
  return true;
}

module.exports = { startKeepAwake, stopKeepAwake, keepAwakeEnabled, SCRIPT_PATH, POWERSHELL_ARGS };
