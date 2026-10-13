# OTTv2

Rock, paper, scissors on a 9×9 board, played by bots. Players don't move tokens by hand. Each player writes a small JavaScript bot with the `ottv2` library and submits it from the web client. When a match has two bots, the server plays the game, writes a log, and streams every move live to the players and to anyone watching.

Players have accounts. Games between two players are rated (Elo, starting at 1000), and the **Ranking** page shows the standings. Everything is stored in PostgreSQL.

## Running it

### With Docker (app + database)

```sh
docker compose up --build
```

Then open http://localhost:6767. This starts two containers: PostgreSQL (data kept in the `pgdata` volume) and the app (match logs kept in the `logs` volume). Stop them with `docker compose down`. Add `-v` to also delete the data.

### On your machine (for development)

Requires Node.js 20 or newer. Run only the database in Docker, then the server with Node:

```sh
docker compose up -d db      # PostgreSQL on localhost:5433
npm install
npm run dev                  # restarts when server files change; or: npm start
```

The server reads `DATABASE_URL` from the environment or from a `.env` file (copy `.env.example`). It defaults to the compose database at `postgres://ottv2:ottv2@localhost:5433/ottv2`. It creates its tables on startup. The database is published on port 5433 so it doesn't clash with a PostgreSQL already running on 5432.

### Accounts

Players sign up in the client. To create an account (or reset a password) from the command line:

```sh
node server/tools/create-user.js <username> <password>
node server/tools/create-user.js <username> <new-password> --reset
docker compose exec app node server/tools/create-user.js <username> <password>   # when the app runs in Docker
```

### Settings

All optional, from environment variables or `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://ottv2:ottv2@localhost:5433/ottv2` | PostgreSQL connection |
| `PORT` / `HOST` | `6767` / `0.0.0.0` | Where the server listens |
| `APP_PORT` | `6767` | Host port for the app in `docker compose` |
| `POSTGRES_PASSWORD` | `ottv2` | Database password in `docker compose` |
| `SESSION_DAYS` | `30` | How long a login lasts |
| `MOVE_DELAY_MS` | `600` | Pause between moves so people can follow the game |
| `MOVE_TIME_LIMIT_MS` | `1000` | Time a bot has for each move |
| `BOT_MEMORY_MB` | `64` | Heap limit per bot process |
| `MAX_RUNNING_MATCHES` | `8` | Matches played at the same time; the rest wait in a queue |
| `LOG_DIR` | `server/logs` | Where match logs are written |

## Using the client

- **Log in / Create account:** needed to submit a bot. Watching doesn't need an account. Your username is the name shown on your seat.
- **Lobby (left side):** live matches, tables waiting for an opponent, and recent results. It updates in real time.
- **New match:** paste or upload your bot (or start from an example), then either wait for another player (rated) or play a house bot right away (practice). **Test my bot** runs your code on a test board without joining a match.
- **Join:** open a waiting match and submit your bot for the free seat. The match starts immediately.
- **Ranking:** players with at least one rated game, ordered by rating. Click a name for their profile: rating, rank, wins, losses, draws, and recent matches with rating changes.
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
- After 600 moves the player with more tokens wins. Equal counts are a draw.
- A bot that throws, takes longer than the time limit, runs out of memory, or returns an illegal move forfeits.

## Ratings

- Every account starts at **1000**.
- A game is **rated** when two different registered players play it to a result. Games against house bots or against yourself are saved to your history as practice, but don't change ratings.
- Ratings use Elo with K = 32. Between equal players the winner gains 16 and the loser drops 16. Beating a higher-rated player earns more, and losing to a lower-rated one costs more. A draw moves the ratings toward each other. Forfeits count as losses.
- The rating update and the saved match are written in one database transaction.

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
server/server.js        Entry point: connects to PostgreSQL, sets up tables, starts HTTP.
server/src/arena.js     Creating, joining, queueing and cleaning up matches.
server/src/match.js     One match: runs the bots turn by turn, validates moves, writes the log.
server/src/sandbox.js   Starts each bot in its own Node process and talks to it over IPC.
server/src/bot-runner.js  Runs inside that process: loads the bot into an isolated vm context.
server/src/http.js      REST API, Server-Sent Events stream, static files.
server/src/accounts.js  Sign-up, login, sessions, password hashing.
server/src/db.js        PostgreSQL queries: users, sessions, saved matches, ranking.
server/src/schema.sql   The tables (applied at startup).
server/src/ratings.js   Elo rating calculation.
server/tools/play.js    Command-line match runner.
server/tools/create-user.js  Create an account or reset a password.
client/                 The web client (plain HTML, CSS and ES modules; no build step).
test/                   Engine, rating and end-to-end server tests (npm test).
Dockerfile, docker-compose.yml  Container image for the app; compose file for app + PostgreSQL.
```

**Tests:** `npm test` needs the database (`docker compose up -d db`). The server tests use their own `ottv2_test` schema and delete it afterwards, so your data is untouched. Without a database they're skipped with a message, and the engine and rating tests still run.

**Accounts and security:** passwords are hashed with scrypt and a random salt. A login is a random token in an `HttpOnly`, `SameSite=Lax` cookie, and only its SHA-256 hash is stored in the `sessions` table. A wrong username and a wrong password give the same error and take the same time, and repeated failed logins from one address are slowed down. Requests that change data must be JSON, which blocks plain form posts from other sites. The database is only published on `127.0.0.1` and players never reach it directly.

**Real-time updates:** each browser tab keeps a single Server-Sent Events stream (`/api/stream?match=<id>`). The stream always carries the lobby, plus the snapshot, moves and log lines for the match being watched. Submissions go through ordinary POST requests.

**Running untrusted code:** every bot runs in its own child process. Node's permission model is enabled, so the process can't write files or start other processes, and its heap is capped. Inside the process, the bot's code runs in a fresh `vm` context that holds only JavaScript built-ins and the library. It has no `require`, `process` or `eval`, and only strings cross the boundary. The vm enforces the per-move time limit, and the parent kills any process that stops answering. This is reasonable protection for a classroom or LAN server. It is not a hardened multi-tenant sandbox: Node 20's permission model doesn't restrict network access, so don't expose the server to the open internet as-is.

### API

POST bodies are JSON. 🔒 means you must be logged in (the session cookie).

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `{ username, password }`. Creates the account and logs in. |
| POST | `/api/auth/login` | `{ username, password }` |
| POST | `/api/auth/logout` | `{}` |
| GET | `/api/auth/me` | `{ user }`, or `{ user: null }` when logged out |
| GET | `/api/leaderboard` | `{ players }` with rank, rating, games, wins, losses, draws |
| GET | `/api/users/:username` | Profile: `{ user, matches }` |
| GET | `/api/matches` | Lobby list |
| GET | `/api/matches/:id` | Full snapshot: placement, moves, log, result, rating changes |
| GET | `/api/matches/:id/log` | Plain-text log file |
| POST | `/api/matches` 🔒 | `{ code, name?, opponent? }`. Creates a match with you as P1. `opponent` is an example id for a house bot. |
| POST | `/api/matches/:id/join` 🔒 | `{ code }` |
| POST | `/api/matches/:id/cancel` 🔒 | `{}`. Only a player in the match can cancel it. |
| POST | `/api/check` 🔒 | `{ code, seat }`. Test-runs a bot. |
| GET | `/api/examples`, `/api/config`, `/api/health` | Example bots, limits, health check (used by Docker) |
| GET | `/api/stream?match=:id` | SSE events: `lobby`, `snapshot`, `update`, `move`, `log`, `missing` |
