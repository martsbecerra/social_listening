#!/usr/bin/env node
// Importa los CSV ANTIK-PRO a SQLite (x_influencers).
// Uso: node scripts/import-x-influencers.js

require('../src/secrets').loadSecretsOrExit();

const { importInfluencerCsvs } = require('../src/x/influencers');

const result = importInfluencerCsvs();
console.log(`Importados ${result.imported} handles a x_influencers.`);
console.log(`  numérico: ${result.numericPath}`);
console.log(`  extra:    ${result.extraPath}`);
