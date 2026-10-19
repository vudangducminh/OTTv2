const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The user fields that are safe to send to any browser. */
function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    createdAt: row.created_at.getTime(),
  };
}

/** A stored match from the point of view of `userId`. */
function matchForUser(row, userId) {
  const seat = Number(row.p1_user_id) === userId ? 1 : 2;
  const other = seat === 1 ? 2 : 1;
  const result = row.winner === 0 ? 'draw' : row.winner === seat ? 'win' : row.winner === other ? 'loss' : null;
  return {
    id: Number(row.id),
    name: row.name,
    seat,
    opponent: {
      name: row[`p${other}_name`],
      registered: row[`p${other}_user_id`] !== null,
    },
    result,
    reason: row.reason,
    plies: row.plies,
    rated: row.rated,
    finishedAt: row.finished_at.getTime(),
  };
}

/** Hides the password in a connection string for log messages. */
function describeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(invalid DATABASE_URL)';
  }
}

class Database {
  /**
   * `schema` puts every table in a separate PostgreSQL schema; the tests use
   * it so they never touch real data.
   */
  constructor(connectionString, { schema = null } = {}) {
    if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    this.url = connectionString;
    this.schema = schema;
    this.pool = new Pool({
      connectionString,
      max: 10,
      options: schema ? `-c search_path=${schema}` : undefined,
    });
    this.pool.on('error', (error) => console.error('PostgreSQL connection error:', error.message));
  }

  /** Waits for PostgreSQL to accept connections (it may still be starting). */
  async connect({ attempts = 10, delayMs = 1000 } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        return;
      } catch (error) {
        if (attempt >= attempts) {
          throw new Error(`Could not connect to PostgreSQL at ${describeUrl(this.url)}: ${error.message}`);
        }
        await sleep(delayMs);
      }
    }
  }

  async migrate() {
    if (this.schema) await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool.query(SCHEMA);
  }

  /** Drops every table (only allowed in a separate schema, i.e. in tests). */
  async reset() {
    if (!this.schema) throw new Error('reset() is only allowed with a separate schema');
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    await this.migrate();
  }

  async healthy() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close() {
    return this.pool.end();
  }

  // ---------- Users ----------

  /** Returns the new user, or null when the username is taken. */
  async createUser(username, passwordHash) {
    try {
      const { rows } = await this.pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *', [
        username,
        passwordHash,
      ]);
      return publicUser(rows[0]);
    } catch (error) {
      if (error.code === '23505') return null;
      throw error;
    }
  }

  /** { user, passwordHash } or null. */
  async findLogin(username) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    return rows[0] ? { user: publicUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async setPassword(userId, passwordHash) {
    await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  }

  // ---------- Sessions ----------

  async createSession(userId, tokenHash, expiresAt) {
    await this.pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
    await this.pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  }

  async userForSession(tokenHash) {
    const { rows } = await this.pool.query(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
      [tokenHash],
    );
    return rows[0] ? publicUser(rows[0]) : null;
  }

  async deleteSession(tokenHash) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteUserSessions(userId) {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async deleteExpiredSessions() {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
  }

  // ---------- Games ----------

  /** Match numbers continue from the last saved match. */
  async nextMatchId() {
    const { rows } = await this.pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM matches');
    return Number(rows[0].next);
  }

  /**
   * Saves a finished game. When two different registered players played it to
   * a result, both players' win/draw/loss records are updated in the same
   * transaction (games against house bots or yourself are practice).
   *
   * match: { id, name, players: [{ userId, name }, { userId, name }], winner, reason, plies, startedAt, finishedAt,
   *          tournament?: { matchId, gameNumber, playerA, gamesPerMatch } }
   * A tournament game also adds its result to its tournament match, in the same transaction.
   * Returns { rated }: whether it counted toward the players' records.
   */
  async recordMatch(match) {
    const [p1, p2] = match.players;
    if (!p1.userId && !p2.userId) return { rated: false };
    const decided = match.winner === 0 || match.winner === 1 || match.winner === 2;
    const counts = Boolean(p1.userId && p2.userId && p1.userId !== p2.userId && decided && match.reason !== 'error');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let rated = false;
      if (counts) {
        // Lock both rows in id order, so two results for the same players at once can't deadlock.
        const { rows } = await client.query('SELECT id FROM users WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [
          [p1.userId, p2.userId],
        ]);
        if (rows.length === 2) {
          rated = true;
          for (const [index, player] of [p1, p2].entries()) {
            const seat = index + 1;
            const result = match.winner === 0 ? 'draw' : match.winner === seat ? 'win' : 'loss';
            await client.query(
              'UPDATE users SET games = games + 1, wins = wins + $2, losses = losses + $3, draws = draws + $4 WHERE id = $1',
              [player.userId, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, result === 'draw' ? 1 : 0],
            );
          }
        }
      }
      const tournament = match.tournament || null;
      if (tournament) {
        // Credit the game to the tournament match it belongs to.
        const winnerId = match.winner === 1 ? p1.userId : match.winner === 2 ? p2.userId : null;
        const aWon = winnerId !== null && winnerId === tournament.playerA;
        const bWon = winnerId !== null && !aWon;
        await client.query(
          `UPDATE tournament_matches
              SET a_wins = a_wins + $2, b_wins = b_wins + $3, draws = draws + $4, games_played = games_played + 1,
                  finished_at = CASE WHEN games_played + 1 >= $5 THEN now() ELSE finished_at END
            WHERE id = $1`,
          [tournament.matchId, aWon ? 1 : 0, bWon ? 1 : 0, winnerId === null ? 1 : 0, tournament.gamesPerMatch],
        );
      }
      await client.query(
        `INSERT INTO matches (id, name, p1_user_id, p2_user_id, p1_name, p2_name, winner, reason, plies, rated,
                              started_at, finished_at, tournament_match_id, game_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0), $13, $14)`,
        [
          match.id,
          match.name,
          p1.userId || null,
          p2.userId || null,
          p1.name,
          p2.name,
          decided ? match.winner : null,
          match.reason || 'error',
          match.plies,
          rated,
          match.startedAt,
          match.finishedAt,
          tournament ? tournament.matchId : null,
          tournament ? tournament.gameNumber : null,
        ],
      );
      await client.query('COMMIT');
      return { rated };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** { user, matches } or null. */
  async profile(username, recent = 20) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    if (!rows[0]) return null;
    const user = publicUser(rows[0]);
    const history = await this.pool.query(
      `SELECT * FROM matches
        WHERE p1_user_id = $1 OR p2_user_id = $1
        ORDER BY finished_at DESC
        LIMIT $2`,
      [user.id, recent],
    );
    return { user, matches: history.rows.map((m) => matchForUser(m, user.id)) };
  }

  // ---------- Tournaments ----------

  async createTournament(name, organizerId, gamesPerMatch) {
    const { rows } = await this.pool.query(
      'INSERT INTO tournaments (name, organizer_id, games_per_match) VALUES ($1, $2, $3) RETURNING id',
      [name, organizerId, gamesPerMatch],
    );
    return Number(rows[0].id);
  }

  /** Tournaments with entrant counts and progress, running first. */
  async listTournaments(limit = 50) {
    const { rows } = await this.pool.query(
      `${TOURNAMENT_SELECT}
       ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'registration' THEN 1 ELSE 2 END, t.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map(tournamentRow);
  }

  async getTournament(id) {
    const { rows } = await this.pool.query(`${TOURNAMENT_SELECT} WHERE t.id = $1`, [id]);
    return rows[0] ? tournamentRow(rows[0]) : null;
  }

  async openTournamentsBy(userId) {
    const { rows } = await this.pool.query(
      "SELECT count(*) AS n FROM tournaments WHERE organizer_id = $1 AND status IN ('registration', 'running')",
      [userId],
    );
    return Number(rows[0].n);
  }

  async runningTournamentIds() {
    const { rows } = await this.pool.query("SELECT id FROM tournaments WHERE status = 'running' ORDER BY id");
    return rows.map((row) => Number(row.id));
  }

  /** Entrants (without their code), in the order they entered. */
  async tournamentEntrants(id) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, p.joined_at, p.updated_at
         FROM tournament_players p JOIN users u ON u.id = p.user_id
        WHERE p.tournament_id = $1
        ORDER BY p.joined_at`,
      [id],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      username: row.username,
      joinedAt: row.joined_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    }));
  }

  /** Map of user id → bot code, for starting games. */
  async tournamentCodes(id) {
    const { rows } = await this.pool.query('SELECT user_id, code FROM tournament_players WHERE tournament_id = $1', [id]);
    return new Map(rows.map((row) => [Number(row.user_id), row.code]));
  }

  /**
   * Enters `userId` with `code`, or replaces their code if already entered.
   * Only while the tournament is open for registration and not full.
   * Returns 'joined', 'updated', or null when that isn't allowed.
   */
  async saveTournamentEntry(id, userId, code, maxPlayers) {
    const { rows } = await this.pool.query(
      `INSERT INTO tournament_players (tournament_id, user_id, code)
       SELECT $1, $2, $3
        WHERE EXISTS (SELECT 1 FROM tournaments WHERE id = $1 AND status = 'registration')
          AND ((SELECT count(*) FROM tournament_players WHERE tournament_id = $1) < $4
               OR EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND user_id = $2))
       ON CONFLICT (tournament_id, user_id) DO UPDATE SET code = EXCLUDED.code, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [id, userId, code, maxPlayers],
    );
    if (!rows[0]) return null;
    return rows[0].inserted ? 'joined' : 'updated';
  }

  async removeTournamentEntry(id, userId) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM tournament_players
        WHERE tournament_id = $1 AND user_id = $2
          AND EXISTS (SELECT 1 FROM tournaments WHERE id = $1 AND status = 'registration')`,
      [id, userId],
    );
    return rowCount > 0;
  }

  /** Saves the schedule and opens play. `pairings`: [{ round, playerA, playerB }]. False if it already started. */
  async startTournament(id, pairings) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT status FROM tournaments WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0] || rows[0].status !== 'registration') {
        await client.query('ROLLBACK');
        return false;
      }
      for (const p of pairings) {
        await client.query('INSERT INTO tournament_matches (tournament_id, round, player_a, player_b) VALUES ($1, $2, $3, $4)', [
          id,
          p.round,
          p.playerA,
          p.playerB,
        ]);
      }
      await client.query("UPDATE tournaments SET status = 'running', started_at = now() WHERE id = $1", [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Moves a tournament to 'finished' or 'cancelled'. False if it was already over. */
  async endTournament(id, status, championId = null) {
    const { rowCount } = await this.pool.query(
      `UPDATE tournaments SET status = $2, champion_id = $3, finished_at = now()
        WHERE id = $1 AND status IN ('registration', 'running')`,
      [id, status, championId],
    );
    return rowCount > 0;
  }

  async tournamentMatches(id) {
    const { rows } = await this.pool.query(
      `SELECT m.*, ua.username AS a_name, ub.username AS b_name
         FROM tournament_matches m
         JOIN users ua ON ua.id = m.player_a
         JOIN users ub ON ub.id = m.player_b
        WHERE m.tournament_id = $1
        ORDER BY m.round, m.id`,
      [id],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      round: row.round,
      playerA: Number(row.player_a),
      playerB: Number(row.player_b),
      aName: row.a_name,
      bName: row.b_name,
      aWins: row.a_wins,
      bWins: row.b_wins,
      draws: row.draws,
      gamesPlayed: row.games_played,
      finishedAt: row.finished_at ? row.finished_at.getTime() : null,
    }));
  }

  /** Every saved game of a tournament. */
  async tournamentGames(id) {
    const { rows } = await this.pool.query(
      `SELECT g.id, g.tournament_match_id, g.game_number, g.winner, g.p1_user_id, g.p2_user_id, g.reason, g.plies
         FROM matches g JOIN tournament_matches m ON m.id = g.tournament_match_id
        WHERE m.tournament_id = $1
        ORDER BY g.tournament_match_id, g.game_number`,
      [id],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      matchId: Number(row.tournament_match_id),
      number: row.game_number,
      winnerId: row.winner === 1 ? Number(row.p1_user_id) : row.winner === 2 ? Number(row.p2_user_id) : null,
      redId: Number(row.p1_user_id),
      reason: row.reason,
      plies: row.plies,
    }));
  }

  async usersById(ids) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = ANY($1::bigint[])', [ids]);
    return new Map(rows.map((row) => [Number(row.id), publicUser(row)]));
  }
}

const TOURNAMENT_SELECT = `
  SELECT t.*, o.username AS organizer_name, c.username AS champion_name,
         (SELECT count(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS entrants,
         (SELECT count(*) FROM tournament_matches m WHERE m.tournament_id = t.id) AS total_matches,
         (SELECT count(*) FROM tournament_matches m WHERE m.tournament_id = t.id AND m.games_played >= t.games_per_match) AS finished_matches,
         (SELECT max(round) FROM tournament_matches m WHERE m.tournament_id = t.id) AS total_rounds
    FROM tournaments t
    LEFT JOIN users o ON o.id = t.organizer_id
    LEFT JOIN users c ON c.id = t.champion_id`;

function tournamentRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    status: row.status,
    gamesPerMatch: row.games_per_match,
    organizer: row.organizer_id ? { id: Number(row.organizer_id), username: row.organizer_name } : null,
    champion: row.champion_id ? { id: Number(row.champion_id), username: row.champion_name } : null,
    entrants: Number(row.entrants),
    totalMatches: Number(row.total_matches),
    finishedMatches: Number(row.finished_matches),
    totalRounds: row.total_rounds === null ? 0 : Number(row.total_rounds),
    createdAt: row.created_at.getTime(),
    startedAt: row.started_at ? row.started_at.getTime() : null,
    finishedAt: row.finished_at ? row.finished_at.getTime() : null,
  };
}

module.exports = { Database, describeUrl };
