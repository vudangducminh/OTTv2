const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const OTT = require('../../library/ottv2.js');
const config = require('./config');

const RUNNER = path.join(__dirname, 'bot-runner.js');
const LIBRARY_SOURCE = fs.readFileSync(path.join(config.libraryDir, 'ottv2.js'), 'utf8');

// Extra time the parent allows on top of the in-sandbox limit before it
// assumes the process is wedged and kills it.
const GRACE_MS = 1500;

class BotError extends Error {}

/** One submitted bot, running in its own locked-down Node process. */
class BotProcess {
  constructor(options = {}) {
    this.moveTimeLimit = options.moveTimeLimit || config.moveTimeLimitMs;
    this.loadTimeLimit = options.loadTimeLimit || config.loadTimeLimitMs;
    this.memoryMb = options.memoryMb || config.botMemoryMb;
    this.child = null;
    this.pending = null;
    this.nextId = 1;
    this.stderr = '';
    this.exited = false;
  }

  _spawn() {
    this.child = fork(RUNNER, [], {
      execArgv: [
        `--max-old-space-size=${this.memoryMb}`,
        '--experimental-permission',
        `--allow-fs-read=${RUNNER}`,
        '--no-warnings',
      ],
      env: {},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.on('message', (message) => {
      const pending = this.pending;
      if (!pending || !message || message.id !== pending.id) return;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(message);
    });
    this.child.on('exit', () => {
      this.exited = true;
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new BotError(this._crashReason()));
    });
    this.child.on('error', () => {});
  }

  _crashReason() {
    if (/heap out of memory|Allocation failed/i.test(this.stderr)) {
      return `ran out of memory (the limit is ${this.memoryMb} MB)`;
    }
    return 'the bot process crashed';
  }

  _request(message, timeLimit) {
    if (!this.child || this.exited) return Promise.reject(new BotError('the bot process is not running'));
    if (this.pending) return Promise.reject(new BotError('the bot is still busy with another request'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.stop();
        reject(new BotError(`stopped responding (limit ${timeLimit} ms)`));
      }, timeLimit + GRACE_MS);
      this.pending = { id, resolve, reject, timer };
      this.child.send({ id, ...message, timeLimit });
    });
  }

  /** Starts the process and loads the code. Resolves with { logs }; rejects with a BotError. */
  async load(code) {
    this._spawn();
    const reply = await this._request({ type: 'load', code, library: LIBRARY_SOURCE }, this.loadTimeLimit);
    if (!reply.ok) throw Object.assign(new BotError(reply.error), { logs: reply.logs || [] });
    return { logs: reply.logs || [] };
  }

  /**
   * Asks for a move. Resolves with { move, ms, logs } where move is { from, to }
   * (not yet checked against the rules); rejects with a BotError.
   */
  async move(game, me) {
    const reply = await this._request({ type: 'turn', state: game.toJSON(), me }, this.moveTimeLimit);
    const logs = Array.isArray(reply.logs) ? reply.logs.map(String) : [];
    if (!reply.ok) throw Object.assign(new BotError(String(reply.error)), { logs, ms: reply.ms });
    const move = OTT.normalizeMove(reply.move);
    if (!move) throw Object.assign(new BotError('move() returned something that is not a move'), { logs });
    return { move, ms: Number(reply.ms) || 0, logs };
  }

  stop() {
    if (this.child && !this.exited) this.child.kill('SIGKILL');
  }
}

/**
 * Loads a bot and plays one turn on a fresh board, so obvious mistakes show up
 * at submission time instead of as a forfeit in the middle of a match.
 * Resolves with { ok: true, move, ms, logs } or { ok: false, error, logs }.
 */
async function checkBot(code, seat = 1) {
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'The code is empty.', logs: [] };
  if (Buffer.byteLength(code) > config.maxCodeBytes) {
    return { ok: false, error: `The code is larger than ${Math.round(config.maxCodeBytes / 1024)} KB.`, logs: [] };
  }

  const bot = new BotProcess();
  const logs = [];
  try {
    logs.push(...(await bot.load(code)).logs);
    const game = OTT.Game.create();
    if (seat === 2) game.play(OTT.random(game.legalMoves()));
    const reply = await bot.move(game, seat);
    logs.push(...reply.logs);
    const problem = game.validate(reply.move);
    if (problem) {
      return { ok: false, error: `On a test board your bot played ${reply.move.from} → ${reply.move.to}, but ${problem}.`, logs };
    }
    return { ok: true, move: reply.move, ms: reply.ms, logs };
  } catch (error) {
    if (!(error instanceof BotError)) throw error;
    logs.push(...(error.logs || []));
    return { ok: false, error: error.message, logs };
  } finally {
    bot.stop();
  }
}

module.exports = { BotProcess, BotError, checkBot };
