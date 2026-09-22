# OTTv2 board hall

A hall of tic-tac-toe tables. Anyone can open a table, two people take its
seats, and everyone else watches — click any board in the lobby to pull up a
chair. Multiple tables run at once and every one of them is live in the lobby.

## Run

```sh
npm start
```

The server prints the addresses it is reachable on. There are no dependencies to
install and nothing to build.

**Everyone must open the hall through the same address.** playhtml scopes its
room by `window.location.hostname`, so `http://localhost:6767` and
`http://10.11.172.241:6767` are two different halls that cannot see each other.
Pick one address and share that one — e.g. everyone opens
`http://10.11.172.241:6767`.

## How it works

`server.js` only serves files. It holds no game state, so restarting it does not
disturb a game in progress.

All the state lives in one playhtml room, `ottv2-hall`, in a single page-data
channel:

```js
const tables = playhtml.createPageData('tables', {});

// tables.getData() === {
//   "a3f1c2": {
//     seatX: "<player id>", seatO: null, nameX: "Ada", nameO: null,
//     cells: { "0": "X", "4": "O" }, turn: "X", winner: null, winLine: null,
//     round: 0, createdAt: …, lastActiveAt: …,
//   },
//   …
// }
```

One room holding every table is what makes the lobby's live mini-boards possible
— the lobby and the table view read the same shared object, so a move made at a
table repaints its thumbnail in everyone else's lobby at the same time. A room
per table would force the lobby back to polling summaries.

Two details follow from the data being a CRDT:

- **`cells` is a map keyed by square, not an array.** Concurrent writes to a Yjs
  array merge by appending, so `board[4] = "X"` from two clients corrupts the
  board. Keyed writes are last-write-wins per key and cannot grow the document.
- **Shared data is only written from user actions** — a click, a name change —
  never from `onUpdate` or a presence callback. A callback that writes the data
  it reacts to re-triggers itself, and because the merge appends rather than
  overwrites, the loop never converges.

Seats are claimed by writing a browser-local player id (kept in `localStorage`,
so a refresh keeps your seat). Two people can claim the same open seat at the
same instant; the CRDT settles on one of them, so `claimSeat` re-reads the
merged value and tells the loser they are watching instead.

Who is online, who is watching which table, and which seated player has wandered
off are all **presence**, not stored data — they should vanish when a tab
closes, and they do.

Tables are pruned when someone opens a new one: empty ones after 10 minutes,
idle ones after 2 hours, and the oldest beyond 24 tables.

## Testing on one machine

Seats are one per browser, so a second tab cannot take the other seat. Either
open a private window (separate `localStorage`) or add `?solo=1` to the URL,
which lets one browser hold both seats and alternate between them.

## Making it a different game

The rules are four small functions in `app.js` — `newTable`, `evaluate`, `play`
and `rematch` — plus `CELL_COUNT` and `LINES`. Everything else (the lobby, seats,
spectating, presence, pruning) is game-agnostic.
