// End-to-end: starts the real HTTP server against PostgreSQL and drives it like the client does.
// Uses its own schema (ottv2_test) in the database from DATABASE_URL, so real data is never touched.
// Start the database first:  docker compose up -d db
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/src/config');
const { Accounts } = require('../server/src/accounts');
const { Arena } = require('../server/src/arena');
const { Database } = require('../server/src/db');
const { createServer } = require('../server/src/http');

const examples = path.join(__dirname, '..', 'library', 'examples');
const greedy = fs.readFileSync(path.join(examples, 'greedy.js'), 'utf8');
const random = fs.readFileSync(path.join(examples, 'random.js'), 'utf8');

// Passes the submission check (one move), then forfeits on its third move.
const flaky = `let turns = 0;
function move(game) {
  turns++;
  if (turns > 2) throw new Error('boom');
  return game.legalMoves()[0];
}`;

const config = { ...baseConfig, moveDelayMs: 0, logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ottv2-test-')) };
let db;
let server;
let base;
let skipReason = null;

test.before(async () => {
  db = new Database(process.env.TEST_DATABASE_URL || config.databaseUrl, { schema: 'ottv2_test' });
  try {
    await db.connect({ attempts: 2, delayMs: 300 });
  } catch (error) {
    skipReason = `PostgreSQL is not reachable (${error.message}). Start it with: docker compose up -d db`;
    return;
  }
  await db.reset();
  const arena = new Arena(config, { db });
  await arena.init();
  server = createServer({ arena, accounts: new Accounts(db, config), db, config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
  if (db) {
    if (!skipReason) await db.pool.query('DROP SCHEMA IF EXISTS ottv2_test CASCADE');
    await db.close();
  }
});

/** Tests that need the database are skipped (with the reason) when it isn't running. */
function dbTest(name, fn) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    await fn(t);
  });
}

/** A browser stand-in that keeps its login cookie. */
class Client {
  constructor() {
    this.cookie = null;
  }

  async api(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  static async registered(username, password = 'password123') {
    const client = new Client();
    const { status } = await client.api('POST', '/api/auth/register', { username, password });
    assert.equal(status, 201, `register ${username}`);
    return client;
  }
}

async function waitForEnd(client, id) {
  for (let i = 0; i < 200; i++) {
    const { body } = await client.api('GET', `/api/matches/${id}`);
    if (body.status === 'finished' || body.status === 'cancelled') return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`match ${id} did not finish`);
}

// Collects SSE events from /api/stream until `until` returns true.
function stream(query, until) {
  return new Promise((resolve, reject) => {
    const events = [];
    const request = http.get(`${base}/api/stream${query}`, (response) => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
        }
        if (until(events)) {
          request.destroy();
          resolve(events);
        }
      });
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? null : reject(error)));
  });
}

dbTest('serves the client, the library and a health check', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OTTv2/);
  assert.equal((await fetch(base + '/library/ottv2.js')).status, 200);
  assert.equal((await fetch(base + '/library/..%2Fpackage.json')).status, 404);
  const health = await new Client().api('GET', '/api/health');
  assert.deepEqual(health.body, { ok: true, database: true });
});

dbTest('lists the example bots', async () => {
  const { body } = await new Client().api('GET', '/api/examples');
  assert.deepEqual(
    body.map((e) => e.id),
    ['random', 'greedy', 'lookahead'],
  );
});

dbTest('register, log in, log out', async () => {
  const ann = new Client();
  const created = await ann.api('POST', '/api/auth/register', { username: 'ann', password: 'correct-horse' });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, 'ann');
  assert.equal(created.body.user.rating, 1000);
  assert.equal(created.body.user.password_hash, undefined);
  assert.match(created.headers.get('set-cookie'), /HttpOnly/);
  assert.match(created.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await ann.api('GET', '/api/auth/me')).body.user.username, 'ann');

  const other = new Client();
  assert.equal((await other.api('POST', '/api/auth/register', { username: 'ANN', password: 'something-else' })).status, 409);
  assert.equal((await other.api('POST', '/api/auth/register', { username: 'a', password: 'something-else' })).status, 400);
  assert.equal((await other.api('POST', '/api/auth/register', { username: 'bobby', password: 'short' })).status, 400);

  await ann.api('POST', '/api/auth/logout', {});
  assert.equal((await ann.api('GET', '/api/auth/me')).body.user, null);

  const wrong = await ann.api('POST', '/api/auth/login', { username: 'ann', password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Wrong username or password.');
  const right = await ann.api('POST', '/api/auth/login', { username: 'Ann', password: 'correct-horse' });
  assert.equal(right.status, 200);
  assert.equal((await ann.api('GET', '/api/auth/me')).body.user.username, 'ann');
});

dbTest('submitting a bot needs a login and a JSON body', async () => {
  const anonymous = new Client();
  assert.equal((await anonymous.api('POST', '/api/matches', { code: greedy })).status, 401);
  assert.equal((await anonymous.api('POST', '/api/check', { code: greedy })).status, 401);

  // A plain form post from another site can't create a match, even with the cookie.
  const cid = await Client.registered('cid');
  const form = await fetch(base + '/api/matches', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cid.cookie },
    body: 'code=x',
  });
  assert.equal(form.status, 415);
});

dbTest('rejects broken bots with a readable error', async () => {
  const dee = await Client.registered('dee');
  const { status, body } = await dee.api('POST', '/api/matches', { name: 'Broken', code: 'function move(g) { return g.oops.x }' });
  assert.equal(status, 422);
  assert.match(body.error, /TypeError/);
  assert.match(body.error, /line 1/);
  assert.equal((await dee.api('POST', '/api/check', { code: greedy, seat: 2 })).body.ok, true);
});

dbTest('two players: usernames on the seats, live stream, rated result, ranking and profiles', async () => {
  const p1 = await Client.registered('player_one');
  const p2 = await Client.registered('player_two');

  // The name in the body is ignored: seats always show the account's username.
  const created = await p1.api('POST', '/api/matches', { name: 'Rated test', player: 'Mallory', code: flaky });
  assert.equal(created.status, 201);
  const id = created.body.match.id;
  assert.equal(created.body.match.players[0].name, 'player_one');
  assert.equal(created.body.match.players[0].rating, 1000);

  const spectator = stream(`?match=${id}`, (events) => events.some((e) => e.event === 'update' && e.data.status === 'finished'));

  const joined = await p2.api('POST', `/api/matches/${id}/join`, { player: 'Mallory', code: random });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.seat, 2);
  assert.equal(joined.body.match.players[1].name, 'player_two');
  assert.equal((await p2.api('POST', `/api/matches/${id}/join`, { code: random })).status, 409);

  const events = await spectator;
  assert.equal(events[0].event, 'snapshot');
  const moves = events.filter((e) => e.event === 'move');
  assert.deepEqual(
    moves.map((e) => e.data.record.ply),
    moves.map((_, i) => i + 1),
  );

  const final = await waitForEnd(p1, id);
  assert.equal(final.result.reason, 'forfeit');
  assert.equal(final.result.winner, 2);
  assert.match(final.result.message, /boom/);
  assert.equal(final.result.rated, true);
  assert.deepEqual(final.result.ratings, { 1: { before: 1000, after: 984 }, 2: { before: 1000, after: 1016 } });

  assert.equal((await p1.api('GET', '/api/auth/me')).body.user.rating, 984);
  const board = (await p1.api('GET', '/api/leaderboard')).body.players;
  assert.deepEqual(
    board.map((p) => [p.rank, p.username, p.rating, p.wins, p.losses]),
    [
      [1, 'player_two', 1016, 1, 0],
      [2, 'player_one', 984, 0, 1],
    ],
  );

  const profile = (await new Client().api('GET', '/api/users/PLAYER_TWO')).body;
  assert.equal(profile.user.username, 'player_two');
  assert.equal(profile.user.rank, 1);
  assert.deepEqual(
    profile.matches.map((m) => [m.id, m.result, m.opponent.name, m.rated, m.ratingBefore, m.ratingAfter]),
    [[id, 'win', 'player_one', true, 1000, 1016]],
  );
  assert.equal((await new Client().api('GET', '/api/users/nobody_here')).status, 404);

  const log = await (await fetch(`${base}/api/matches/${id}/log`)).text();
  assert.match(log, /started: P1 player_one \(Red\) vs P2 player_two \(Blue\)/);
  assert.match(log, /Ratings: player_one 1000 → 984 \(-16\), player_two 1000 → 1016 \(\+16\)/);
});

dbTest('games against a house bot are saved but not rated', async () => {
  const eve = await Client.registered('eve');
  const created = await eve.api('POST', '/api/matches', { code: flaky, opponent: 'random' });
  assert.equal(created.status, 201);
  assert.equal(created.body.match.name, "eve's match");
  assert.equal(created.body.match.players[1].house, 'random');

  const final = await waitForEnd(eve, created.body.match.id);
  assert.equal(final.result.rated, false);
  const me = (await eve.api('GET', '/api/auth/me')).body.user;
  assert.equal(me.rating, 1000);
  assert.equal(me.games, 0);
  const profile = (await eve.api('GET', '/api/users/eve')).body;
  assert.equal(profile.user.rank, null);
  assert.deepEqual(
    profile.matches.map((m) => [m.result, m.rated, m.opponent.registered]),
    [['loss', false, false]],
  );
});

dbTest('only a seated player can cancel a waiting match', async () => {
  const fay = await Client.registered('fay');
  const gus = await Client.registered('gus');
  const created = await fay.api('POST', '/api/matches', { name: 'Lonely', code: random });
  const id = created.body.match.id;
  assert.equal((await new Client().api('POST', `/api/matches/${id}/cancel`, {})).status, 401);
  assert.equal((await gus.api('POST', `/api/matches/${id}/cancel`, {})).status, 403);
  const ok = await fay.api('POST', `/api/matches/${id}/cancel`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.match.status, 'cancelled');
});

dbTest('match numbers continue after a restart', async () => {
  const restarted = new Arena(config, { db });
  await restarted.init();
  const { rows } = await db.pool.query('SELECT max(id) AS max FROM matches');
  assert.ok(restarted.nextId > Number(rows[0].max));
});
