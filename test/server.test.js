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
const { Tournaments } = require('../server/src/tournaments');

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

const config = {
  ...baseConfig,
  moveDelayMs: 0,
  tournamentMoveDelayMs: 0,
  trustProxy: false, // whatever .env says; one test turns it on explicitly
  logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ottv2-test-')),
};
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
  const tournaments = new Tournaments({ db, arena });
  server = createServer({ arena, accounts: new Accounts(db, config), db, tournaments, config });
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
function dbTest(name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  test(name, options, async (t) => {
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
  assert.equal(created.body.user.games, 0);
  assert.equal(created.body.user.points, undefined);
  assert.equal(created.body.user.rating, undefined);
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

dbTest('behind Cloudflare: Secure cookies on HTTPS, throttling per visitor and username', async () => {
  // A second server with TRUST_PROXY on, as when it's reached through the tunnel.
  const proxied = createServer({
    arena: new Arena(config, { db }),
    accounts: new Accounts(db, config),
    db,
    config: { ...config, trustProxy: true },
  });
  await new Promise((resolve) => proxied.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxied.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const https = await post('/api/auth/register', { username: 'cf_https', password: 'password123' }, { 'x-forwarded-proto': 'https' });
    assert.match(https.headers.get('set-cookie'), /; Secure/);
    const plain = await post('/api/auth/register', { username: 'cf_plain', password: 'password123' });
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/, 'plain-HTTP visits (the LAN address) keep working');

    // Without TRUST_PROXY the same headers are ignored.
    const direct = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'cf_direct', password: 'password123' }),
    });
    assert.doesNotMatch(direct.headers.get('set-cookie'), /Secure/);

    // Ten wrong passwords for one account from one visitor block that pair only.
    const attempt = (username, ip, password = 'wrong-password') => post('/api/auth/login', { username, password }, { 'cf-connecting-ip': ip });
    for (let i = 0; i < 10; i++) assert.equal((await attempt('cf_https', '203.0.113.7')).status, 401);
    assert.equal((await attempt('cf_https', '203.0.113.7')).status, 429);
    assert.equal((await attempt('cf_https', '203.0.113.8')).status, 401, 'another visitor is not blocked');
    assert.equal((await attempt('cf_plain', '203.0.113.7', 'password123')).status, 200, 'another account from the same visitor works');
  } finally {
    proxied.closeAllConnections();
    proxied.close();
  }
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

  // There is no global ranking any more; standings live inside tournaments.
  assert.equal((await p1.api('GET', '/api/leaderboard')).status, 404);

  // Both players' profile records count the game.
  const winner = (await p2.api('GET', '/api/auth/me')).body.user;
  assert.deepEqual([winner.games, winner.wins, winner.losses], [1, 1, 0]);
  const profile = (await new Client().api('GET', '/api/users/PLAYER_TWO')).body;
  assert.equal(profile.user.username, 'player_two');
  assert.equal(profile.user.rank, undefined);
  assert.deepEqual(
    profile.matches.map((m) => [m.id, m.result, m.opponent.name, m.rated]),
    [[id, 'win', 'player_one', true]],
  );
  assert.equal((await new Client().api('GET', '/api/users/nobody_here')).status, 404);

  const log = await (await fetch(`${base}/api/matches/${id}/log`)).text();
  assert.match(log, /started: P1 player_one \(Red\) vs P2 player_two \(Blue\)/);
  assert.doesNotMatch(log, /Points:|Ratings:/);
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
  assert.equal(me.games, 0);
  const profile = (await eve.api('GET', '/api/users/eve')).body;
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

dbTest('tournament entry rules', async () => {
  const org = await Client.registered('t_org');
  const joe = await Client.registered('t_joe');
  const created = await org.api('POST', '/api/tournaments', { name: 'Rules Cup' });
  assert.equal(created.status, 201);
  const id = created.body.tournament.id;
  assert.equal(created.body.tournament.status, 'registration');

  assert.equal((await new Client().api('POST', `/api/tournaments/${id}/entry`, { code: random })).status, 401);
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/entry`, { code: 'nope(' })).status, 422);
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/entry`, { code: random })).body.result, 'joined');
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/entry`, { code: greedy })).body.result, 'updated');
  assert.equal((await org.api('POST', `/api/tournaments/${id}/start`, {})).status, 409, 'needs 2 players');
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/start`, {})).status, 403, 'only the organizer');
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/leave`, {})).status, 200);
  assert.equal((await org.api('GET', `/api/tournaments/${id}`)).body.entrants.length, 0);
  assert.equal((await org.api('POST', `/api/tournaments/${id}/cancel`, {})).status, 200);
  assert.equal((await joe.api('POST', `/api/tournaments/${id}/entry`, { code: random })).status, 409);
});

dbTest('two tournaments run side by side, each with its own standings', { timeout: 120000 }, async () => {
  const ann = await Client.registered('cup_ann');
  const bob = await Client.registered('cup_bob');
  const cy = await Client.registered('cup_cy');

  const cupA = (await ann.api('POST', '/api/tournaments', { name: 'Cup A' })).body.tournament.id;
  const cupB = (await bob.api('POST', '/api/tournaments', { name: 'Cup B' })).body.tournament.id;
  for (const [client, code] of [
    [ann, greedy],
    [bob, random],
    [cy, greedy],
  ]) {
    assert.equal((await client.api('POST', `/api/tournaments/${cupA}/entry`, { code })).status, 200);
  }
  await ann.api('POST', `/api/tournaments/${cupB}/entry`, { code: random });
  await bob.api('POST', `/api/tournaments/${cupB}/entry`, { code: greedy });

  assert.equal((await ann.api('POST', `/api/tournaments/${cupA}/start`, {})).status, 200);
  assert.equal((await bob.api('POST', `/api/tournaments/${cupB}/start`, {})).status, 200);
  assert.equal((await cy.api('POST', `/api/tournaments/${cupA}/entry`, { code: random })).status, 409, 'entries close at the start');

  const list = (await ann.api('GET', '/api/tournaments')).body.tournaments;
  assert.ok(list.filter((t) => t.id === cupA || t.id === cupB).every((t) => t.status === 'running'));

  const finished = async (id) => {
    for (let i = 0; i < 1100; i++) {
      const { body } = await ann.api('GET', `/api/tournaments/${id}`);
      if (body.status === 'finished') return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`tournament ${id} did not finish`);
  };
  const [a, b] = await Promise.all([finished(cupA), finished(cupB)]);

  // Cup A: 3 players → 3 rounds of one match (someone sits out each round), 4 games each.
  assert.equal(a.rounds.length, 3);
  const aMatches = a.rounds.flatMap((r) => r.matches);
  assert.equal(aMatches.length, 3);
  for (const m of aMatches) {
    assert.equal(m.gamesPlayed, 4);
    assert.equal(m.aWins + m.bWins + m.draws, 4);
    assert.deepEqual(
      m.games.map((g) => g.red),
      ['a', 'b', 'a', 'b'],
    );
  }
  assert.equal(a.standings.length, 3);
  assert.ok(a.standings.every((row) => row.mp === 2 && row.gd === row.gw - row.gl));
  const decisive = aMatches.filter((m) => m.aWins !== m.bWins).length;
  assert.equal(
    a.standings.reduce((sum, row) => sum + row.pts, 0),
    3 * decisive + 2 * (aMatches.length - decisive),
  );
  assert.equal(a.champion.username, a.standings[0].username);

  // Cup B is separate: 2 players, one match, its own table.
  assert.deepEqual(a.standings.map((r) => r.username).sort(), ['cup_ann', 'cup_bob', 'cup_cy']);
  assert.deepEqual(b.standings.map((r) => r.username).sort(), ['cup_ann', 'cup_bob']);
  assert.ok(b.standings.every((row) => row.mp === 1));
  assert.equal(b.rounds.flatMap((r) => r.matches).length, 1);

  // In the saved games, player A really was Red in games 1 and 3 and Blue in 2 and 4.
  const { rows } = await db.pool.query(
    `SELECT g.game_number, g.p1_user_id, m.player_a, m.player_b
       FROM matches g JOIN tournament_matches m ON m.id = g.tournament_match_id
      WHERE m.tournament_id = ANY($1::bigint[])`,
    [[cupA, cupB]],
  );
  assert.equal(rows.length, 16);
  for (const row of rows) {
    assert.equal(row.p1_user_id, row.game_number % 2 === 1 ? row.player_a : row.player_b);
  }
});

dbTest('profile records count wins, draws and losses against other players', async () => {
  const accounts = new Accounts(db, config);
  const [x, y] = await Promise.all(['rec_x', 'rec_y'].map((n) => accounts.create(n, 'password123')));
  let id = 900000;
  const play = (a, b, winner) =>
    db.recordMatch({
      id: id++,
      name: 'record',
      players: [
        { userId: a.id, name: a.username },
        { userId: b.id, name: b.username },
      ],
      winner,
      reason: winner === 0 ? 'turn-limit' : 'target',
      plies: 10,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
  assert.deepEqual(await play(x, y, 0), { rated: true });
  await play(x, y, 1);
  await play(y, x, 1);
  assert.deepEqual(await play(x, x, 1), { rated: false }, 'playing yourself is practice');
  const { user } = await db.profile('rec_x');
  assert.deepEqual([user.games, user.wins, user.draws, user.losses], [3, 1, 1, 1]);
});

dbTest('starting a tournament starts all of its games at once', async () => {
  const started = [];
  const fakeArena = {
    nextId: 800000,
    matches: new Map(),
    startGame(options) {
      const game = { id: this.nextId++, status: 'running' };
      this.matches.set(game.id, game);
      started.push(options);
      return game;
    },
  };
  const manager = new Tournaments({ db, arena: fakeArena });
  const accounts = new Accounts(db, config);
  const players = await Promise.all(['sim_a', 'sim_b', 'sim_c'].map((n) => accounts.create(n, 'password123')));
  const t = await manager.create(players[0], { name: 'All at once' });
  for (const p of players) await db.saveTournamentEntry(t.id, p.id, random, 16);
  await manager.start(players[0], t.id);
  await manager.advance(t.id);

  // 3 players → 3 matches × 4 games, all started together, colours alternating.
  assert.equal(started.length, 12);
  const byMatch = new Map();
  for (const game of started) {
    if (!byMatch.has(game.tournament.matchId)) byMatch.set(game.tournament.matchId, []);
    byMatch.get(game.tournament.matchId).push(game);
  }
  assert.equal(byMatch.size, 3);
  for (const games of byMatch.values()) {
    games.sort((g, h) => g.tournament.gameNumber - h.tournament.gameNumber);
    assert.deepEqual(
      games.map((g) => g.tournament.gameNumber),
      [1, 2, 3, 4],
    );
    const a = games[0].tournament.playerA;
    assert.deepEqual(
      games.map((g) => g.players[0].userId === a),
      [true, false, true, false],
    );
  }

  // Advancing again doesn't start anything twice, and the page shows 12 live games.
  await manager.advance(t.id);
  assert.equal(started.length, 12);
  const detail = await manager.detail(t.id);
  assert.equal(detail.liveGames, 12);
  assert.ok(detail.rounds.flatMap((r) => r.matches).every((m) => m.status === 'playing'));
  await manager.cancel(players[0], t.id);
});

dbTest('match numbers continue after a restart', async () => {
  const restarted = new Arena(config, { db });
  await restarted.init();
  const { rows } = await db.pool.query('SELECT max(id) AS max FROM matches');
  assert.ok(restarted.nextId > Number(rows[0].max));
});
