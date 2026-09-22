import { playhtml } from 'https://unpkg.com/playhtml@2.14.1';

// Every table in the hall lives in one playhtml room, inside one page-data
// channel keyed by table id. That is what lets the lobby draw each table's real
// board instead of a summary: the lobby and the table view read the same data.
const ROOM = 'ottv2-hall';
// Renamed from the tic-tac-toe hall's 'tables' channel: the board shape here
// (81 keyed squares holding piece codes, seat1/seat2 instead of seatX/seatO)
// is not compatible with anything already persisted under that key, so this
// game gets its own fresh channel instead of migrating old data in place.
const CHANNEL = 'rps-tables';

// ------------------------------------------------------------------ the game
// OTTv2 — a 9x9 rock-paper-scissors chess. Each side
// starts with two full ranks of pieces; a piece steps one square in any of 8
// directions (like a chess king) and may only enter a square held by an enemy
// piece its own type beats. Win by wiping out any one enemy piece type, or by
// walking a piece into the opposing home corner (a1 or i9).
const BOARD_SIZE = 9;
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const TYPES = ['rock', 'paper', 'scissors'];
const TYPE_LETTER = { rock: 'r', paper: 'p', scissors: 's' };
const LETTER_TYPE = { r: 'rock', p: 'paper', s: 'scissors' };
const GLYPH = { rock: '✊', paper: '🖐️', scissors: '✌️' };
const PIECE_NAME = { rock: 'Búa', paper: 'Bao', scissors: 'Kéo' };
const PLAYER_NAME = { 1: 'Đỏ', 2: 'Lam' };
const SEAT_LABEL = { 1: 'Đ', 2: 'L' };
// Row 0 = rank 1 (Đỏ's back rank), row 8 = rank 9 (Lam's back rank).
const ROW_NEAR = ['rock', 'paper', 'scissors', 'rock', 'paper', 'scissors', 'rock', 'paper', 'scissors'];
const ROW_FAR = ['paper', 'scissors', 'rock', 'paper', 'scissors', 'rock', 'paper', 'scissors', 'rock'];

const MAX_TABLES = 24;
const EMPTY_TABLE_TTL = 10 * 60 * 1000;
const IDLE_TABLE_TTL = 2 * 60 * 60 * 1000;

// One seat per browser, so nobody can quietly play themselves. `?solo=1` lifts
// that for local testing without needing a second browser profile.
const soloMode = new URLSearchParams(window.location.search).get('solo') === '1';

const elements = {
  notice: document.querySelector('#notice'),
  playerName: document.querySelector('#player-name'),
  hallCount: document.querySelector('#hall-count'),
  lobby: document.querySelector('#lobby'),
  lobbyStatus: document.querySelector('#lobby-status'),
  openTable: document.querySelector('#open-table'),
  tables: document.querySelector('#tables'),
  table: document.querySelector('#table'),
  backToHall: document.querySelector('#back-to-hall'),
  tableId: document.querySelector('#table-id'),
  tableState: document.querySelector('#table-state'),
  tableRole: document.querySelector('#table-role'),
  seats: document.querySelector('#seats'),
  counts: document.querySelector('#counts'),
  tableWatchers: document.querySelector('#table-watchers'),
  seatAction: document.querySelector('#seat-action'),
  rematch: document.querySelector('#rematch'),
  copyLink: document.querySelector('#copy-link'),
  closeTable: document.querySelector('#close-table'),
  rankLabels: document.querySelector('#rank-labels'),
  fileLabels: document.querySelector('#file-labels'),
  board: document.querySelector('#board'),
  deselect: document.querySelector('#deselect'),
  boardNote: document.querySelector('#board-note'),
};

// `crypto.randomUUID` only exists in a secure context, and this server runs on
// plain http over a LAN address. `getRandomValues` has no such restriction.
function randomId(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readStored(key, create) {
  let value = null;
  try {
    value = window.localStorage.getItem(key);
  } catch {
    value = null;
  }
  if (value) return value;

  const created = create();
  try {
    window.localStorage.setItem(key, created);
  } catch {
    // Private browsing: this identity just lasts for the page load.
  }
  return created;
}

// Persisted, so a refresh keeps whatever seat you were holding.
const playerId = readStored('ottv2:player-id', () => randomId(8));
let playerName = readStored('ottv2:player-name', () => `Guest ${randomId(1)}`);

let tables = null;
let presence = null;
let presences = new Map();
let currentTableId = new URLSearchParams(window.location.search).get('game');
const cards = new Map();
let noticeTimer = null;

// Which square (0-80) the local viewer has picked up, if any. Purely local UI
// state — never written to shared data, so it never needs to sync and always
// resets when you switch tables.
let selectedFrom = null;

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { elements.notice.hidden = true; }, 6000);
}

// ----------------------------------------------------------------- geometry

function indexOf(row, col) { return row * BOARD_SIZE + col; }
function rowOf(index) { return Math.floor(index / BOARD_SIZE); }
function colOf(index) { return index % BOARD_SIZE; }

function encodePiece(player, type) { return `${player}${TYPE_LETTER[type]}`; }
function decodePiece(code) {
  if (!code) return null;
  return { player: Number(code[0]), type: LETTER_TYPE[code[1]] };
}

function startingCells() {
  const cells = {};
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    cells[String(indexOf(0, col))] = encodePiece(1, ROW_NEAR[col]);
    cells[String(indexOf(1, col))] = encodePiece(1, ROW_FAR[col]);
    cells[String(indexOf(8, col))] = encodePiece(2, ROW_NEAR[col]);
    cells[String(indexOf(7, col))] = encodePiece(2, ROW_FAR[col]);
  }
  return cells;
}

function newTable() {
  return {
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    round: 0,
    seat1: null,
    seat2: null,
    name1: null,
    name2: null,
    cells: startingCells(),
    turn: 1,
    winner: null,
    winKind: null, // 'capture' | 'corner'
    winType: null, // captured piece type, for a 'capture' win
    winCell: null, // 'a1' | 'i9', for a 'corner' win
  };
}

// Reads the 81 fixed keys instead of enumerating the CRDT proxy, so the same
// helper works on a live draft and on a plain snapshot.
function snapshotCells(source) {
  const cells = {};
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const code = source?.[String(index)];
    if (code) cells[String(index)] = code;
  }
  return cells;
}

// ------------------------------------------------------------------- rules

function beats(a, b) {
  return (a === 'rock' && b === 'scissors') || (a === 'scissors' && b === 'paper') || (a === 'paper' && b === 'rock');
}

function legalMoves(cellsSnap, from) {
  const piece = decodePiece(cellsSnap[String(from)]);
  if (!piece) return [];
  const row = rowOf(from);
  const col = colOf(from);
  const moves = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
      const to = indexOf(nr, nc);
      const target = decodePiece(cellsSnap[String(to)]);
      if (!target) moves.push({ to, capture: false });
      else if (target.player !== piece.player && beats(piece.type, target.type)) moves.push({ to, capture: true });
    }
  }
  return moves;
}

function countPieces(cellsSnap, player, type) {
  let count = 0;
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const piece = decodePiece(cellsSnap[String(index)]);
    if (piece && piece.player === player && piece.type === type) count += 1;
  }
  return count;
}

function checkWin(cellsAfter, mark, to, capturedPiece) {
  if (capturedPiece && countPieces(cellsAfter, capturedPiece.player, capturedPiece.type) === 0) {
    return { winner: mark, kind: 'capture', type: capturedPiece.type, cell: null };
  }
  if (to === 0 || to === CELL_COUNT - 1) {
    return { winner: mark, kind: 'corner', type: null, cell: to === 0 ? 'a1' : 'i9' };
  }
  return null;
}

function seatsHeld(table) {
  if (!table) return [];
  return [1, 2].filter((seat) => (seat === 1 ? table.seat1 : table.seat2) === playerId);
}

// The player this browser may move as right now. Holding both seats is only
// reachable in solo mode, where you alternate between them.
function markFor(table) {
  const held = seatsHeld(table);
  if (held.length === 2) return table.turn;
  return held[0] ?? null;
}

function canAct(table, mark) {
  return Boolean(mark) && !table.winner && isFull(table) && table.turn === mark;
}

function seatName(table, seat) {
  return (seat === 1 ? table.name1 : table.name2) || 'Open seat';
}

function seatId(table, seat) {
  return seat === 1 ? table.seat1 : table.seat2;
}

function isFull(table) {
  return Boolean(table.seat1 && table.seat2);
}

function winReasonText(table) {
  if (!table.winner) return '';
  if (table.winKind === 'capture') return `Đã ăn sạch quân ${PIECE_NAME[table.winType]} của đối phương.`;
  if (table.winKind === 'corner') return `Đã đưa quân vào ô ${table.winCell}.`;
  return '';
}

function describe(table) {
  if (table.winner) return `${seatName(table, table.winner)} thắng`;
  if (!isFull(table)) return 'Waiting for a second player';
  return `Đến lượt ${seatName(table, table.turn)}`;
}

function watcherCounts() {
  const counts = new Map();
  for (const view of presences.values()) {
    const seat = view.hall;
    if (!seat?.tableId) continue;
    counts.set(seat.tableId, (counts.get(seat.tableId) ?? 0) + 1);
  }
  return counts;
}

function connectedPlayerIds() {
  const ids = new Set();
  for (const view of presences.values()) {
    if (view.hall?.playerId) ids.add(view.hall.playerId);
  }
  return ids;
}

function publishPresence() {
  presence?.setMyPresence('hall', { tableId: currentTableId, name: playerName, playerId });
}

function navigate(tableId) {
  const url = tableId ? `?game=${encodeURIComponent(tableId)}` : window.location.pathname;
  window.history.pushState({ tableId }, '', url);
  currentTableId = tableId;
  selectedFrom = null;
  publishPresence();
  render();
}

// --------------------------------------------------------------- shared writes
// Every write below runs from an explicit user action, never from an onUpdate or
// presence callback, and every write is a keyed set rather than an array append.

function openTable() {
  const id = randomId(3);
  // Insert first, then prune, so the new table counts against the cap and the
  // hall settles at MAX_TABLES rather than one over it.
  tables.setData((draft) => {
    draft[id] = newTable();
    pruneTables(draft);
  });
  claimSeat(id);
  navigate(id);
}

function pruneTables(draft) {
  const now = Date.now();
  for (const id of Object.keys(draft)) {
    const table = draft[id];
    const idle = now - (table?.lastActiveAt ?? table?.createdAt ?? 0);
    const abandoned = !table?.seat1 && !table?.seat2;
    if ((abandoned && idle > EMPTY_TABLE_TTL) || idle > IDLE_TABLE_TTL) delete draft[id];
  }

  const oldestFirst = Object.keys(draft)
    .map((id) => [id, draft[id]?.lastActiveAt ?? 0])
    .sort((a, b) => a[1] - b[1]);
  while (oldestFirst.length > MAX_TABLES) delete draft[oldestFirst.shift()[0]];
}

function claimSeat(tableId) {
  let outcome = 'none';
  tables.setData((draft) => {
    const table = draft[tableId];
    if (!table) return;

    const held = seatsHeld(table);
    if (held.length && !soloMode) { outcome = 'already'; return; }
    if (held.length === 2) { outcome = 'already'; return; }

    if (!table.seat1) {
      table.seat1 = playerId;
      table.name1 = playerName;
      outcome = 1;
    } else if (!table.seat2) {
      table.seat2 = playerId;
      table.name2 = playerName;
      outcome = 2;
    } else {
      outcome = 'full';
    }
    table.lastActiveAt = Date.now();
  });

  // Two people can claim the same open seat at once. The CRDT settles on one of
  // them, so confirm against the merged value rather than trusting the write.
  const settled = tables.getData()[tableId];
  if (outcome === 'full') showNotice('Both seats at that table are taken. You can still watch.');
  else if (outcome !== 'already' && !seatsHeld(settled).length) {
    showNotice('Someone else took that seat first. You can still watch.');
  }
}

function leaveSeat(tableId) {
  tables.setData((draft) => {
    const table = draft[tableId];
    if (!table) return;
    if (table.seat1 === playerId) { table.seat1 = null; table.name1 = null; }
    if (table.seat2 === playerId) { table.seat2 = null; table.name2 = null; }
    table.lastActiveAt = Date.now();
  });
}

function move(tableId, from, to) {
  const table = tables.getData()[tableId];
  if (!table) return;

  const mark = markFor(table);
  if (!canAct(table, mark)) return;

  const cells = snapshotCells(table.cells);
  const piece = decodePiece(cells[String(from)]);
  if (!piece || piece.player !== mark) return;
  if (!legalMoves(cells, from).some((candidate) => candidate.to === to)) return;

  tables.setData((draft) => {
    const draftTable = draft[tableId];
    if (!draftTable) return;

    // Re-check against the merged draft: the opponent's move may have landed
    // between the read above and this transaction.
    const liveCells = snapshotCells(draftTable.cells);
    const livePiece = decodePiece(liveCells[String(from)]);
    if (draftTable.winner || draftTable.turn !== mark || !livePiece || livePiece.player !== mark) return;
    if (!legalMoves(liveCells, from).some((candidate) => candidate.to === to)) return;

    const capturedPiece = decodePiece(liveCells[String(to)]);
    const movedCode = liveCells[String(from)];
    draftTable.cells[String(from)] = null;
    draftTable.cells[String(to)] = movedCode;

    const afterCells = { ...liveCells, [String(from)]: null, [String(to)]: movedCode };
    const result = checkWin(afterCells, mark, to, capturedPiece);
    if (result) {
      draftTable.winner = result.winner;
      draftTable.winKind = result.kind;
      draftTable.winType = result.type;
      draftTable.winCell = result.cell;
    } else {
      draftTable.turn = mark === 1 ? 2 : 1;
    }
    draftTable.lastActiveAt = Date.now();
  });
}

function rematch(tableId) {
  tables.setData((draft) => {
    const table = draft[tableId];
    if (!table) return;
    const round = (table.round ?? 0) + 1;
    table.cells = startingCells();
    table.round = round;
    table.turn = round % 2 === 0 ? 2 : 1;
    table.winner = null;
    table.winKind = null;
    table.winType = null;
    table.winCell = null;
    table.lastActiveAt = Date.now();
  });
}

function closeTable(tableId) {
  tables.setData((draft) => { delete draft[tableId]; });
}

function renameEverywhere(name) {
  tables.setData((draft) => {
    for (const id of Object.keys(draft)) {
      const table = draft[id];
      if (table.seat1 === playerId) table.name1 = name;
      if (table.seat2 === playerId) table.name2 = name;
    }
  });
}

// ------------------------------------------------------------------- rendering

function buildMiniBoard() {
  const board = document.createElement('button');
  board.type = 'button';
  board.className = 'mini-board';
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const span = document.createElement('span');
    span.className = (rowOf(index) + colOf(index)) % 2 === 0 ? '' : 'dark';
    board.append(span);
  }
  return board;
}

function createCard(id) {
  const card = document.createElement('article');
  card.className = 'table-card';
  card.dataset.tableId = id;

  const board = buildMiniBoard();
  board.setAttribute('aria-label', `Watch table ${id}`);
  board.addEventListener('click', () => navigate(id));

  const meta = document.createElement('div');
  meta.className = 'table-meta';
  meta.innerHTML = '<strong></strong><span class="card-state"></span><span class="card-seats"></span>';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const sit = document.createElement('button');
  sit.type = 'button';
  sit.className = 'primary sit';
  sit.addEventListener('click', () => {
    claimSeat(id);
    navigate(id);
  });

  const watch = document.createElement('button');
  watch.type = 'button';
  watch.className = 'secondary';
  watch.textContent = 'Watch';
  watch.addEventListener('click', () => navigate(id));

  actions.append(sit, watch);
  card.append(board, meta, actions);
  return card;
}

function updateCard(card, id, table, watchers) {
  const cells = snapshotCells(table.cells);

  [...card.querySelector('.mini-board').children].forEach((span, index) => {
    const piece = decodePiece(cells[String(index)]);
    span.classList.toggle('occupied', Boolean(piece));
    span.classList.toggle('p1', piece?.player === 1);
    span.classList.toggle('p2', piece?.player === 2);
  });

  const held = seatsHeld(table);
  card.querySelector('strong').textContent = `Table ${id}`;
  card.querySelector('.card-state').textContent = describe(table);
  card.querySelector('.card-seats').textContent =
    `${seatName(table, 1)} (Đỏ) vs ${seatName(table, 2)} (Lam) · ${watchers} watching`;
  card.classList.toggle('mine', held.length > 0);

  const sit = card.querySelector('.sit');
  if (held.length && !(soloMode && held.length === 1)) {
    sit.textContent = `Your seat (${held.map((seat) => PLAYER_NAME[seat]).join(' + ')})`;
    sit.disabled = true;
  } else if (isFull(table)) {
    sit.textContent = 'Table full';
    sit.disabled = true;
  } else {
    sit.textContent = held.length ? 'Take the other seat' : 'Take a seat';
    sit.disabled = false;
  }
}

function renderLobby(data, counts) {
  const ids = Object.keys(data).sort((a, b) => (data[b].createdAt ?? 0) - (data[a].createdAt ?? 0));

  for (const [id, card] of cards) {
    if (!(id in data)) {
      card.remove();
      cards.delete(id);
    }
  }

  ids.forEach((id, position) => {
    let card = cards.get(id);
    if (!card) {
      card = createCard(id);
      cards.set(id, card);
    }
    updateCard(card, id, data[id], counts.get(id) ?? 0);
    if (elements.tables.children[position] !== card) {
      elements.tables.insertBefore(card, elements.tables.children[position] ?? null);
    }
  });

  elements.lobbyStatus.textContent = ids.length
    ? `${ids.length} live ${ids.length === 1 ? 'table' : 'tables'} · click a board to watch it`
    : 'No tables yet. Open the first one.';
}

function renderSeats(table, connected) {
  const held = seatsHeld(table);
  elements.seats.replaceChildren(...[1, 2].map((seat) => {
    const occupant = seatId(table, seat);
    const away = Boolean(occupant) && !connected.has(occupant);

    const item = document.createElement('li');
    item.className = 'seat';
    item.classList.toggle('seat-empty', !occupant);
    item.classList.toggle('seat-turn', !table.winner && isFull(table) && table.turn === seat);
    item.innerHTML = '<span class="seat-mark"></span><span class="seat-name"></span><span class="seat-tag"></span>';
    item.querySelector('.seat-mark').textContent = SEAT_LABEL[seat];
    item.querySelector('.seat-name').textContent = seatName(table, seat);
    item.querySelector('.seat-tag').textContent = held.includes(seat) ? 'you' : away ? 'away' : '';
    return item;
  }));
}

function renderCounts(table) {
  const cells = snapshotCells(table.cells);
  elements.counts.replaceChildren(...[1, 2].flatMap((player) => TYPES.map((type) => {
    const count = countPieces(cells, player, type);
    const chip = document.createElement('span');
    chip.className = `count-chip p${player}` + (count === 0 ? ' zero' : '');
    chip.textContent = `${GLYPH[type]} ${count}`;
    chip.title = `${PLAYER_NAME[player]} · ${PIECE_NAME[type]}`;
    return chip;
  })));
}

function renderBoard(table, acting, mark) {
  const cells = snapshotCells(table.cells);
  const moves = acting && selectedFrom !== null ? legalMoves(cells, selectedFrom) : [];
  const moveMap = new Map(moves.map((candidate) => [candidate.to, candidate.capture]));

  for (const cellEl of elements.board.children) {
    const index = Number(cellEl.dataset.index);
    const piece = decodePiece(cells[String(index)]);
    const hintEl = cellEl.querySelector('.hint');
    const pieceEl = cellEl.querySelector('.piece');

    cellEl.classList.toggle('selected', selectedFrom === index);

    if (moveMap.has(index)) {
      hintEl.hidden = false;
      hintEl.classList.toggle('capture', moveMap.get(index));
    } else {
      hintEl.hidden = true;
      hintEl.classList.remove('capture');
    }

    if (piece) {
      pieceEl.hidden = false;
      pieceEl.textContent = GLYPH[piece.type];
      pieceEl.className = 'piece p' + piece.player + (piece.player !== table.turn ? ' dim' : '');
      pieceEl.title = `${PLAYER_NAME[piece.player]} · ${PIECE_NAME[piece.type]}`;
    } else {
      // A square a piece just moved away from must not keep showing its old
      // glyph — clear the content, not just the `hidden` flag, so nothing
      // stale is left for a CSS rule (or anything else) to accidentally reveal.
      pieceEl.hidden = true;
      pieceEl.textContent = '';
      pieceEl.className = 'piece';
      pieceEl.title = '';
    }

    cellEl.classList.toggle('selectable', acting && Boolean((piece && piece.player === mark) || moveMap.has(index)));
    cellEl.disabled = !acting;
  }
}

function renderTable(data, counts) {
  const table = data[currentTableId];
  const mark = markFor(table);
  const held = seatsHeld(table);
  const acting = canAct(table, mark);

  // The selection is local scratch state; drop it the moment it stops making
  // sense (turn passed, seat lost, the selected piece moved or was captured).
  if (selectedFrom !== null) {
    const cells = snapshotCells(table.cells);
    const piece = decodePiece(cells[String(selectedFrom)]);
    if (!acting || !piece || piece.player !== mark) selectedFrom = null;
  }

  elements.tableId.textContent = currentTableId;
  elements.tableState.textContent = describe(table);
  elements.tableRole.textContent = held.length
    ? `You are ${held.map((seat) => PLAYER_NAME[seat]).join(' and ')}${acting ? ' · your move' : ''}`
    : 'Spectating · moves are disabled';

  renderSeats(table, connectedPlayerIds());
  renderCounts(table);

  const watchers = counts.get(currentTableId) ?? 0;
  elements.tableWatchers.textContent = `${watchers} ${watchers === 1 ? 'person' : 'people'} at this table`;

  renderBoard(table, acting, mark);
  elements.deselect.hidden = selectedFrom === null;

  if (held.length && !(soloMode && held.length === 1)) {
    elements.seatAction.textContent = 'Leave seat';
    elements.seatAction.disabled = false;
  } else if (isFull(table)) {
    elements.seatAction.textContent = 'Both seats taken';
    elements.seatAction.disabled = true;
  } else {
    elements.seatAction.textContent = held.length ? 'Take the other seat' : 'Take a seat';
    elements.seatAction.disabled = false;
  }

  elements.rematch.hidden = !table.winner || !held.length;
  elements.closeTable.hidden = !held.length;

  elements.boardNote.textContent = held.length
    ? table.winner
      ? `Round over — ${winReasonText(table)}`
      : isFull(table)
        ? 'Every move is shared live with everyone watching this table.'
        : 'Share the watch link — someone still needs to take the other seat.'
    : table.winner
      ? winReasonText(table)
      : 'Spectator view. You see each move as the players make it.';
}

function render() {
  const data = tables.getData();

  // The table may have been closed or pruned by someone else while we sat in it.
  if (currentTableId && !(currentTableId in data)) {
    showNotice('That table is no longer open.');
    currentTableId = null;
    selectedFrom = null;
    window.history.replaceState({ tableId: null }, '', window.location.pathname);
    publishPresence();
  }

  const counts = watcherCounts();
  elements.lobby.hidden = Boolean(currentTableId);
  elements.table.hidden = !currentTableId;

  const online = presences.size;
  elements.hallCount.textContent = `${online} ${online === 1 ? 'person' : 'people'} in the hall`;

  renderLobby(data, counts);
  if (currentTableId) renderTable(data, counts);
}

// ---------------------------------------------------------------------- wiring

async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path.
  }

  // navigator.clipboard is unavailable over plain http, which is how this hall
  // is normally reached on a LAN.
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  } catch {
    return false;
  }
}

function buildLabels() {
  elements.rankLabels.innerHTML = '';
  for (let rank = BOARD_SIZE; rank >= 1; rank -= 1) {
    const span = document.createElement('span');
    span.textContent = String(rank);
    elements.rankLabels.append(span);
  }

  elements.fileLabels.innerHTML = '';
  for (const file of FILES) {
    const span = document.createElement('span');
    span.textContent = file;
    elements.fileLabels.append(span);
  }
}

function buildBoard() {
  elements.board.innerHTML = '';
  for (let displayRow = BOARD_SIZE - 1; displayRow >= 0; displayRow -= 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const index = indexOf(displayRow, col);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell' + ((displayRow + col) % 2 === 0 ? '' : ' dark');
      cell.dataset.index = String(index);
      cell.setAttribute('aria-label', `${FILES[col]}${displayRow + 1}`);

      if (index === 0 || index === CELL_COUNT - 1) {
        cell.classList.add('goal', index === 0 ? 'corner-a1' : 'corner-i9');
        const tag = document.createElement('span');
        tag.className = 'corner-tag';
        tag.textContent = index === 0 ? 'a1' : 'i9';
        cell.append(tag);
      }

      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.hidden = true;
      cell.append(hint);

      const piece = document.createElement('span');
      piece.className = 'piece';
      piece.hidden = true;
      cell.append(piece);

      cell.addEventListener('click', () => handleCellClick(index));
      elements.board.append(cell);
    }
  }
}

function handleCellClick(index) {
  const table = tables.getData()[currentTableId];
  if (!table) return;
  const mark = markFor(table);
  if (!canAct(table, mark)) return;

  const cells = snapshotCells(table.cells);

  if (selectedFrom !== null) {
    if (selectedFrom === index) { selectedFrom = null; render(); return; }
    const moves = legalMoves(cells, selectedFrom);
    if (moves.some((candidate) => candidate.to === index)) {
      const from = selectedFrom;
      selectedFrom = null;
      move(currentTableId, from, index);
      return;
    }
  }

  const piece = decodePiece(cells[String(index)]);
  selectedFrom = piece && piece.player === mark ? index : null;
  render();
}

function wireControls() {
  elements.playerName.value = playerName;
  elements.playerName.addEventListener('change', () => {
    const next = elements.playerName.value.trim().slice(0, 24);
    if (!next || next === playerName) {
      elements.playerName.value = playerName;
      return;
    }
    playerName = next;
    try {
      window.localStorage.setItem('ottv2:player-name', playerName);
    } catch {
      // Not fatal; the name still applies for this session.
    }
    publishPresence();
    renameEverywhere(playerName);
  });

  buildLabels();
  buildBoard();

  elements.openTable.addEventListener('click', openTable);
  elements.backToHall.addEventListener('click', () => navigate(null));
  elements.deselect.addEventListener('click', () => { selectedFrom = null; render(); });

  elements.seatAction.addEventListener('click', () => {
    const table = tables.getData()[currentTableId];
    if (!table) return;
    const held = seatsHeld(table);
    if (held.length && !(soloMode && held.length === 1)) leaveSeat(currentTableId);
    else claimSeat(currentTableId);
    render();
  });

  elements.rematch.addEventListener('click', () => rematch(currentTableId));

  elements.copyLink.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const link = `${window.location.origin}/?game=${encodeURIComponent(currentTableId)}`;
    button.textContent = (await copyText(link)) ? 'Link copied' : link;
    window.setTimeout(() => { button.textContent = 'Copy watch link'; }, 2500);
  });

  elements.closeTable.addEventListener('click', () => {
    if (!window.confirm('Close this table for everyone?')) return;
    closeTable(currentTableId);
    navigate(null);
  });

  window.addEventListener('popstate', () => {
    currentTableId = new URLSearchParams(window.location.search).get('game');
    selectedFrom = null;
    publishPresence();
    render();
  });
}

async function start() {
  wireControls();

  await playhtml.init({
    room: ROOM,
    onError: () => showNotice('Lost the connection to the hall. Reload to try again.'),
  });
  await playhtml.ready;

  tables = playhtml.createPageData(CHANNEL, {});
  presence = playhtml.presence;
  presences = presence.getPresences();

  tables.onUpdate(render);
  presence.onPresenceChange('hall', (next) => {
    presences = next;
    render();
  });

  publishPresence();
  render();

  if (soloMode) showNotice('Solo mode: this browser may hold both seats at a table.');
}

start().catch((error) => {
  elements.lobbyStatus.textContent = `Could not reach the hall: ${error.message}`;
  showNotice('playhtml failed to load. Check the network connection and reload.');
});
