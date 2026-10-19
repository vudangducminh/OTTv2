// Round-robin tournaments. Every entrant plays every other entrant once; each
// pairing is a match of 4 games with alternating colours. A match won (more
// games won) is 3 points, a drawn match 1, a lost match 0. GD is games won
// minus games lost. Any number of tournaments can run at once; each has its
// own entrants, schedule and standings.
//
// When a tournament starts, all of its games start at once (every match, all
// 4 games of each). The arena's MAX_RUNNING_MATCHES still caps how many games
// run at the same moment; any beyond that wait in its queue.

const { EventEmitter } = require('node:events');
const { ApiError } = require('./errors');
const { POINTS } = require('./points');
const { checkBot } = require('./sandbox');

const GAMES_PER_MATCH = 4;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const MAX_OPEN_PER_ORGANIZER = 3;
const RETRY_MS = 30 * 1000;

function shuffle(list, rng = Math.random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * Round-robin schedule (circle method): with n players, n − 1 rounds (n rounds
 * if n is odd, one player sitting out each round) where everyone meets
 * everyone exactly once. Returns [{ round, playerA, playerB }]; playerA is Red
 * in games 1 and 3, chosen at random so neither side always starts.
 */
function roundRobin(playerIds, rng = Math.random) {
  const list = shuffle([...playerIds], rng);
  if (list.length % 2) list.push(null);
  const n = list.length;
  const pairings = [];
  for (let round = 1; round < n; round++) {
    for (let i = 0; i < n / 2; i++) {
      const x = list[i];
      const y = list[n - 1 - i];
      if (x === null || y === null) continue;
      const [playerA, playerB] = rng() < 0.5 ? [x, y] : [y, x];
      pairings.push({ round, playerA, playerB });
    }
    list.splice(1, 0, list.pop()); // keep the first player fixed, rotate the rest
  }
  return pairings;
}

/** Red in odd games is player A, in even games player B: R B R B for A, B R B R for B. */
function redIsA(gameNumber) {
  return gameNumber % 2 === 1;
}

/**
 * League table from completed matches. Sorted by points, then GD, then games
 * won, then name. Rows that tie on all three share a rank.
 */
function standings(entrants, matches, gamesPerMatch = GAMES_PER_MATCH) {
  const rows = new Map(
    entrants.map((e) => [e.id, { userId: e.id, username: e.username, mp: 0, w: 0, d: 0, l: 0, gw: 0, gl: 0, gd: 0, pts: 0 }]),
  );
  for (const m of matches) {
    if (m.gamesPlayed < gamesPerMatch) continue;
    const a = rows.get(m.playerA);
    const b = rows.get(m.playerB);
    if (!a || !b) continue;
    a.mp++;
    b.mp++;
    a.gw += m.aWins;
    a.gl += m.bWins;
    b.gw += m.bWins;
    b.gl += m.aWins;
    if (m.aWins > m.bWins) {
      a.w++;
      b.l++;
      a.pts += POINTS.win;
      b.pts += POINTS.loss;
    } else if (m.bWins > m.aWins) {
      b.w++;
      a.l++;
      b.pts += POINTS.win;
      a.pts += POINTS.loss;
    } else {
      a.d++;
      b.d++;
      a.pts += POINTS.draw;
      b.pts += POINTS.draw;
    }
  }
  const table = [...rows.values()].map((row) => ({ ...row, gd: row.gw - row.gl }));
  table.sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gw - x.gw || x.username.localeCompare(y.username));
  table.forEach((row, i) => {
    const prev = table[i - 1];
    row.rank = prev && prev.pts === row.pts && prev.gd === row.gd && prev.gw === row.gw ? prev.rank : i + 1;
  });
  return table;
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (name.length < 3 || name.length > 40) throw new ApiError(400, 'Tournament names are 3–40 characters.');
  return name;
}

function requireUser(user) {
  if (!user) throw new ApiError(401, 'Log in first.');
}

/** Key for one game of one tournament match. */
function gameKey(matchId, gameNumber) {
  return `${matchId}:${gameNumber}`;
}

/** Emits 'changed' (tournamentId) whenever a tournament's entrants, schedule or results change. */
class Tournaments extends EventEmitter {
  constructor({ db, arena }) {
    super();
    this.db = db;
    this.arena = arena;
    this.live = new Map(); // gameKey(match id, game number) → id of that game in the arena
    this.queues = new Map(); // tournament id → promise chain, so advancing never overlaps
  }

  /** Resumes tournaments that were running when the server stopped. */
  async init() {
    for (const id of await this.db.runningTournamentIds()) this.advance(id);
  }

  list() {
    return this.db.listTournaments();
  }

  async create(user, { name }) {
    requireUser(user);
    const clean = cleanName(name);
    if ((await this.db.openTournamentsBy(user.id)) >= MAX_OPEN_PER_ORGANIZER) {
      throw new ApiError(429, `You already organize ${MAX_OPEN_PER_ORGANIZER} open tournaments. Finish or cancel one first.`);
    }
    const id = await this.db.createTournament(clean, user.id, GAMES_PER_MATCH);
    this.emit('changed', id);
    return this.db.getTournament(id);
  }

  async _get(id) {
    const tournament = await this.db.getTournament(Number(id));
    if (!tournament) throw new ApiError(404, 'There is no such tournament.');
    return tournament;
  }

  /** Enters the tournament with a bot, or replaces the bot before it starts. */
  async enter(user, id, code) {
    requireUser(user);
    const tournament = await this._get(id);
    if (tournament.status !== 'registration') throw new ApiError(409, 'This tournament has already started.');
    const check = await checkBot(code, 1);
    if (!check.ok) {
      throw new ApiError(422, `Your bot did not pass the check: ${check.error}`, { botError: check.error, logs: check.logs });
    }
    const result = await this.db.saveTournamentEntry(tournament.id, user.id, code, MAX_PLAYERS);
    if (!result) throw new ApiError(409, `Entries are closed (the tournament started or has ${MAX_PLAYERS} players).`);
    this.emit('changed', tournament.id);
    return result;
  }

  async leave(user, id) {
    requireUser(user);
    const tournament = await this._get(id);
    if (!(await this.db.removeTournamentEntry(tournament.id, user.id))) {
      throw new ApiError(409, 'You can only leave a tournament you entered, before it starts.');
    }
    this.emit('changed', tournament.id);
  }

  async start(user, id) {
    requireUser(user);
    const tournament = await this._get(id);
    if (!tournament.organizer || tournament.organizer.id !== user.id) throw new ApiError(403, 'Only the organizer can start the tournament.');
    if (tournament.status !== 'registration') throw new ApiError(409, 'This tournament has already started.');
    const entrants = await this.db.tournamentEntrants(tournament.id);
    if (entrants.length < MIN_PLAYERS) throw new ApiError(409, `A tournament needs at least ${MIN_PLAYERS} players.`);
    const started = await this.db.startTournament(
      tournament.id,
      roundRobin(entrants.map((e) => e.id)),
    );
    if (!started) throw new ApiError(409, 'This tournament has already started.');
    this.emit('changed', tournament.id);
    this.advance(tournament.id);
  }

  /** Stops the tournament. Games already being played finish, but no new ones start. */
  async cancel(user, id) {
    requireUser(user);
    const tournament = await this._get(id);
    if (!tournament.organizer || tournament.organizer.id !== user.id) throw new ApiError(403, 'Only the organizer can cancel the tournament.');
    if (!(await this.db.endTournament(tournament.id, 'cancelled'))) throw new ApiError(409, 'This tournament is already over.');
    this.emit('changed', tournament.id);
  }

  /** Everything the tournament page shows. */
  async detail(id) {
    const tournament = await this._get(id);
    const [entrants, matches, games] = await Promise.all([
      this.db.tournamentEntrants(tournament.id),
      this.db.tournamentMatches(tournament.id),
      this.db.tournamentGames(tournament.id),
    ]);
    const n = tournament.gamesPerMatch;
    const gamesByMatch = new Map();
    for (const game of games) {
      if (!gamesByMatch.has(game.matchId)) gamesByMatch.set(game.matchId, []);
      gamesByMatch.get(game.matchId).push(game);
    }

    const rounds = [];
    let liveGames = 0;
    let queuedGames = 0;
    for (const m of matches) {
      if (!rounds[m.round - 1]) rounds[m.round - 1] = { round: m.round, matches: [] };
      const played = gamesByMatch.get(m.id) || [];
      const games = Array.from({ length: n }, (_, i) => {
        const number = i + 1;
        const game = played.find((g) => g.number === number);
        const liveId = game ? null : this.live.get(gameKey(m.id, number)) || null;
        // Started games either play now or wait for a free slot under MAX_RUNNING_MATCHES.
        const queued = Boolean(liveId) && this.arena.matches?.get(liveId)?.status === 'queued';
        if (liveId && queued) queuedGames++;
        else if (liveId) liveGames++;
        return {
          number,
          red: redIsA(number) ? 'a' : 'b',
          winner: game ? (game.winnerId === null ? 'draw' : game.winnerId === m.playerA ? 'a' : 'b') : null,
          reason: game ? game.reason : null,
          plies: game ? game.plies : null,
          gameId: game ? game.id : liveId,
          live: Boolean(liveId) && !queued,
          queued,
        };
      });
      rounds[m.round - 1].matches.push({
        id: m.id,
        a: { userId: m.playerA, username: m.aName },
        b: { userId: m.playerB, username: m.bName },
        aWins: m.aWins,
        bWins: m.bWins,
        draws: m.draws,
        gamesPlayed: m.gamesPlayed,
        status: m.gamesPlayed >= n ? 'finished' : m.gamesPlayed > 0 || games.some((g) => g.live || g.queued) ? 'playing' : 'pending',
        games,
      });
    }

    return {
      ...tournament,
      points: POINTS,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      entrants,
      standings: standings(entrants, matches, n),
      rounds: rounds.filter(Boolean),
      liveGames,
      queuedGames,
    };
  }

  /** Starts whatever games the tournament needs next. Calls never overlap per tournament. */
  advance(id) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous
      .then(() => this._advance(id))
      .catch((error) => console.error(`Tournament #${id}: could not advance:`, error));
    this.queues.set(id, next);
    return next;
  }

  async _advance(id) {
    const tournament = await this.db.getTournament(id);
    if (!tournament || tournament.status !== 'running') return;
    const n = tournament.gamesPerMatch;
    const matches = await this.db.tournamentMatches(id);
    const open = matches.filter((m) => m.gamesPlayed < n);

    if (!open.length) {
      const entrants = await this.db.tournamentEntrants(id);
      const table = standings(entrants, matches, n);
      await this.db.endTournament(id, 'finished', table[0] ? table[0].userId : null);
      this.emit('changed', id);
      return;
    }

    // Every game that isn't saved yet and isn't already being played starts now:
    // all matches, and all games of each match, at the same time.
    const saved = new Set((await this.db.tournamentGames(id)).map((g) => gameKey(g.matchId, g.number)));
    const toStart = [];
    for (const m of open) {
      for (let gameNumber = 1; gameNumber <= n; gameNumber++) {
        const key = gameKey(m.id, gameNumber);
        if (!saved.has(key) && !this.live.has(key)) toStart.push({ m, gameNumber, key });
      }
    }
    if (!toStart.length) return;

    const codes = await this.db.tournamentCodes(id);
    const users = await this.db.usersById([...new Set(toStart.flatMap(({ m }) => [m.playerA, m.playerB]))]);
    const seat = (userId) => ({ userId, name: users.get(userId).username, code: codes.get(userId) });
    for (const { m, gameNumber, key } of toStart) {
      const [redId, blueId] = redIsA(gameNumber) ? [m.playerA, m.playerB] : [m.playerB, m.playerA];
      const game = this.arena.startGame({
        name: `${tournament.name} · R${m.round} · G${gameNumber}/${n}`,
        players: [seat(redId), seat(blueId)],
        tournament: {
          id,
          name: tournament.name,
          round: m.round,
          matchId: m.id,
          gameNumber,
          gamesPerMatch: n,
          playerA: m.playerA,
        },
        onDone: (_game, ok) => {
          this.live.delete(key);
          this.emit('changed', id);
          // Checks whether the tournament is complete. If the result couldn't
          // be saved, the game is replayed after a pause.
          if (ok) this.advance(id);
          else setTimeout(() => this.advance(id), RETRY_MS).unref();
        },
      });
      this.live.set(key, game.id);
    }
    this.emit('changed', id);
  }
}

module.exports = { Tournaments, roundRobin, standings, redIsA, GAMES_PER_MATCH, POINTS, MIN_PLAYERS, MAX_PLAYERS };
