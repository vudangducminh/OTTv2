const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const OTT = require('../../library/ottv2.js');
const { BotProcess, BotError } = require('./sandbox');

const COLORS = { 1: 'Red', 2: 'Blue' };
const MAX_BOT_LOG_LINES = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeMove(record) {
  const head = `#${record.ply} P${record.player} ${record.type} ${record.from} → ${record.to}`;
  if (record.outcome === 'win') return `${head} — beats ${record.defender.type}, which is removed`;
  if (record.outcome === 'lose') return `${head} — loses to ${record.defender.type} and is removed`;
  return head;
}

function placement(tokens, player) {
  return OTT.TYPES.map((type) => {
    const cells = tokens.filter((t) => t.owner === player && t.type === type).map((t) => t.cell).sort();
    return `${type} ${cells.join(' ')}`;
  }).join('; ');
}

/**
 * One table: two seats, a game and its log. Emits:
 *   'start'             the board has been dealt
 *   'update'            seats, status or counts changed
 *   'move'   (record)   a move was played
 *   'log'    (entries)  new log entries
 */
class Match extends EventEmitter {
  constructor({ id, name, config }) {
    super();
    this.id = id;
    this.name = name;
    this.config = config;
    this.status = 'waiting'; // waiting → queued → running → finished | cancelled
    this.players = [null, null];
    this.game = null;
    this.initial = null;
    this.moves = [];
    this.log = [];
    this.result = null;
    this.forfeitMessage = null;
    this.watchers = 0;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.bots = [null, null];
    this.botLogLines = 0;
    this.logFile = null;
  }

  get openSeat() {
    if (this.status !== 'waiting') return null;
    const index = this.players.findIndex((p) => p === null);
    return index === -1 ? null : index + 1;
  }

  /** Puts a player in `seat` (1 or 2). Returns the secret that lets them cancel. */
  sit(seat, { name, code, house = null }) {
    if (this.players[seat - 1]) throw new Error('That seat is already taken.');
    const secret = crypto.randomBytes(16).toString('hex');
    this.players[seat - 1] = { seat, name, code, house, secret, joinedAt: Date.now() };
    this._log('system', `${name} sits down as P${seat} (${COLORS[seat]})${house ? ' — house bot' : ''}`);
    if (this.players.every(Boolean)) this.status = 'queued';
    this.emit('update');
    return secret;
  }

  cancel(reason) {
    if (this.status !== 'waiting' && this.status !== 'queued') return false;
    this.status = 'cancelled';
    this.finishedAt = Date.now();
    this.result = { winner: null, reason: 'cancelled', message: reason };
    this._log('result', `Match cancelled: ${reason}`);
    this._closeLog();
    this.emit('update');
    return true;
  }

  async run() {
    if (this.status !== 'queued') return;
    this.status = 'running';
    this.startedAt = Date.now();
    this.game = OTT.Game.create();
    this.initial = this.game.tokens();
    this._openLog();
    const [p1, p2] = this.players;
    this._log('system', `Match #${this.id} "${this.name}" started: P1 ${p1.name} (Red) vs P2 ${p2.name} (Blue)`);
    this._log('system', `P1 starts on rows a–c and wins by reaching i9. P2 starts on rows g–i and wins by reaching a1.`);
    this._log('system', `P1 placement: ${placement(this.initial, 1)}`);
    this._log('system', `P2 placement: ${placement(this.initial, 2)}`);
    this.emit('start');
    this.emit('update');

    try {
      await this._loadBots();
      while (!this.game.isOver) await this._playTurn();
    } catch (error) {
      // Anything unexpected here is a server bug, not the bots' fault.
      this._log('error', `Server error, match stopped: ${error.message}`);
      if (!this.game.isOver) this.game._finish(0, 'error');
    } finally {
      for (const bot of this.bots) if (bot) bot.stop();
    }
    this._finish();
  }

  async _loadBots() {
    const { config } = this;
    for (const seat of [1, 2]) {
      const bot = new BotProcess({ moveTimeLimit: config.moveTimeLimitMs, loadTimeLimit: config.loadTimeLimitMs });
      this.bots[seat - 1] = bot;
      try {
        const { logs } = await bot.load(this.players[seat - 1].code);
        this._botOutput(seat, logs);
      } catch (error) {
        if (!(error instanceof BotError)) throw error;
        this._botOutput(seat, error.logs);
        this._forfeit(seat, `its code failed to load: ${error.message}`);
        return;
      }
    }
  }

  async _playTurn() {
    const { game, config } = this;
    const seat = game.turn;
    const started = Date.now();
    let reply;
    try {
      reply = await this.bots[seat - 1].move(game, seat);
    } catch (error) {
      if (!(error instanceof BotError)) throw error;
      this._botOutput(seat, error.logs);
      this._forfeit(seat, error.message);
      return;
    }
    this._botOutput(seat, reply.logs);

    const problem = game.validate(reply.move);
    if (problem) {
      this._forfeit(seat, `it played ${reply.move.from} → ${reply.move.to}, but ${problem}`);
      return;
    }

    const record = game.play(reply.move);
    this.moves.push(record);
    this._log('move', describeMove(record), seat);
    this.emit('move', record);

    if (!game.isOver) {
      const wait = config.moveDelayMs - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }

  _forfeit(seat, why) {
    this._log('error', `P${seat} ${this.players[seat - 1].name}'s bot forfeits: ${why}`, seat);
    this.forfeitMessage = `${this.players[seat - 1].name}'s bot forfeited: ${why}.`;
    this.game.forfeit(seat);
  }

  _finish() {
    const { game } = this;
    const winner = game.winner;
    this.status = 'finished';
    this.finishedAt = Date.now();
    this.result = { winner, reason: game.reason, message: this._resultMessage() };
    this._log('result', `Game over after ${game.ply} moves. ${this.result.message}`);
    this._closeLog();
    this.emit('update');
  }

  _resultMessage() {
    const { game } = this;
    const name = (seat) => `${this.players[seat - 1].name} (P${seat})`;
    const winner = game.winner;
    switch (game.reason) {
      case 'target': {
        const last = game.lastMove;
        return `${name(winner)} wins: a ${last.type} token reached ${last.to} on move ${last.ply}.`;
      }
      case 'eliminated':
        return `${name(winner)} wins: the opponent has no tokens left.`;
      case 'no-moves':
        return `${name(winner)} wins: the opponent has no legal moves left.`;
      case 'turn-limit': {
        const counts = `${game.count(1)}–${game.count(2)}`;
        if (winner === 0) return `Draw: the ${game.maxPlies}-move limit was reached with ${counts} tokens.`;
        return `${name(winner)} wins on tokens (${counts}) at the ${game.maxPlies}-move limit.`;
      }
      case 'forfeit':
        return `${name(winner)} wins. ${this.forfeitMessage || ''}`.trim();
      default:
        return 'The match was stopped by a server error.';
    }
  }

  _botOutput(seat, lines) {
    if (!lines || !lines.length) return;
    for (const line of lines) {
      if (this.botLogLines === MAX_BOT_LOG_LINES) {
        this._log('bot', `Further bot output in this match is not shown (limit ${MAX_BOT_LOG_LINES} lines).`);
      }
      this.botLogLines++;
      if (this.botLogLines > MAX_BOT_LOG_LINES) return;
      this._log('bot', `P${seat} says: ${line}`, seat);
    }
  }

  _log(kind, text, player = null) {
    const entry = { at: Date.now(), kind, text, player };
    this.log.push(entry);
    if (this.logFile) this.logFile.write(`${new Date(entry.at).toISOString()} [${kind}] ${text}\n`);
    this.emit('log', entry);
  }

  _openLog() {
    const { logDir } = this.config;
    if (!logDir) return;
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = path.join(logDir, `match-${this.id}-${stamp}.log`);
    this.logFile = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.logFile.on('error', () => {
      this.logFile = null;
    });
    // Seat lines were logged before the file existed.
    for (const entry of this.log) this.logFile.write(`${new Date(entry.at).toISOString()} [${entry.kind}] ${entry.text}\n`);
  }

  _closeLog() {
    if (this.logFile) this.logFile.end();
    this.logFile = null;
  }

  /** Plain-text log, the same lines written to the log file. */
  logText() {
    return this.log.map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.text}`).join('\n') + '\n';
  }

  summary() {
    const game = this.game;
    const counts = (player) => {
      const out = { total: 0 };
      for (const type of OTT.TYPES) {
        out[type] = game ? game.count(player, type) : OTT.TOKENS_PER_TYPE;
        out.total += out[type];
      }
      return out;
    };
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      players: this.players.map((p) => (p ? { seat: p.seat, name: p.name, house: p.house } : null)),
      ply: game ? game.ply : 0,
      turn: game ? game.turn : 1,
      maxPlies: game ? game.maxPlies : OTT.MAX_PLIES,
      tokens: { 1: counts(1), 2: counts(2) },
      result: this.result,
      watchers: this.watchers,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  snapshot() {
    return { ...this.summary(), initial: this.initial, moves: this.moves, log: this.log };
  }
}

module.exports = { Match };
