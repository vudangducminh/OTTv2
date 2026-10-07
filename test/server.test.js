// End-to-end: starts the real HTTP server on a free port and drives it like the client does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const baseConfig = require('../server/src/config');
const { Arena } = require('../server/src/arena');
const { createServer } = require('../server/src/http');

const examples = path.join(__dirname, '..', 'library', 'examples');
const greedy = fs.readFileSync(path.join(examples, 'greedy.js'), 'utf8');
const random = fs.readFileSync(path.join(examples, 'random.js'), 'utf8');

let server;
let arena;
let base;

test.before(async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottv2-test-'));
  const config = { ...baseConfig, moveDelayMs: 0, logDir };
  arena = new Arena(config);
  server = createServer(arena, config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

async function api(method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
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

test('serves the client and the library', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /OTTv2/);
  const lib = await fetch(base + '/library/ottv2.js');
  assert.equal(lib.status, 200);
  const escape = await fetch(base + '/library/..%2Fpackage.json');
  assert.equal(escape.status, 404);
});

test('lists the example bots', async () => {
  const { body } = await api('GET', '/api/examples');
  assert.deepEqual(
    body.map((e) => e.id),
    ['random', 'greedy', 'lookahead'],
  );
  assert.ok(body.every((e) => e.code.includes('function move')));
});

test('rejects broken bots with a readable error', async () => {
  const { status, body } = await api('POST', '/api/matches', { name: 'Broken', player: 'Ann', code: 'function move(g) { return g.oops.x }' });
  assert.equal(status, 422);
  assert.match(body.error, /TypeError/);
  assert.match(body.error, /line 1/);

  const check = await api('POST', '/api/check', { code: greedy, seat: 2 });
  assert.equal(check.body.ok, true);
});

test('two submissions start a match that streams to spectators and ends with a result', async () => {
  const created = await api('POST', '/api/matches', { name: 'Test match', player: 'Ann', code: greedy });
  assert.equal(created.status, 201);
  assert.equal(created.body.seat, 1);
  const id = created.body.match.id;
  assert.equal(created.body.match.status, 'waiting');

  const lobby = await api('GET', '/api/matches');
  assert.ok(lobby.body.some((m) => m.id === id && m.status === 'waiting'));

  const spectator = stream(`?match=${id}`, (events) =>
    events.some((e) => e.event === 'update' && e.data.status === 'finished'),
  );

  const joined = await api('POST', `/api/matches/${id}/join`, { player: 'Bob', code: random });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.seat, 2);

  const again = await api('POST', `/api/matches/${id}/join`, { player: 'Cy', code: random });
  assert.equal(again.status, 409);

  const events = await spectator;
  assert.equal(events[0].event, 'snapshot');
  const moves = events.filter((e) => e.event === 'move');
  assert.ok(moves.length > 0);
  assert.deepEqual(
    moves.map((e) => e.data.record.ply),
    moves.map((_, i) => i + 1),
  );

  const final = await api('GET', `/api/matches/${id}`);
  assert.equal(final.body.status, 'finished');
  assert.ok([0, 1, 2].includes(final.body.result.winner));
  assert.equal(final.body.moves.length, moves.length);
  assert.equal(final.body.initial.length, 36);

  const log = await fetch(`${base}/api/matches/${id}/log`);
  const text = await log.text();
  assert.match(text, /started: P1 Ann \(Red\) vs P2 Bob \(Blue\)/);
  assert.match(text, /Game over/);
});

test('a house bot fills the second seat right away', async () => {
  const created = await api('POST', '/api/matches', { name: 'Practice', player: 'Ann', code: random, opponent: 'greedy' });
  assert.equal(created.status, 201);
  const { players } = created.body.match;
  assert.equal(players[1].house, 'greedy');
});

test('only a seated player can cancel a waiting match', async () => {
  const created = await api('POST', '/api/matches', { name: 'Lonely', player: 'Ann', code: random });
  const id = created.body.match.id;
  const denied = await api('POST', `/api/matches/${id}/cancel`, { secret: 'nope' });
  assert.equal(denied.status, 403);
  const ok = await api('POST', `/api/matches/${id}/cancel`, { secret: created.body.secret });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.match.status, 'cancelled');
});

test('a bot that crashes mid-game forfeits', async () => {
  // Passes the submission check (first move) and then throws.
  const flaky = `let turns = 0;
function move(game) {
  turns++;
  if (turns > 2) throw new Error('boom');
  return game.legalMoves()[0];
}`;
  const created = await api('POST', '/api/matches', { name: 'Flaky', player: 'Ann', code: flaky, opponent: 'random' });
  const id = created.body.match.id;
  let match;
  for (let i = 0; i < 100; i++) {
    match = (await api('GET', `/api/matches/${id}`)).body;
    if (match.status === 'finished') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(match.status, 'finished');
  assert.equal(match.result.reason, 'forfeit');
  assert.equal(match.result.winner, 2);
  assert.match(match.result.message, /boom/);
});
