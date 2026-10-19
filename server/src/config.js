const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

// Settings can live in a .env file at the project root (see .env.example).
// Variables already set in the environment win.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env file */
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

module.exports = Object.freeze({
  host: process.env.HOST || '0.0.0.0',
  port: number('PORT', 6767),

  // Defaults to the database from `docker compose up -d db`.
  databaseUrl: process.env.DATABASE_URL || 'postgres://ottv2:ottv2@localhost:5433/ottv2',
  sessionDays: number('SESSION_DAYS', 30),

  clientDir: path.join(root, 'client'),
  libraryDir: path.join(root, 'library'),
  logDir: process.env.LOG_DIR || path.join(root, 'server', 'logs'),

  // Pause between moves so people can follow the game live. The bots themselves
  // usually answer in a few milliseconds.
  moveDelayMs: number('MOVE_DELAY_MS', 600),
  // Tournaments play many games, so their games move a little faster by default.
  tournamentMoveDelayMs: number('TOURNAMENT_MOVE_DELAY_MS', 300),
  moveTimeLimitMs: number('MOVE_TIME_LIMIT_MS', 1000),
  loadTimeLimitMs: number('LOAD_TIME_LIMIT_MS', 2000),
  botMemoryMb: number('BOT_MEMORY_MB', 64),
  maxCodeBytes: number('MAX_CODE_BYTES', 100 * 1024),

  // Every running game holds two bot processes (about 110 MB together), so cap
  // how many run at once. Extra games wait in a queue. 24 fits all the games of
  // a 4-player tournament.
  maxRunningMatches: number('MAX_RUNNING_MATCHES', 24),
  maxOpenMatches: number('MAX_OPEN_MATCHES', 50),
  keepFinishedMatches: number('KEEP_FINISHED_MATCHES', 30),
  waitingTimeoutMs: number('WAITING_TIMEOUT_MS', 30 * 60 * 1000),
});
