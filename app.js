import { playhtml } from 'https://unpkg.com/playhtml@2.14.1';

// Every table in the hall lives in one playhtml room, inside one page-data
// channel keyed by table id. That is what lets the lobby draw each table's real
// board instead of a summary: the lobby and the table view read the same data.
const ROOM = 'ottv2-hall';
const CHANNEL = 'tables';
const CELL_COUNT = 9;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
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
  tableWatchers: document.querySelector('#table-watchers'),
  seatAction: document.querySelector('#seat-action'),
  rematch: document.querySelector('#rematch'),
  copyLink: document.querySelector('#copy-link'),
  closeTable: document.querySelector('#close-table'),
  board: document.querySelector('#board'),
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

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { elements.notice.hidden = true; }, 6000);
}

function newTable() {
  return {
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    round: 0,
    seatX: null,
    seatO: null,
    nameX: null,
    nameO: null,
    cells: {},
    turn: 'X',
    winner: null,
    winLine: null,
  };
}

// Reads the nine fixed keys instead of enumerating the CRDT proxy, so the same
// helper works on a live draft and on a plain snapshot.
function cellsSnapshot(source) {
  const cells = {};
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const mark = source?.[String(index)];
    if (mark) cells[String(index)] = mark;
  }
  return cells;
}

function evaluate(cells) {
  for (const line of LINES) {
    const [a, b, c] = line;
    const mark = cells[String(a)];
    if (mark && mark === cells[String(b)] && mark === cells[String(c)]) {
      return { winner: mark, winLine: line.join(',') };
    }
  }
  if (Object.keys(cells).length === CELL_COUNT) return { winner: 'draw', winLine: null };
  return null;
}

function seatsHeld(table) {
  if (!table) return [];
  return ['X', 'O'].filter((seat) => (seat === 'X' ? table.seatX : table.seatO) === playerId);
}

// The mark this browser may move as right now. Holding both seats is only
// reachable in solo mode, where you alternate between them.
function markFor(table) {
  const held = seatsHeld(table);
  if (held.length === 2) return table.turn;
  return held[0] ?? null;
}

function seatName(table, mark) {
  return (mark === 'X' ? table.nameX : table.nameO) || 'Open seat';
}

function seatId(table, mark) {
  return mark === 'X' ? table.seatX : table.seatO;
}

function isFull(table) {
  return Boolean(table.seatX && table.seatO);
}

function describe(table) {
  if (table.winner === 'draw') return 'Draw';
  if (table.winner) return `${seatName(table, table.winner)} wins`;
  if (!isFull(table)) return 'Waiting for a second player';
  return `${seatName(table, table.turn)} to move`;
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
    const abandoned = !table?.seatX && !table?.seatO;
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

    if (!table.seatX) {
      table.seatX = playerId;
      table.nameX = playerName;
      outcome = 'X';
    } else if (!table.seatO) {
      table.seatO = playerId;
      table.nameO = playerName;
      outcome = 'O';
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
    if (table.seatX === playerId) { table.seatX = null; table.nameX = null; }
    if (table.seatO === playerId) { table.seatO = null; table.nameO = null; }
    table.lastActiveAt = Date.now();
  });
}

function play(tableId, index) {
  const table = tables.getData()[tableId];
  if (!table) return;

  const mark = markFor(table);
  if (!mark || !isFull(table) || table.winner || table.turn !== mark) return;
  if (cellsSnapshot(table.cells)[String(index)]) return;

  tables.setData((draft) => {
    const draftTable = draft[tableId];
    if (!draftTable) return;

    // Re-check against the merged draft: the opponent's move may have landed
    // between the read above and this transaction.
    const cells = cellsSnapshot(draftTable.cells);
    if (draftTable.winner || draftTable.turn !== mark || cells[String(index)]) return;

    draftTable.cells[String(index)] = mark;
    cells[String(index)] = mark;

    const result = evaluate(cells);
    if (result) {
      draftTable.winner = result.winner;
      draftTable.winLine = result.winLine;
    } else {
      draftTable.turn = mark === 'X' ? 'O' : 'X';
    }
    draftTable.lastActiveAt = Date.now();
  });
}

function rematch(tableId) {
  tables.setData((draft) => {
    const table = draft[tableId];
    if (!table) return;
    const round = (table.round ?? 0) + 1;
    table.cells = {};
    table.round = round;
    table.turn = round % 2 === 0 ? 'X' : 'O';
    table.winner = null;
    table.winLine = null;
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
      if (table.seatX === playerId) table.nameX = name;
      if (table.seatO === playerId) table.nameO = name;
    }
  });
}

// ------------------------------------------------------------------- rendering

function buildMiniBoard() {
  const board = document.createElement('button');
  board.type = 'button';
  board.className = 'mini-board';
  for (let index = 0; index < CELL_COUNT; index += 1) board.append(document.createElement('span'));
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
  const cells = cellsSnapshot(table.cells);
  const winning = new Set((table.winLine ?? '').split(',').filter(Boolean));

  [...card.querySelector('.mini-board').children].forEach((cell, index) => {
    cell.textContent = cells[String(index)] ?? '';
    cell.className = winning.has(String(index)) ? 'win' : '';
  });

  const held = seatsHeld(table);
  card.querySelector('strong').textContent = `Table ${id}`;
  card.querySelector('.card-state').textContent = describe(table);
  card.querySelector('.card-seats').textContent =
    `${seatName(table, 'X')} (X) vs ${seatName(table, 'O')} (O) · ${watchers} watching`;
  card.classList.toggle('mine', held.length > 0);

  const sit = card.querySelector('.sit');
  if (held.length && !(soloMode && held.length === 1)) {
    sit.textContent = `Your seat (${held.join(' + ')})`;
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
  elements.seats.replaceChildren(...['X', 'O'].map((seat) => {
    const occupant = seatId(table, seat);
    const away = Boolean(occupant) && !connected.has(occupant);

    const item = document.createElement('li');
    item.className = 'seat';
    item.classList.toggle('seat-empty', !occupant);
    item.classList.toggle('seat-turn', !table.winner && isFull(table) && table.turn === seat);
    item.innerHTML = '<span class="seat-mark"></span><span class="seat-name"></span><span class="seat-tag"></span>';
    item.querySelector('.seat-mark').textContent = seat;
    item.querySelector('.seat-name').textContent = seatName(table, seat);
    item.querySelector('.seat-tag').textContent = held.includes(seat) ? 'you' : away ? 'away' : '';
    return item;
  }));
}

function renderTable(data, counts) {
  const table = data[currentTableId];
  const mark = markFor(table);
  const held = seatsHeld(table);
  const cells = cellsSnapshot(table.cells);
  const winning = new Set((table.winLine ?? '').split(',').filter(Boolean));
  const canMove = Boolean(mark) && !table.winner && isFull(table) && table.turn === mark;

  elements.tableId.textContent = currentTableId;
  elements.tableState.textContent = describe(table);
  elements.tableRole.textContent = held.length
    ? `You are ${held.join(' and ')}${canMove ? ' · your move' : ''}`
    : 'Spectating · moves are disabled';

  renderSeats(table, connectedPlayerIds());

  const watchers = counts.get(currentTableId) ?? 0;
  elements.tableWatchers.textContent = `${watchers} ${watchers === 1 ? 'person' : 'people'} at this table`;

  [...elements.board.children].forEach((cell, index) => {
    const value = cells[String(index)] ?? '';
    cell.textContent = value;
    cell.classList.toggle('filled', Boolean(value));
    cell.classList.toggle('win', winning.has(String(index)));
    cell.disabled = !canMove || Boolean(value);
  });

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
      ? 'Round over. Start a rematch when you are both ready.'
      : isFull(table)
        ? 'Every move is shared live with everyone watching this table.'
        : 'Share the watch link — someone still needs to take the other seat.'
    : 'Spectator view. You see each move as the players make it.';
}

function render() {
  const data = tables.getData();

  // The table may have been closed or pruned by someone else while we sat in it.
  if (currentTableId && !(currentTableId in data)) {
    showNotice('That table is no longer open.');
    currentTableId = null;
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

  for (let index = 0; index < CELL_COUNT; index += 1) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.setAttribute('aria-label', `Cell ${index + 1}`);
    cell.addEventListener('click', () => play(currentTableId, index));
    elements.board.append(cell);
  }

  elements.openTable.addEventListener('click', openTable);
  elements.backToHall.addEventListener('click', () => navigate(null));

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
    publishPresence();
    render();
  });
}

async function start() {
  wireControls();

  await playhtml.init({
    room: ROOM,
    cursors: { enabled: true, room: 'page' },
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
