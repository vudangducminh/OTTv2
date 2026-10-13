const os = require('node:os');
const config = require('./src/config');
const { Accounts } = require('./src/accounts');
const { Arena } = require('./src/arena');
const { Database } = require('./src/db');
const { createServer } = require('./src/http');

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

async function main() {
  const db = new Database(config.databaseUrl);
  try {
    await db.connect();
    await db.migrate();
  } catch (error) {
    console.error(error.message);
    console.error('\nStart the database with `docker compose up -d db`, or point DATABASE_URL at your PostgreSQL (see .env.example).');
    process.exit(1);
  }

  const accounts = new Accounts(db, config);
  const arena = new Arena(config, { db });
  await arena.init();
  const server = createServer({ arena, accounts, db, config });

  // One console line per match milestone; the move-by-move log goes to server/logs/.
  arena.on('match-log', (match, entry) => {
    if (entry.kind === 'result' || /started:/.test(entry.text) || /^Ratings:/.test(entry.text)) {
      console.log(`[match #${match.id}] ${entry.text}`);
    }
  });

  const cleanup = setInterval(() => db.deleteExpiredSessions().catch(() => {}), 60 * 60 * 1000);
  cleanup.unref();

  server.listen(config.port, config.host, () => {
    console.log(`OTTv2 arena running on http://localhost:${config.port}`);
    for (const address of localAddresses()) console.log(`                    and http://${address}:${config.port}`);
    console.log(`Match logs are written to ${config.logDir}`);
  });

  // `docker stop` sends SIGTERM; close connections instead of being killed after the timeout.
  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down.`);
    server.closeAllConnections();
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main();
