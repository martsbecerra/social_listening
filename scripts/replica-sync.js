// ==========================================================================
// scripts/replica-sync.js — Trae y aplica el último snapshot en una réplica.
// --------------------------------------------------------------------------
// Lo corre installer/iniciar-replica.bat antes de cada `node server.js`, con
// el server apagado (ver src/replicaSync.js). Sale siempre con 0: sin red o
// sin datos, la réplica arranca igual con lo último que tenga.
//
//   node scripts/replica-sync.js
// ==========================================================================

require('dotenv').config();
const { syncReplica, replicaOptionsFromEnv } = require('../src/replicaSync');

syncReplica(replicaOptionsFromEnv())
  .catch((err) => {
    console.error(`[réplica] la sincronización falló: ${err.message}`);
  })
  .finally(() => process.exit(0));
