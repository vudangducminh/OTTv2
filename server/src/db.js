const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { rate } = require('./ratings');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The user fields that are safe to send to any browser. */
function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    rating: row.rating,
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
    ratingBefore: row[`p${seat}_rating_before`],
    ratingAfter: row[`p${seat}_rating_after`],
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

  // ---------- Matches and ratings ----------

  /** Match numbers continue from the last saved match. */
  async nextMatchId() {
    const { rows } = await this.pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM matches');
    return Number(rows[0].next);
  }

  /**
   * Saves a finished match and, when it is rated, updates both players'
   * ratings and records in the same transaction. A match is rated when two
   * different registered players play it to a result.
   *
   * match: { id, name, players: [{ userId, name }, { userId, name }], winner, reason, plies, startedAt, finishedAt }
   * Returns { rated, ratings: { 1: { before, after }, 2: { before, after } } | null }.
   */
  async recordMatch(match) {
    const [p1, p2] = match.players;
    if (!p1.userId && !p2.userId) return { rated: false, ratings: null };
    const decided = match.winner === 0 || match.winner === 1 || match.winner === 2;
    const wantsRating = Boolean(p1.userId && p2.userId && p1.userId !== p2.userId && decided && match.reason !== 'error');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let before = null;
      let after = null;
      if (wantsRating) {
        // Lock both rows (in id order, so two concurrent results can't deadlock).
        const { rows } = await client.query('SELECT id, rating FROM users WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [
          [p1.userId, p2.userId],
        ]);
        const current = new Map(rows.map((row) => [Number(row.id), row.rating]));
        if (current.size === 2) {
          before = [current.get(p1.userId), current.get(p2.userId)];
          after = rate(before[0], before[1], match.winner === 1 ? 1 : match.winner === 2 ? 0 : 0.5);
          for (const [index, player] of [p1, p2].entries()) {
            const seat = index + 1;
            const draw = match.winner === 0;
            const win = match.winner === seat;
            await client.query(
              `UPDATE users
                  SET rating = $2, games = games + 1, wins = wins + $3, losses = losses + $4, draws = draws + $5
                WHERE id = $1`,
              [player.userId, after[index], win ? 1 : 0, !win && !draw ? 1 : 0, draw ? 1 : 0],
            );
          }
        }
      }
      await client.query(
        `INSERT INTO matches (id, name, p1_user_id, p2_user_id, p1_name, p2_name, winner, reason, plies, rated,
                              p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, to_timestamp($15 / 1000.0), to_timestamp($16 / 1000.0))`,
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
          Boolean(after),
          before ? before[0] : null,
          after ? after[0] : null,
          before ? before[1] : null,
          after ? after[1] : null,
          match.startedAt,
          match.finishedAt,
        ],
      );
      await client.query('COMMIT');
      return {
        rated: Boolean(after),
        ratings: after ? { 1: { before: before[0], after: after[0] }, 2: { before: before[1], after: after[1] } } : null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Players with at least one rated game, best first. Equal ratings share a rank. */
  async leaderboard(limit = 100) {
    const { rows } = await this.pool.query(
      `SELECT *, RANK() OVER (ORDER BY rating DESC) AS rank
         FROM users
        WHERE games > 0
        ORDER BY rating DESC, wins DESC, lower(username)
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({ ...publicUser(row), rank: Number(row.rank) }));
  }

  /** { user (with rank and ranked), matches } or null. */
  async profile(username, recent = 20) {
    const { rows } = await this.pool.query(
      `SELECT u.*,
              (SELECT count(*) + 1 FROM users o WHERE o.games > 0 AND o.rating > u.rating) AS rank,
              (SELECT count(*) FROM users o WHERE o.games > 0) AS ranked
         FROM users u
        WHERE lower(u.username) = lower($1)`,
      [username],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const user = { ...publicUser(row), rank: row.games > 0 ? Number(row.rank) : null, ranked: Number(row.ranked) };
    const history = await this.pool.query(
      `SELECT * FROM matches
        WHERE p1_user_id = $1 OR p2_user_id = $1
        ORDER BY finished_at DESC
        LIMIT $2`,
      [user.id, recent],
    );
    return { user, matches: history.rows.map((m) => matchForUser(m, user.id)) };
  }
}

module.exports = { Database, describeUrl };
