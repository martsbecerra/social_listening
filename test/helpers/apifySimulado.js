'use strict';

// Un fetch simulado de la API de Apify para los tests del análisis. La
// publicación va por el endpoint sincrónico del actor oficial y los
// comentarios (apify~instagram-comment-scraper, desde la fase G) por el
// flujo asincrónico: arrancar el run, que acá vuelve ya terminado, y bajar
// los items de su dataset. `responder(input, actor)` devuelve los items de
// cada corrida (o una promesa); `inputs` junta lo que se le pidió a cada
// actor. Un pedido fuera de api.apify.com va a `otro` (por defecto, tira:
// sin red).

function apifySimulado(responder, { status = 201, otro = null } = {}) {
  const json = (data, s) => new Response(JSON.stringify(data), { status: s, headers: { 'Content-Type': 'application/json' } });
  const runs = new Map();
  const inputs = [];
  const fetchSimulado = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('api.apify.com')) {
      if (otro) return otro(url, opts);
      throw new Error(`sin red: ${u}`);
    }
    const sync = u.match(/\/acts\/([^/]+)\/run-sync-get-dataset-items/);
    if (sync) {
      const input = JSON.parse(opts.body);
      inputs.push({ actor: sync[1], input });
      return json(await responder(input, sync[1]), status);
    }
    const arranque = u.match(/\/acts\/([^/]+)\/runs\?/);
    if (arranque) {
      const input = JSON.parse(opts.body);
      inputs.push({ actor: arranque[1], input });
      const id = `run-${runs.size + 1}`;
      runs.set(id, { actor: arranque[1], input });
      return json({ data: { id, status: 'SUCCEEDED', defaultDatasetId: id } }, 201);
    }
    const dataset = u.match(/\/datasets\/([^/?]+)\/items/);
    if (dataset && runs.has(dataset[1])) {
      const run = runs.get(dataset[1]);
      return json(await responder(run.input, run.actor), 200);
    }
    throw new Error(`pedido a Apify no simulado: ${u}`);
  };
  fetchSimulado.inputs = inputs;
  return fetchSimulado;
}

module.exports = { apifySimulado };
