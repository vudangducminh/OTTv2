# OTTv2

Rock, paper, scissors on a 9×9 board, played by bots. Players don't move tokens by hand. Each player writes a small JavaScript bot with the `ottv2` library and submits it from the web client. When a match has two bots, the server plays the game, writes a log, and streams every move live to the players and to anyone watching.

## Running it

Requires Node.js 20 or newer. There are no dependencies to install.

```sh
npm start
```

Then open http://localhost:6767. The server also prints its LAN addresses so other people on the network can join.

Settings, all optional, are read from environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `6767` / `0.0.0.0` | Where the server listens |
| `MOVE_DELAY_MS` | `600` | Pause between moves so people can follow the game |
| `MOVE_TIME_LIMIT_MS` | `1000` | Time a bot has for each move |
| `BOT_MEMORY_MB` | `64` | Heap limit per bot process |
| `MAX_RUNNING_MATCHES` | `8` | Matches played at the same time; the rest wait in a queue |
| `LOG_DIR` | `server/logs` | Where match logs are written |

## Using the client

- **Lobby (left side):** live matches, tables waiting for an opponent, and recent results. It updates in real time.
- **New match:** enter your name, paste or upload your bot (or start from an example), and either wait for a human opponent or play a house bot right away. **Test my bot** runs your code on a test board without joining a match.
- **Join:** open a waiting match and submit your bot for the free seat. The match starts immediately.
- **Watch:** any match can be opened while it's live. The board animates each move. The **Moves** tab lists every move, and the **Server log** tab shows the server's log, including bot `console.log` output. After the game you can replay it with the slider, the buttons, or ← → Home End Space. **Log file** downloads the log.
- **Bot library:** the in-app reference for the `ottv2` API, with example bots to download.

## Game rules

- Each player has 6 rocks, 6 papers and 6 scissors, placed at random. P1 (Red) gets rows a–c and P2 (Blue) gets rows g–i. Rows d–f start empty.
- On each turn, a player moves one token to one of its 8 neighbouring cells. A token can't move onto a friendly token.
- Moving onto an enemy token starts a battle: rock beats scissors, scissors beats paper, paper beats rock. The winner takes the cell and the loser is removed. Ties are not legal moves.
- A player wins by moving a token onto the opposite corner (i9 for Red, a1 for Blue, including by winning a battle there) or by removing every enemy token.

The requirements leave some cases open, so the server applies these rules:

- Red (the first player to submit) moves first.
- A player with no legal moves loses.
- After 400 moves the player with more tokens wins. Equal counts are a draw.
- A bot that throws, takes longer than the time limit, runs out of memory, or returns an illegal move forfeits.

## Writing a bot

```js
const OTT = require('ottv2');

function move(game) {
  const moves = game.legalMoves();          // [{ from, to, token, defender, outcome }]
  const capture = moves.find((m) => m.outcome === 'win');
  return capture || OTT.random(moves);      // or a string like 'c3 d4'
}
```

The full API is on the **Bot library** page in the client. The examples in [library/examples](library/examples) range from random play to a 2-ply search.

To test bots locally, run them against each other in the same sandbox the server uses:

```sh
npm run play -- my-bot.js library/examples/greedy.js
npm run play -- my-bot.js library/examples/random.js --games 20
```

## How it's built

```
library/ottv2.js        The hand-made library: rules engine and bot helpers. One file, used by
                        the server (authoritative rules), the sandbox (what bots require) and the
                        browser (match replay).
library/examples/       Example bots, offered as templates and as house opponents.
server/server.js        Entry point.
server/src/arena.js     Creating, joining, queueing and cleaning up matches.
server/src/match.js     One match: runs the bots turn by turn, validates moves, writes the log.
server/src/sandbox.js   Starts each bot in its own Node process and talks to it over IPC.
server/src/bot-runner.js  Runs inside that process: loads the bot into an isolated vm context.
server/src/http.js      REST API, Server-Sent Events stream, static files.
server/tools/play.js    Command-line match runner.
client/                 The web client (plain HTML, CSS and ES modules; no build step).
test/                   Engine unit tests and end-to-end server tests (npm test).
```

**Real-time updates:** each browser tab keeps a single Server-Sent Events stream (`/api/stream?match=<id>`). The stream always carries the lobby, plus the snapshot, moves and log lines for the match being watched. Submissions go through ordinary POST requests.

**Running untrusted code:** every bot runs in its own child process. Node's permission model is enabled, so the process can't write files or start other processes, and its heap is capped. Inside the process, the bot's code runs in a fresh `vm` context that holds only JavaScript built-ins and the library. It has no `require`, `process` or `eval`, and only strings cross the boundary. The vm enforces the per-move time limit, and the parent kills any process that stops answering. This is reasonable protection for a classroom or LAN server. It is not a hardened multi-tenant sandbox: Node 20's permission model doesn't restrict network access, so don't expose the server to the open internet as-is.

### API

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/matches` | Lobby list |
| GET | `/api/matches/:id` | Full snapshot: placement, moves, log, result |
| GET | `/api/matches/:id/log` | Plain-text log file |
| POST | `/api/matches` | `{ name, player, code, opponent? }`. Creates a match with you as P1. `opponent` is an example id for a house bot. |
| POST | `/api/matches/:id/join` | `{ player, code }` |
| POST | `/api/matches/:id/cancel` | `{ secret }` (returned when you sat down) |
| POST | `/api/check` | `{ code, seat }`. Test-runs a bot. |
| GET | `/api/examples`, `/api/config` | Example bots, limits |
| GET | `/api/stream?match=:id` | SSE events: `lobby`, `snapshot`, `update`, `move`, `log`, `missing` |
