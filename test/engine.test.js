const test = require('node:test');
const assert = require('node:assert/strict');
const OTT = require('../library/ottv2.js');

const { Game } = OTT;

// Small hand-made positions. Ids only need to be unique.
function position(tokens, extra = {}) {
  return new Game({ tokens: tokens.map(([owner, type, cell], i) => ({ id: i + 1, owner, type, cell })), ...extra });
}

test('a new game places 6 of each type per player on their home rows', () => {
  const game = Game.create();
  for (const player of [1, 2]) {
    const mine = game.tokens(player);
    assert.equal(mine.length, 18);
    for (const type of OTT.TYPES) assert.equal(game.count(player, type), 6);
    for (const token of mine) assert.ok(OTT.HOME_ROWS[player].includes(token.cell[0]), `${token.cell} is a home row`);
  }
  assert.equal(game.tokens().filter((t) => 'def'.includes(t.cell[0])).length, 0, 'rows d–f start empty');
  assert.equal(game.turn, 1);
});

test('cells, neighbours and distance', () => {
  assert.equal(OTT.cell(0, 0), 'a1');
  assert.equal(OTT.cell(8, 8), 'i9');
  assert.equal(OTT.cell(9, 0), null);
  assert.deepEqual(OTT.coords('c4'), { row: 2, col: 3 });
  assert.equal(OTT.coords('j1'), null);
  assert.equal(OTT.coords('a0'), null);
  assert.deepEqual([...OTT.neighbors('a1')].sort(), ['a2', 'b1', 'b2']);
  assert.equal(OTT.neighbors('e5').length, 8);
  assert.equal(OTT.distance('a1', 'i9'), 8);
  assert.equal(OTT.distance('c3', 'd5'), 2);
});

test('rock beats scissors, scissors beats paper, paper beats rock', () => {
  assert.equal(OTT.battle('rock', 'scissors'), 'win');
  assert.equal(OTT.battle('scissors', 'paper'), 'win');
  assert.equal(OTT.battle('paper', 'rock'), 'win');
  assert.equal(OTT.battle('scissors', 'rock'), 'lose');
  assert.equal(OTT.battle('rock', 'rock'), 'tie');
  assert.equal(OTT.counter('rock'), 'paper');
});

test('moves accept objects, arrays and strings', () => {
  for (const input of [{ from: 'c3', to: 'd4' }, ['c3', 'd4'], 'c3 d4', 'C3-D4', 'c3->d4', 'c3d4', 'c3 → d4']) {
    assert.deepEqual(OTT.normalizeMove(input), { from: 'c3', to: 'd4' }, JSON.stringify(input));
  }
  for (const input of [null, 42, 'c3', 'c3 d4 e5', { from: 'z9', to: 'a1' }]) assert.equal(OTT.normalizeMove(input), null);
});

test('a token moves one step in any of 8 directions, never onto a friend', () => {
  const game = position([
    [1, 'rock', 'e5'],
    [1, 'paper', 'e6'],
    [2, 'rock', 'a9'],
  ]);
  const targets = game.movesFrom('e5').map((m) => m.to).sort();
  assert.deepEqual(targets, ['d4', 'd5', 'd6', 'e4', 'f4', 'f5', 'f6']);
  assert.match(game.validate('e5 e6'), /your own paper/);
  assert.match(game.validate('e5 e7'), /not next to/);
  assert.match(game.validate('a9 a8'), /belongs to player 2/);
  assert.match(game.validate('b2 b3'), /no token/);
});

test('winning a battle captures, losing removes the attacker, ties are illegal', () => {
  const game = position([
    [1, 'rock', 'd4'],
    [1, 'paper', 'd6'],
    [2, 'scissors', 'e4'],
    [2, 'scissors', 'e6'],
    [2, 'rock', 'e5'],
    [2, 'rock', 'i1'],
  ]);
  assert.match(game.validate('d4 e5'), /tie/);

  const win = game.play('d4 e4');
  assert.equal(win.outcome, 'win');
  assert.equal(game.at('e4').type, 'rock');
  assert.equal(game.at('e4').owner, 1);
  assert.equal(game.count(2, 'scissors'), 1);
  assert.equal(game.turn, 2);

  game.play('i1 h1');
  const loss = game.play('d6 e6');
  assert.equal(loss.outcome, 'lose');
  assert.equal(game.at('d6'), null);
  assert.equal(game.at('e6').owner, 2);
  assert.equal(game.count(1), 1);
});

test('reaching the far corner wins, even by capturing on it', () => {
  const p1 = position([
    [1, 'rock', 'h8'],
    [2, 'scissors', 'i9'],
    [2, 'paper', 'a5'],
  ]);
  p1.play('h8 i9');
  assert.equal(p1.winner, 1);
  assert.equal(p1.reason, 'target');

  const p2 = position(
    [
      [1, 'paper', 'e5'],
      [2, 'paper', 'b2'],
    ],
    { turn: 2 },
  );
  p2.play('b2 a1');
  assert.equal(p2.winner, 2);
  assert.equal(p2.reason, 'target');

  const ownCorner = position([
    [1, 'rock', 'a2'],
    [2, 'paper', 'i5'],
  ]);
  ownCorner.play('a2 a1');
  assert.equal(ownCorner.isOver, false, 'a1 is only a target for player 2');
});

test('losing a battle on the target cell does not win', () => {
  const game = position([
    [1, 'scissors', 'h8'],
    [1, 'paper', 'a1'],
    [2, 'rock', 'i9'],
    [2, 'paper', 'a9'],
  ]);
  game.play('h8 i9');
  assert.equal(game.isOver, false);
  assert.equal(game.at('i9').owner, 2);
});

test('capturing the last enemy token wins', () => {
  const game = position([
    [1, 'paper', 'e5'],
    [2, 'rock', 'e6'],
  ]);
  game.play('e5 e6');
  assert.equal(game.winner, 1);
  assert.equal(game.reason, 'eliminated');
});

test('losing your last token loses', () => {
  const game = position([
    [1, 'rock', 'e5'],
    [2, 'paper', 'e6'],
    [2, 'paper', 'i1'],
  ]);
  game.play('e5 e6');
  assert.equal(game.winner, 2);
  assert.equal(game.reason, 'eliminated');
});

test('a player left without legal moves loses', () => {
  // P2's only rock sits in the i1 corner; P1 rocks on all three neighbours make every move a tie.
  const game = position([
    [1, 'rock', 'h1'],
    [1, 'rock', 'h2'],
    [1, 'rock', 'h3'],
    [2, 'rock', 'i1'],
  ]);
  assert.equal(game.legalMoves(2).length, 1, 'i2 is still free');
  game.play('h3 i2');
  assert.equal(game.winner, 1);
  assert.equal(game.reason, 'no-moves');
});

test('the move limit ends the game, decided by tokens left', () => {
  const game = position(
    [
      [1, 'rock', 'e1'],
      [1, 'rock', 'a5'],
      [2, 'rock', 'e9'],
    ],
    { maxPlies: 2 },
  );
  game.play('e1 e2');
  game.play('e9 e8');
  assert.equal(game.winner, 1);
  assert.equal(game.reason, 'turn-limit');

  const even = position(
    [
      [1, 'rock', 'e1'],
      [2, 'rock', 'e9'],
    ],
    { maxPlies: 2 },
  );
  even.play('e1 e2');
  even.play('e9 e8');
  assert.equal(even.winner, 0);
});

test('after() does not change the original game', () => {
  const game = Game.create();
  const before = JSON.stringify(game.toJSON());
  const move = game.legalMoves()[0];
  const next = game.after(move);
  assert.equal(JSON.stringify(game.toJSON()), before);
  assert.equal(next.ply, 1);
  assert.equal(next.turn, 2);
  assert.equal(next.history.length, 1);
});

test('toJSON / fromJSON round-trips and legalMoves only lists accepted moves', () => {
  let game = Game.create();
  for (let i = 0; i < 60 && !game.isOver; i++) {
    for (const m of game.legalMoves()) assert.equal(game.validate(m), null);
    game.play(OTT.random(game.legalMoves()));
    game = Game.fromJSON(JSON.parse(JSON.stringify(game)));
  }
  assert.ok(game.ply > 0);
});

test('random games always finish within the move limit', () => {
  for (let i = 0; i < 25; i++) {
    const game = Game.create();
    while (!game.isOver) game.play(OTT.random(game.legalMoves()));
    assert.ok(game.ply <= OTT.MAX_PLIES);
    assert.ok([0, 1, 2].includes(game.winner));
  }
});
