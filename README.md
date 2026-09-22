# OTTv2 board hall

A hall of **OTTv2** tables — a 9×9 rock-paper-scissors
chess. Anyone can open a table, two people take its seats, and everyone else
watches — click any board in the lobby to pull up a chair. Multiple tables run
at once and every one of them is live in the lobby.

Each side starts with two full ranks of pieces (rock/paper/scissors, repeating).
A piece steps one square in any of the 8 directions around it, like a chess
king, and may enter a square held by an enemy piece only if its own type beats
that piece's type (✊ beats ✌️, ✌️ beats 🖐️, 🖐️ beats ✊) — same-type pieces of
either color simply block each other. Win by wiping out any one enemy piece
type entirely, or by walking a piece into the opposing home corner, `a1` or
`i9`.

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
const tables = playhtml.createPageData('rps-tables', {});

// tables.getData() === {
//   "a3f1c2": {
//     seat1: "<player id>", seat2: null, name1: "Ada", name2: null,
//     cells: { "0": "1r", "4": "2s" },  // "<player><type letter>", e.g. 1=Đỏ rock
//     turn: 1, winner: null, winKind: null, winType: null, winCell: null,
//     round: 0, createdAt: …, lastActiveAt: …,
//   },
//   …
// }
```

`cells` is keyed `"0"`–`"80"` for the 81 squares (`row * 9 + col`, row 0 = rank
1). A missing or `null` key means the square is empty — a piece that moves off
a square is written as `null` there rather than deleted, since only ever
*setting* keys (never deleting into the nested map) is what keeps this
CRDT-safe. The channel is named `rps-tables`, not the original hall's `tables`
— this game's shape (`seat1`/`seat2`, piece codes instead of `X`/`O`) isn't
compatible with anything that might already be persisted under the old key, so
it gets a fresh channel instead of migrating old data in place.

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

The rules live in a handful of functions in `app.js` — `newTable`, `legalMoves`,
`move`, `rematch`, plus the small `checkWin`/`countPieces`/`beats` helpers and
the `BOARD_SIZE`/`CELL_COUNT` constants. Everything else (the lobby, seats,
spectating, presence, pruning) is game-agnostic. This is itself a replacement of
an earlier tic-tac-toe version — swapping the game meant swapping exactly this
layer and nothing else.
