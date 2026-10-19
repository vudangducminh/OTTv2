const test = require('node:test');
const assert = require('node:assert/strict');
const { roundRobin, standings, redIsA } = require('../server/src/tournaments');

test('round robin: everyone meets everyone exactly once', () => {
  for (const n of [2, 3, 4, 5, 8, 9, 16]) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const pairings = roundRobin(ids);
    assert.equal(pairings.length, (n * (n - 1)) / 2, `${n} players`);
    const seen = new Set();
    for (const { playerA, playerB } of pairings) {
      assert.notEqual(playerA, playerB);
      const key = [playerA, playerB].sort((x, y) => x - y).join('-');
      assert.ok(!seen.has(key), `${key} meets twice`);
      seen.add(key);
    }
    // Nobody plays twice in the same round.
    const rounds = new Map();
    for (const p of pairings) {
      if (!rounds.has(p.round)) rounds.set(p.round, new Set());
      const busy = rounds.get(p.round);
      assert.ok(!busy.has(p.playerA) && !busy.has(p.playerB), `round ${p.round} double-booked`);
      busy.add(p.playerA).add(p.playerB);
    }
    assert.equal(rounds.size, n % 2 ? n : n - 1);
  }
});

test('colours alternate: each player is Red twice and Blue twice in a 4-game match', () => {
  const sides = [1, 2, 3, 4].map((g) => (redIsA(g) ? 'A' : 'B'));
  assert.deepEqual(sides, ['A', 'B', 'A', 'B']);
});

const entrants = [
  { id: 1, username: 'ann' },
  { id: 2, username: 'bob' },
  { id: 3, username: 'cy' },
];

test('standings: 3 points for a match win, 1 for a draw, 0 for a loss, GD from games', () => {
  const matches = [
    { playerA: 1, playerB: 2, aWins: 3, bWins: 1, gamesPlayed: 4 }, // ann beats bob 3–1
    { playerA: 3, playerB: 1, aWins: 2, bWins: 2, gamesPlayed: 4 }, // cy draws ann 2–2
    { playerA: 2, playerB: 3, aWins: 1, bWins: 0, gamesPlayed: 4 }, // bob beats cy 1–0 (3 drawn games)
  ];
  const table = standings(entrants, matches, 4);
  assert.deepEqual(
    table.map((r) => [r.rank, r.username, r.mp, r.w, r.d, r.l, r.gw, r.gl, r.gd, r.pts]),
    [
      [1, 'ann', 2, 1, 1, 0, 5, 3, 2, 4],
      [2, 'bob', 2, 1, 0, 1, 2, 3, -1, 3],
      [3, 'cy', 2, 0, 1, 1, 2, 3, -1, 1],
    ],
  );
});

test('standings: unfinished matches do not count yet, and ties share a rank', () => {
  const table = standings(entrants, [{ playerA: 1, playerB: 2, aWins: 2, bWins: 0, gamesPlayed: 2 }], 4);
  assert.ok(table.every((r) => r.mp === 0 && r.pts === 0));
  assert.deepEqual(
    table.map((r) => r.rank),
    [1, 1, 1],
  );
});

test('standings: GD breaks a tie on points', () => {
  const matches = [
    { playerA: 1, playerB: 3, aWins: 4, bWins: 0, gamesPlayed: 4 },
    { playerA: 2, playerB: 3, aWins: 3, bWins: 1, gamesPlayed: 4 },
  ];
  const [first, second] = standings(entrants, matches, 4);
  assert.equal(first.username, 'ann');
  assert.equal(first.gd, 4);
  assert.equal(second.username, 'bob');
  assert.equal(second.gd, 2);
  assert.equal(second.rank, 2);
});
