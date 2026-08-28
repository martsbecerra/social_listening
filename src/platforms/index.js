// ==========================================================================
// platforms/index.js — Registro de adapters de plataforma.
// --------------------------------------------------------------------------
// Cada plataforma soportada por el monitoreo se registra acá con su adapter
// (ver el contrato en instagram.js, la única implementación por ahora).
// Cuando se sume TikTok/X/Facebook, se agrega el módulo al objeto y el
// orquestador (src/monitor.js) lo recorre solo.
// ==========================================================================

const instagram = require('./instagram');

const PLATFORMS = { instagram };

const DEFAULT_PLATFORM_ID = 'instagram';

function getPlatform(id) {
  const platform = PLATFORMS[id];
  if (!platform) {
    const e = new Error(
      `Plataforma desconocida: "${id}". Soportadas: ${Object.keys(PLATFORMS).join(', ')}.`
    );
    e.userMessage = e.message;
    throw e;
  }
  return platform;
}

function listPlatformIds() {
  return Object.keys(PLATFORMS);
}

module.exports = { getPlatform, listPlatformIds, DEFAULT_PLATFORM_ID };
