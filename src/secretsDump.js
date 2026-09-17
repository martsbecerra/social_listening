#!/usr/bin/env node
// Proceso hijo de loadSecretsSync: imprime SOLO el JSON de secrets a stdout.
// Los errores van a stderr. No loguear valores.
'use strict';

const { fetchSecretsRecord } = require('./secrets');

fetchSecretsRecord()
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
