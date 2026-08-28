const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/monitoring.db', { readOnly: true });

const counts = db
  .prepare(
    'SELECT plataforma, COUNT(*) AS n, SUM(CASE WHEN ignored=0 THEN 1 ELSE 0 END) AS visibles FROM detected_posts GROUP BY plataforma'
  )
  .all();
console.log('counts', JSON.stringify(counts, null, 2));

const sample = db
  .prepare(
    'SELECT plataforma, ignored, id, account, substr(url,1,120) AS url, substr(title,1,80) AS title FROM detected_posts ORDER BY detected_at DESC LIMIT 25'
  )
  .all();
console.log('sample', JSON.stringify(sample, null, 2));

const igOnX = db
  .prepare(
    "SELECT COUNT(*) AS n FROM detected_posts WHERE ignored=0 AND plataforma='x' AND url LIKE '%instagram%'"
  )
  .get();
console.log('ig urls on x', igOnX);

const xOnIg = db
  .prepare(
    "SELECT COUNT(*) AS n FROM detected_posts WHERE ignored=0 AND plataforma='instagram' AND (url LIKE '%x.com%' OR url LIKE '%twitter.com%')"
  )
  .get();
console.log('x urls on ig', xOnIg);

const xPosts = db
  .prepare(
    "SELECT id, account, substr(url,1,120) AS url, substr(caption,1,80) AS caption FROM detected_posts WHERE ignored=0 AND plataforma='x' ORDER BY detected_at DESC LIMIT 10"
  )
  .all();
console.log('x posts', JSON.stringify(xPosts, null, 2));
