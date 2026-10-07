// Greedy — takes winning battles, avoids losing ones, and otherwise marches toward its target.
const OTT = require('ottv2');

function score(game, m) {
  if (m.to === game.myTarget) return 1000; // reaching the target wins outright
  if (m.outcome === 'lose') return -100;

  let value = 0;
  if (m.outcome === 'win') value += 50;

  // Progress toward the target corner.
  value += 3 * (OTT.distance(m.from, game.myTarget) - OTT.distance(m.to, game.myTarget));

  // Don't step next to something that beats us.
  if (game.threats(m.to, m.token.type).length) value -= 30;

  // Small random tie-breaker so the bot doesn't get stuck shuffling.
  return value + Math.random();
}

function move(game) {
  let best = null;
  let bestScore = -Infinity;
  for (const m of game.legalMoves()) {
    const s = score(game, m);
    if (s > bestScore) {
      best = m;
      bestScore = s;
    }
  }
  return best;
}
