const test = require('node:test');
const assert = require('node:assert/strict');
const { rate, expectedScore, STARTING_RATING } = require('../server/src/ratings');

test('equal players trade 16 points', () => {
  assert.deepEqual(rate(STARTING_RATING, STARTING_RATING, 1), [1016, 984]);
  assert.deepEqual(rate(STARTING_RATING, STARTING_RATING, 0), [984, 1016]);
  assert.deepEqual(rate(STARTING_RATING, STARTING_RATING, 0.5), [1000, 1000]);
});

test('beating a stronger player is worth more than beating a weaker one', () => {
  const [upset] = rate(1000, 1400, 1);
  const [expected] = rate(1400, 1000, 1);
  assert.ok(upset - 1000 > expected - 1400);
  assert.equal(upset - 1000, 29);
  assert.equal(expected - 1400, 3);
});

test('rating changes are zero-sum', () => {
  for (const [a, b] of [
    [1000, 1000],
    [1234, 987],
    [1500, 900],
  ]) {
    for (const score of [0, 0.5, 1]) {
      const [x, y] = rate(a, b, score);
      assert.equal(x + y, a + b);
    }
  }
  assert.ok(Math.abs(expectedScore(1200, 1000) + expectedScore(1000, 1200) - 1) < 1e-12);
});
