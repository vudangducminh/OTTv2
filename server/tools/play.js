#!/usr/bin/env node
// Plays two bot files against each other in the same sandbox the server uses.
//
//   node server/tools/play.js my-bot.js library/examples/greedy.js
//   node server/tools/play.js my-bot.js library/examples/random.js --games 20
//
// One game prints the full log; several games print one line each and a tally.

const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { Match } = require('../src/match');

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node server/tools/play.js <bot1.js> <bot2.js> [--games N]');
  process.exit(1);
}

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const gamesFlag = args.indexOf('--games');
const games = gamesFlag === -1 ? 1 : Number(args[gamesFlag + 1]);
if (files.length !== 2) usage();
if (!Number.isInteger(games) || games < 1) usage('--games needs a positive number');

const bots = files.map((file) => {
  try {
    return { name: path.basename(file, '.js'), code: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return usage(`Cannot read ${file}: ${error.message}`);
  }
});

async function playOne(index, verbose) {
  const match = new Match({ id: index, name: 'local', config: { ...config, moveDelayMs: 0, logDir: null } });
  match.sit(1, bots[0]);
  match.sit(2, bots[1]);
  if (verbose) match.on('log', (entry) => console.log(entry.text));
  await match.run();
  return match;
}

(async () => {
  if (games === 1) {
    await playOne(1, true);
    return;
  }
  const tally = { 1: 0, 2: 0, 0: 0 };
  for (let i = 1; i <= games; i++) {
    const match = await playOne(i, false);
    tally[match.result.winner ?? 0]++;
    console.log(`game ${i}: ${match.result.message}`);
  }
  console.log(`\n${bots[0].name} (P1) ${tally[1]} – ${tally[2]} ${bots[1].name} (P2), ${tally[0]} drawn`);
})();
