// Random — plays any legal move. The smallest possible bot.
const OTT = require('ottv2');

function move(game) {
  return OTT.random(game.legalMoves());
}
