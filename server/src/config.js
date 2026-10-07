const path = require('node:path');

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const root = path.resolve(__dirname, '..', '..');

module.exports = Object.freeze({
  host: process.env.HOST || '0.0.0.0',
  port: number('PORT', 6767),

  clientDir: path.join(root, 'client'),
  libraryDir: path.join(root, 'library'),
  logDir: process.env.LOG_DIR || path.join(root, 'server', 'logs'),

  // Pause between moves so people can follow the game live. The bots themselves
  // usually answer in a few milliseconds.
  moveDelayMs: number('MOVE_DELAY_MS', 600),
  moveTimeLimitMs: number('MOVE_TIME_LIMIT_MS', 1000),
  loadTimeLimitMs: number('LOAD_TIME_LIMIT_MS', 2000),
  botMemoryMb: number('BOT_MEMORY_MB', 64),
  maxCodeBytes: number('MAX_CODE_BYTES', 100 * 1024),

  // Every running match holds two bot processes, so cap how many run at once.
  // Extra matches wait in a queue.
  maxRunningMatches: number('MAX_RUNNING_MATCHES', 8),
  maxOpenMatches: number('MAX_OPEN_MATCHES', 50),
  keepFinishedMatches: number('KEEP_FINISHED_MATCHES', 30),
  waitingTimeoutMs: number('WAITING_TIMEOUT_MS', 30 * 60 * 1000),
});
