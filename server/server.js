const os = require('node:os');
const config = require('./src/config');
const { Arena } = require('./src/arena');
const { createServer } = require('./src/http');

const arena = new Arena(config);
const server = createServer(arena, config);

// One console line per match milestone; the move-by-move log goes to server/logs/.
arena.on('match-log', (match, entry) => {
  if (entry.kind === 'result' || /started:/.test(entry.text)) console.log(`[match #${match.id}] ${entry.text}`);
});

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

server.listen(config.port, config.host, () => {
  console.log(`OTTv2 arena running on http://localhost:${config.port}`);
  for (const address of localAddresses()) console.log(`                    and http://${address}:${config.port}`);
  console.log(`Match logs are written to ${config.logDir}`);
});
