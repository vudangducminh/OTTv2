// Lookahead — tries each move, then assumes the opponent answers with their best reply (2-ply search).
const OTT = require('ottv2');

// Material plus how close our best runner is to the target, from `me`'s point of view.
function evaluate(game, me) {
  if (game.isOver) return game.winner === me ? 1e6 : game.winner === 0 ? 0 : -1e6;
  const them = OTT.other(me);
  const race = (player) =>
    Math.min(...game.tokens(player).map((t) => OTT.distance(t.cell, OTT.TARGETS[player])));
  return 10 * (game.count(me) - game.count(them)) + 4 * (race(them) - race(me));
}

function move(game) {
  const me = game.me;
  let best = null;
  let bestScore = -Infinity;

  for (const m of game.legalMoves()) {
    const next = game.after(m);
    let worst = Infinity;
    if (next.isOver) {
      worst = evaluate(next, me);
    } else {
      for (const reply of next.legalMoves()) {
        worst = Math.min(worst, evaluate(next.after(reply), me));
        if (worst <= bestScore) break; // this move is already no better than one we have
      }
    }
    if (worst > bestScore) {
      best = m;
      bestScore = worst;
    }
  }
  return best;
}
