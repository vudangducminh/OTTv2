// Elo ratings. Everyone starts at 1000; beating a stronger player earns more.

const STARTING_RATING = 1000;
const K = 32;

/** Chance that a player rated `a` beats one rated `b`. */
function expectedScore(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * New ratings after a game. `score1` is player 1's result: 1 win, 0.5 draw, 0 loss.
 * Whatever player 1 gains, player 2 loses, so the total never drifts.
 */
function rate(rating1, rating2, score1) {
  const change = Math.round(K * (score1 - expectedScore(rating1, rating2)));
  return [rating1 + change, rating2 - change];
}

module.exports = { STARTING_RATING, K, expectedScore, rate };
