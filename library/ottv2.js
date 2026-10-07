/*!
 * ottv2.js — the OTTv2 bot library.
 *
 * One file, no dependencies. The same code runs in three places:
 *   - inside the server sandbox, where your bot gets it from require('ottv2'),
 *   - on the server itself, which uses it as the authoritative rules engine,
 *   - in the browser, where the client replays matches with it.
 * Because everyone shares this file, game.legalMoves() lists exactly the moves
 * the server will accept.
 *
 * Board: rows a–i (top to bottom), columns 1–9 (left to right), so cells run a1…i9.
 * Player 1 starts on rows a–c and wins by reaching i9.
 * Player 2 starts on rows g–i and wins by reaching a1.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else root.OTT = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 9;
  const ROWS = 'abcdefghi';
  const ROCK = 'rock';
  const PAPER = 'paper';
  const SCISSORS = 'scissors';
  const TYPES = Object.freeze([ROCK, PAPER, SCISSORS]);
  const TOKENS_PER_TYPE = 6;
  const MAX_PLIES = 400;
  const HOME_ROWS = Object.freeze({ 1: 'abc', 2: 'ghi' });
  const TARGETS = Object.freeze({ 1: 'i9', 2: 'a1' });
  const BEATS = Object.freeze({ rock: SCISSORS, scissors: PAPER, paper: ROCK });

  /** The other player: other(1) === 2, other(2) === 1. */
  function other(player) {
    return player === 1 ? 2 : 1;
  }

  /** True when a token of type `a` beats a token of type `b`. */
  function beats(a, b) {
    return BEATS[a] === b;
  }

  /** Result of `attacker` moving onto `defender`: 'win', 'lose' or 'tie'. */
  function battle(attacker, defender) {
    if (attacker === defender) return 'tie';
    return beats(attacker, defender) ? 'win' : 'lose';
  }

  /** The type that beats `type`: counter('rock') === 'paper'. */
  function counter(type) {
    return TYPES.find((t) => BEATS[t] === type);
  }

  /** Cell name from zero-based indexes: cell(0, 0) === 'a1'. Null when off the board. */
  function cell(row, col) {
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
    return ROWS[row] + (col + 1);
  }

  /** Zero-based indexes of a cell: coords('c4') → { row: 2, col: 3 }. Null when invalid. */
  function coords(name) {
    if (typeof name !== 'string' || name.length !== 2) return null;
    const row = ROWS.indexOf(name[0].toLowerCase());
    const col = name.charCodeAt(1) - 49;
    if (row < 0 || col < 0 || col >= SIZE) return null;
    return { row, col };
  }

  function isCell(name) {
    return coords(name) !== null;
  }

  /** Every cell, a1 to i9. */
  function allCells() {
    const cells = [];
    for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) cells.push(cell(row, col));
    return cells;
  }

  const NEIGHBORS = new Map();
  for (const name of allCells()) {
    const { row, col } = coords(name);
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const next = (dr || dc) && cell(row + dr, col + dc);
        if (next) list.push(next);
      }
    }
    NEIGHBORS.set(name, Object.freeze(list));
  }

  /** The (up to 8) cells touching `name`, diagonals included. */
  function neighbors(name) {
    return NEIGHBORS.get(String(name).toLowerCase()) || [];
  }

  /** How many moves a token needs to get from `a` to `b` on an empty board. */
  function distance(a, b) {
    const p = coords(a);
    const q = coords(b);
    if (!p || !q) return Infinity;
    return Math.max(Math.abs(p.row - q.row), Math.abs(p.col - q.col));
  }

  /** A random element of `list` (undefined when empty). */
  function random(list, rng) {
    if (!list || !list.length) return undefined;
    return list[Math.floor((rng || Math.random)() * list.length)];
  }

  function shuffle(list, rng) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  const MOVE_PATTERN = /^\s*([a-i][1-9])\s*(?:->|-|>|→|,|to\b)?\s*([a-i][1-9])\s*$/i;

  /**
   * Turns anything that looks like a move into { from, to }, or null.
   * Accepts { from, to } (including the objects from legalMoves()), ['c3', 'd4'],
   * and strings such as 'c3 d4', 'c3-d4', 'c3->d4' or 'c3d4'.
   */
  function normalizeMove(input) {
    let from;
    let to;
    if (typeof input === 'string') {
      const match = MOVE_PATTERN.exec(input);
      if (!match) return null;
      [, from, to] = match;
    } else if (Array.isArray(input)) {
      [from, to] = input;
    } else if (input && typeof input === 'object') {
      ({ from, to } = input);
    }
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    from = from.trim().toLowerCase();
    to = to.trim().toLowerCase();
    if (!isCell(from) || !isCell(to)) return null;
    return { from, to };
  }

  function freezeToken(token) {
    return Object.freeze({ id: token.id, owner: token.owner, type: token.type, cell: token.cell });
  }

  /**
   * A game position. Your bot's move(game) receives one of these.
   *
   * Tokens are frozen { id, owner, type, cell } objects. game.after(move) returns
   * a new Game without touching the original, so it is safe for lookahead.
   */
  class Game {
    constructor(state) {
      state = state || {};
      this._cells = new Map();
      for (const raw of state.tokens || []) {
        const token = freezeToken(raw);
        if (!isCell(token.cell)) throw new Error(`Token ${token.id} is on an invalid cell: ${token.cell}`);
        if (token.owner !== 1 && token.owner !== 2) throw new Error(`Token ${token.id} has an invalid owner`);
        if (!TYPES.includes(token.type)) throw new Error(`Token ${token.id} has an invalid type: ${token.type}`);
        if (this._cells.has(token.cell)) throw new Error(`Two tokens share ${token.cell}`);
        this._cells.set(token.cell, token);
      }
      /** The player whose turn it is (1 or 2). */
      this.turn = state.turn === 2 ? 2 : 1;
      /** How many moves have been played so far. */
      this.ply = state.ply | 0;
      /** 1 or 2 once someone has won, 0 for a draw, null while the game is running. */
      this.winner = state.winner === undefined ? null : state.winner;
      /** Why the game ended: 'target', 'eliminated', 'no-moves', 'turn-limit' or 'forfeit'. */
      this.reason = state.reason || null;
      /** Every move played so far, oldest first (see play() for the shape). */
      this.history = Array.isArray(state.history) ? state.history.slice() : [];
      /** The game ends after this many moves in total. */
      this.maxPlies = state.maxPlies || MAX_PLIES;
      /** The player your bot controls. Set by the sandbox; defaults to whoever is to move. */
      this.me = state.me === 1 || state.me === 2 ? state.me : null;
    }

    /** A fresh game with both sides placed at random on their home rows. */
    static create(options) {
      options = options || {};
      const rng = options.random || Math.random;
      const tokens = [];
      let id = 1;
      for (const player of [1, 2]) {
        const cells = [];
        for (const row of HOME_ROWS[player]) for (let col = 1; col <= SIZE; col++) cells.push(row + col);
        shuffle(cells, rng);
        let index = 0;
        for (const type of TYPES) {
          for (let i = 0; i < TOKENS_PER_TYPE; i++) tokens.push({ id: id++, owner: player, type, cell: cells[index++] });
        }
      }
      return new Game({ tokens, turn: 1, maxPlies: options.maxPlies });
    }

    static fromJSON(state) {
      return new Game(state);
    }

    get opponent() {
      return other(this.me || this.turn);
    }

    /** The cell you are racing to: 'i9' for player 1, 'a1' for player 2. */
    get myTarget() {
      return TARGETS[this.me || this.turn];
    }

    get opponentTarget() {
      return TARGETS[this.opponent];
    }

    get isOver() {
      return this.winner !== null;
    }

    /** The move just played, or null at the start. */
    get lastMove() {
      return this.history.length ? this.history[this.history.length - 1] : null;
    }

    /** The token on `cell`, or null when it is empty. */
    at(name) {
      return this._cells.get(String(name).toLowerCase()) || null;
    }

    /** All tokens on the board, or only `player`'s, sorted by id. */
    tokens(player) {
      const list = [];
      for (const token of this._cells.values()) if (!player || token.owner === player) list.push(token);
      return list.sort((a, b) => a.id - b.id);
    }

    myTokens() {
      return this.tokens(this.me || this.turn);
    }

    opponentTokens() {
      return this.tokens(this.opponent);
    }

    /** How many tokens `player` has left, optionally only of one `type`. */
    count(player, type) {
      let n = 0;
      for (const token of this._cells.values()) if (token.owner === player && (!type || token.type === type)) n++;
      return n;
    }

    /**
     * Every move `player` (default: whoever is to move) may make right now.
     * Each move is { from, to, token, defender, outcome } where outcome is
     * 'move' (empty cell), 'win' (you capture defender) or 'lose' (your token is
     * removed). Ties are not legal moves, so they never appear.
     */
    legalMoves(player) {
      if (this.isOver) return [];
      const moves = [];
      for (const token of this.tokens(player || this.turn)) this._pushMoves(token, moves);
      return moves;
    }

    /** Legal moves for the token on `cell`, whoever owns it. */
    movesFrom(name) {
      const token = this.at(name);
      const moves = [];
      if (token && !this.isOver) this._pushMoves(token, moves);
      return moves;
    }

    _pushMoves(token, moves) {
      for (const to of NEIGHBORS.get(token.cell)) {
        const defender = this._cells.get(to) || null;
        if (defender && defender.owner === token.owner) continue;
        const outcome = defender ? battle(token.type, defender.type) : 'move';
        if (outcome === 'tie') continue;
        moves.push(Object.freeze({ from: token.cell, to, token, defender, outcome }));
      }
    }

    /**
     * Opponent tokens next to `cell` that would beat a `type` token standing
     * there, i.e. what could capture you if you moved there.
     */
    threats(name, type, owner) {
      owner = owner || this.me || this.turn;
      const result = [];
      for (const next of neighbors(name)) {
        const token = this._cells.get(next);
        if (token && token.owner !== owner && beats(token.type, type)) result.push(token);
      }
      return result;
    }

    /** Null when `move` is legal for the player to move, otherwise a reason. */
    validate(input) {
      if (this.isOver) return 'the game is already over';
      const move = normalizeMove(input);
      if (!move) return 'that is not a move — return { from, to } or a string such as "c3 d4"';
      const token = this._cells.get(move.from);
      if (!token) return `there is no token on ${move.from}`;
      if (token.owner !== this.turn) return `the token on ${move.from} belongs to player ${token.owner}`;
      if (distance(move.from, move.to) !== 1) return `${move.to} is not next to ${move.from}`;
      const defender = this._cells.get(move.to);
      if (defender && defender.owner === token.owner) return `${move.to} is already occupied by your own ${defender.type}`;
      if (defender && defender.type === token.type) {
        return `${token.type} against ${defender.type} is a tie, and ties are not allowed`;
      }
      return null;
    }

    isLegal(move) {
      return this.validate(move) === null;
    }

    /**
     * Plays a move in place and returns its record:
     * { ply, player, id, type, from, to, outcome, defender: { id, type } | null }.
     * Throws on an illegal move.
     */
    play(input) {
      const error = this.validate(input);
      if (error) throw new Error(`Illegal move: ${error}`);
      const { from, to } = normalizeMove(input);
      const token = this._cells.get(from);
      const defender = this._cells.get(to) || null;
      const outcome = defender ? battle(token.type, defender.type) : 'move';

      this._cells.delete(from);
      if (outcome !== 'lose') this._cells.set(to, freezeToken({ ...token, cell: to }));
      this.ply += 1;
      const record = Object.freeze({
        ply: this.ply,
        player: token.owner,
        id: token.id,
        type: token.type,
        from,
        to,
        outcome,
        defender: defender ? Object.freeze({ id: defender.id, type: defender.type }) : null,
      });
      this.history.push(record);
      this._settle(record);
      return record;
    }

    _settle(record) {
      const mover = record.player;
      const rival = other(mover);
      if (record.outcome !== 'lose' && record.to === TARGETS[mover]) return this._finish(mover, 'target');
      if (this.count(rival) === 0) return this._finish(mover, 'eliminated');
      if (this.count(mover) === 0) return this._finish(rival, 'eliminated');
      this.turn = rival;
      if (this.ply >= this.maxPlies) {
        const lead = this.count(1) - this.count(2);
        return this._finish(lead > 0 ? 1 : lead < 0 ? 2 : 0, 'turn-limit');
      }
      if (this.legalMoves(rival).length === 0) return this._finish(mover, 'no-moves');
    }

    _finish(winner, reason) {
      this.winner = winner;
      this.reason = reason;
    }

    /** Ends the game with `player` losing, e.g. because their bot crashed. */
    forfeit(player) {
      if (!this.isOver) this._finish(other(player), 'forfeit');
    }

    /** A new Game with `move` applied; this one is left untouched. */
    after(move) {
      const next = this.clone();
      next.play(move);
      return next;
    }

    clone() {
      const copy = Object.create(Game.prototype);
      copy._cells = new Map(this._cells);
      copy.turn = this.turn;
      copy.ply = this.ply;
      copy.winner = this.winner;
      copy.reason = this.reason;
      copy.history = this.history.slice();
      copy.maxPlies = this.maxPlies;
      copy.me = this.me;
      return copy;
    }

    toJSON() {
      const state = {
        tokens: this.tokens(),
        turn: this.turn,
        ply: this.ply,
        winner: this.winner,
        reason: this.reason,
        maxPlies: this.maxPlies,
        history: this.history,
      };
      if (this.me) state.me = this.me;
      return state;
    }

    /** ASCII board for console.log: player 1 in CAPITALS (R P S), player 2 in lowercase. */
    toString() {
      const lines = ['   1 2 3 4 5 6 7 8 9'];
      for (let row = 0; row < SIZE; row++) {
        let line = ` ${ROWS[row]} `;
        for (let col = 0; col < SIZE; col++) {
          const token = this._cells.get(cell(row, col));
          const letter = token ? token.type[0] : '.';
          line += (token && token.owner === 1 ? letter.toUpperCase() : letter) + ' ';
        }
        lines.push(line.trimEnd());
      }
      return lines.join('\n');
    }
  }

  return Object.freeze({
    VERSION: '1.0.0',
    SIZE,
    ROWS,
    ROCK,
    PAPER,
    SCISSORS,
    TYPES,
    TOKENS_PER_TYPE,
    MAX_PLIES,
    HOME_ROWS,
    TARGETS,
    Game,
    other,
    beats,
    battle,
    counter,
    cell,
    coords,
    isCell,
    allCells,
    neighbors,
    distance,
    random,
    normalizeMove,
  });
});
