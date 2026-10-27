// The game clock: each bot gets a total amount of thinking time per game.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseConfig = require('../server/src/config');
const { Match } = require('../server/src/match');

const random = fs.readFileSync(path.join(__dirname, '..', 'library', 'examples', 'random.js'), 'utf8');

// Thinks for 1.2 s on every move.
const slow = `function move(game) {
  const until = Date.now() + 1200;
  while (Date.now() < until) {}
  return game.legalMoves()[0];
}`;

test('a move may take longer than a second; the bot forfeits only when its game clock runs out', { timeout: 30000 }, async () => {
  // A 3-second clock: two 1.2 s moves fit, the third doesn't.
  const config = { ...baseConfig, moveDelayMs: 0, logDir: null, gameTimeLimitMs: 3000 };
  const match = new Match({ id: 1, name: 'clock', config });
  match.sit(1, { name: 'slow', code: slow });
  match.sit(2, { name: 'fast', code: random });
  await match.run();

  const slowMoves = match.moveTimes.filter((_, i) => i % 2 === 0);
  assert.equal(slowMoves.length, 2, 'both 1.2 s moves were accepted');
  assert.ok(slowMoves.every((ms) => ms >= 1100));

  assert.equal(match.result.reason, 'forfeit');
  assert.equal(match.result.winner, 2);
  assert.match(match.result.message, /ran out of time \(0:03 for the game\)/);

  const { clocks } = match.summary();
  assert.equal(clocks[1], 0);
  assert.ok(clocks[2] > 2500, 'the fast bot barely used its clock');
});

test('the default clock is 5 minutes per bot per game', () => {
  assert.equal(baseConfig.gameTimeLimitMs, 5 * 60 * 1000);
});
