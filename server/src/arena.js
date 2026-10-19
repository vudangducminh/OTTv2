const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ApiError } = require('./errors');
const { Match } = require('./match');
const { checkBot } = require('./sandbox');

const STATUS_ORDER = { running: 0, queued: 1, waiting: 2, finished: 3, cancelled: 3 };
const MAX_OPEN_PER_USER = 3;

function cleanText(value, label, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new ApiError(400, `Please enter ${label}.`);
  if (text.length > max) throw new ApiError(400, `${label[0].toUpperCase()}${label.slice(1)} must be at most ${max} characters.`);
  return text;
}

/** The example bots in library/examples, offered as templates and as house opponents. */
function loadExamples(libraryDir) {
  const dir = path.join(libraryDir, 'examples');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch {
    return [];
  }
  const order = ['random', 'greedy', 'lookahead'];
  return files
    .map((file) => {
      const code = fs.readFileSync(path.join(dir, file), 'utf8');
      const id = path.basename(file, '.js');
      const firstLine = (code.split('\n')[0] || '').replace(/^\/\/\s*/, '');
      const [title, description = ''] = firstLine.split(/\s+—\s+/);
      return { id, name: title || id, description, code };
    })
    .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
}

function requireUser(user) {
  if (!user) throw new ApiError(401, 'Log in to submit a bot.');
}

/**
 * All matches on this server. Emits 'lobby' when the list changes, and
 * 'match-start' / 'match-update' / 'match-move' / 'match-log' with the match first.
 * With a database, finished matches are saved and rated.
 */
class Arena extends EventEmitter {
  constructor(config, { db = null } = {}) {
    super();
    this.config = config;
    this.db = db;
    this.matches = new Map();
    this.nextId = 1;
    this.examples = loadExamples(config.libraryDir);
    this.sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this.sweeper.unref();
  }

  /** Continues match numbering after the last saved match. */
  async init() {
    if (this.db) this.nextId = Math.max(this.nextId, await this.db.nextMatchId());
  }

  list() {
    return [...this.matches.values()]
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.finishedAt || b.id) - (a.finishedAt || a.id))
      .map((m) => m.summary());
  }

  get(id) {
    const match = this.matches.get(Number(id));
    if (!match) throw new ApiError(404, 'There is no such match. It may have finished a while ago.');
    return match;
  }

  example(id) {
    return this.examples.find((e) => e.id === id) || null;
  }

  async check(user, code, seat) {
    requireUser(user);
    return checkBot(code, seat === 2 ? 2 : 1);
  }

  /** Opens a new match with `user` in seat 1, optionally against a house bot. */
  async create(user, { name, code, opponent }) {
    requireUser(user);
    const matchName = cleanText(name || `${user.username}'s match`, 'a match name', 40);
    const house = opponent ? this.example(String(opponent)) : null;
    if (opponent && !house) throw new ApiError(400, 'That house bot does not exist.');

    const open = [...this.matches.values()].filter((m) => m.status !== 'finished' && m.status !== 'cancelled');
    if (open.length >= this.config.maxOpenMatches) {
      throw new ApiError(503, 'The arena is full right now. Try again when a match has finished.');
    }
    if (open.filter((m) => !m.tournament && m.seatOf(user.id)).length >= MAX_OPEN_PER_USER) {
      throw new ApiError(429, `You already have ${MAX_OPEN_PER_USER} matches open. Wait for one to finish first.`);
    }

    await this._requireWorkingBot(code, 1);

    const match = this._register(new Match({ id: this.nextId++, name: matchName, config: this.config, onFinish: (m) => this._save(m) }));
    match.sit(1, { name: user.username, code, userId: user.id });
    if (house) match.sit(2, { name: `${house.name} bot`, code: house.code, house: house.id });
    this._schedule();
    return { match, seat: 1 };
  }

  /** Takes the open seat in a waiting match. */
  async join(id, user, { code }) {
    requireUser(user);
    const match = this.get(id);
    const seat = match.openSeat;
    if (!seat) throw new ApiError(409, 'This match already has two players.');

    await this._requireWorkingBot(code, seat);

    // Someone may have taken the seat while the bot was being checked.
    if (match.openSeat !== seat) throw new ApiError(409, 'Someone else just took this seat.');
    match.sit(seat, { name: user.username, code, userId: user.id });
    this._schedule();
    return { match, seat };
  }

  /**
   * Starts a game between two prepared players (used by tournaments).
   * players: [{ userId, name, code }, …] in seat order (Red first).
   * onDone(match, saved) runs once the result has been saved (saved = false if that failed).
   */
  startGame({ name, players, tournament = null, onDone = null }) {
    const config = tournament ? { ...this.config, moveDelayMs: this.config.tournamentMoveDelayMs } : this.config;
    const match = this._register(
      new Match({
        id: this.nextId++,
        name,
        config,
        tournament,
        onFinish: async (m) => {
          let saved = false;
          try {
            const result = await this._save(m);
            saved = true;
            return result;
          } finally {
            if (onDone) setImmediate(() => onDone(m, saved));
          }
        },
      }),
    );
    players.forEach((player, index) => match.sit(index + 1, player));
    this._schedule();
    return match;
  }

  cancel(id, user) {
    requireUser(user);
    const match = this.get(id);
    if (match.tournament) throw new ApiError(403, 'Tournament games cannot be cancelled.');
    if (!match.seatOf(user.id)) throw new ApiError(403, 'Only a player in this match can cancel it.');
    if (!match.cancel(`${user.username} cancelled the match`)) {
      throw new ApiError(409, 'The match has already started, so it can no longer be cancelled.');
    }
    return match;
  }

  async _requireWorkingBot(code, seat) {
    const check = await checkBot(code, seat);
    if (!check.ok) {
      throw new ApiError(422, `Your bot did not pass the check: ${check.error}`, { botError: check.error, logs: check.logs });
    }
  }

  _save(match) {
    if (!this.db) return null;
    return this.db.recordMatch({
      id: match.id,
      name: match.name,
      players: match.players.map((p) => ({ userId: p.userId, name: p.name })),
      winner: match.game.winner,
      reason: match.game.reason,
      plies: match.game.ply,
      startedAt: match.startedAt,
      finishedAt: match.finishedAt,
      tournament: match.tournament
        ? {
            matchId: match.tournament.matchId,
            gameNumber: match.tournament.gameNumber,
            playerA: match.tournament.playerA,
            gamesPerMatch: match.tournament.gamesPerMatch,
          }
        : null,
    });
  }

  _register(match) {
    this.matches.set(match.id, match);
    match.on('update', () => {
      this.emit('match-update', match);
      this.emit('lobby');
      if (match.status === 'finished' || match.status === 'cancelled') {
        this._prune();
        this._schedule();
      }
    });
    match.on('start', () => this.emit('match-start', match));
    match.on('move', (record) => {
      this.emit('match-move', match, record);
      this.emit('lobby');
    });
    match.on('log', (entry) => this.emit('match-log', match, entry));
    this.emit('lobby');
    return match;
  }

  _schedule() {
    const all = [...this.matches.values()];
    let running = all.filter((m) => m.status === 'running').length;
    for (const match of all.filter((m) => m.status === 'queued').sort((a, b) => a.id - b.id)) {
      if (running >= this.config.maxRunningMatches) break;
      running++;
      match.run().catch((error) => console.error(`Match #${match.id} crashed:`, error));
    }
  }

  _prune() {
    const done = [...this.matches.values()]
      .filter((m) => m.status === 'finished' || m.status === 'cancelled')
      .sort((a, b) => b.finishedAt - a.finishedAt);
    for (const match of done.slice(this.config.keepFinishedMatches)) {
      this.matches.delete(match.id);
      match.removeAllListeners();
    }
  }

  _sweep() {
    const cutoff = Date.now() - this.config.waitingTimeoutMs;
    for (const match of this.matches.values()) {
      if (match.status === 'waiting' && match.createdAt < cutoff) match.cancel('Nobody joined in time');
    }
  }
}

module.exports = { Arena };
