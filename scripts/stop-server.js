// ==========================================================================
// scripts/stop-server.js
// --------------------------------------------------------------------------
// Mata el proceso que está escuchando en PORT (default 3000).
// Sirve cuando quedó un Node huérfano y `npm start` falla con EADDRINUSE.
// ==========================================================================

require('dotenv').config();

const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || 3000);

function uniquePids(pids) {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}

function findPidsWindows(port) {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  const pids = [];
  const re = new RegExp(`[:\\]]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'gi');
  let match;
  while ((match = re.exec(out)) !== null) {
    pids.push(Number(match[1]));
  }
  return uniquePids(pids);
}

function findPidsUnix(port) {
  try {
    const out = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
    return uniquePids(out.split(/\s+/).map(Number));
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'inherit' });
    return;
  }
  process.kill(pid, 'SIGTERM');
}

const pids = process.platform === 'win32' ? findPidsWindows(PORT) : findPidsUnix(PORT);

if (pids.length === 0) {
  console.log(`No hay ningún proceso escuchando en el puerto ${PORT}.`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`Matando proceso ${pid} (puerto ${PORT})...`);
  try {
    killPid(pid);
  } catch (err) {
    console.error(`No se pudo matar el PID ${pid}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`✅ Puerto ${PORT} liberado.`);
