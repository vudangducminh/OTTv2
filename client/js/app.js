import { $, el, fill, icon, toast, timeAgo, clock, store, api, copyText } from './ui.js';
import { Board } from './board.js';
import { SubmitDialog } from './submit.js';

const OTT = window.OTT;
const COLOR = { 1: 'Red', 2: 'Blue' };
const REPLAY_STEP_MS = 520;

const app = {
  matches: [],
  examples: [],
  config: null,
  route: { view: 'home', id: null },
  match: null,
};

const board = new Board($('#board'));
let dialog = null;

// ---------- Seats this browser has taken ----------

const seats = {
  all() {
    return store.get('ottv2.seats', {});
  },
  remember(summary, seat, secret) {
    const all = this.all();
    all[summary.id] = { seat, secret, createdAt: summary.createdAt };
    const ids = Object.keys(all).sort((a, b) => all[b].createdAt - all[a].createdAt);
    for (const id of ids.slice(60)) delete all[id];
    store.set('ottv2.seats', all);
  },
  /** { seat, secret } if this browser submitted a bot to `summary`. */
  of(summary) {
    if (!summary) return null;
    const entry = this.all()[summary.id];
    // Match ids restart with the server, so also check it's the same match.
    return entry && entry.createdAt === summary.createdAt ? entry : null;
  },
};

// ---------- Live stream ----------

const stream = {
  source: null,
  watching: undefined,

  connect(matchId) {
    if (this.source && this.watching === matchId) return;
    if (this.source) this.source.close();
    this.watching = matchId;
    const source = new EventSource(`/api/stream${matchId ? `?match=${matchId}` : ''}`);
    this.source = source;
    const on = (name, handler) => source.addEventListener(name, (event) => handler(JSON.parse(event.data)));

    on('lobby', (list) => {
      app.matches = list;
      renderLobby();
    });
    on('snapshot', (snapshot) => loadSnapshot(snapshot));
    on('missing', ({ id }) => showMissing(id));
    on('update', (summary) => onUpdate(summary));
    on('move', (payload) => onMove(payload));
    on('log', (entry) => onLog(entry));
    source.addEventListener('open', () => setConnection(true));
    source.addEventListener('error', () => setConnection(false));
  },
};

function setConnection(online) {
  const node = $('#conn');
  node.classList.toggle('on', online);
  node.classList.toggle('off', !online);
  node.querySelector('span').textContent = online ? 'Live' : 'Reconnecting…';
}

// ---------- Routing ----------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const match = /^match\/(\d+)/.exec(hash);
  if (match) return { view: 'match', id: Number(match[1]) };
  if (hash.startsWith('docs')) return { view: 'docs', id: null };
  return { view: 'home', id: null };
}

function onRoute() {
  const previous = app.route;
  app.route = parseRoute();
  const { view, id } = app.route;
  document.body.dataset.view = view;
  for (const name of ['home', 'match', 'docs']) $(`#view-${name}`).hidden = name !== view;

  if (view === 'match') {
    if (!app.match || app.match.id !== id) openMatch(id);
  } else {
    closeMatch();
  }
  stream.connect(view === 'match' ? id : null);
  renderLobby();
  if (previous.view !== view || previous.id !== id) window.scrollTo(0, 0);
  document.title = view === 'docs' ? 'Bot library · OTTv2' : view === 'match' ? `Match #${id} · OTTv2` : 'OTTv2 Arena';
}

// ---------- Lobby ----------

function statusPill(summary) {
  const { status, result } = summary;
  if (status === 'running') return el('span', { class: 'pill live' }, 'Live');
  if (status === 'waiting') return el('span', { class: 'pill waiting' }, 'Open seat');
  if (status === 'queued') return el('span', { class: 'pill queued' }, 'Starting');
  if (status === 'cancelled') return el('span', { class: 'pill' }, 'Cancelled');
  if (result && result.winner) return el('span', { class: `pill won${result.winner}` }, `P${result.winner} won`);
  return el('span', { class: 'pill' }, 'Draw');
}

function playerName(summary, seat) {
  const player = summary.players[seat - 1];
  return player ? player.name : null;
}

function matchItem(summary) {
  const active = app.route.view === 'match' && app.route.id === summary.id;
  const p1 = playerName(summary, 1);
  const p2 = playerName(summary, 2);
  const t1 = summary.tokens[1].total;
  const t2 = summary.tokens[2].total;

  let meta;
  if (summary.status === 'running') meta = `Move ${summary.ply} · ${t1}–${t2} tokens${summary.watchers ? ` · ${summary.watchers} watching` : ''}`;
  else if (summary.status === 'waiting') meta = `Waiting for an opponent · ${timeAgo(summary.createdAt)}`;
  else if (summary.status === 'queued') meta = 'Both bots ready, starting soon';
  else if (summary.status === 'cancelled') meta = summary.result?.message || 'Cancelled';
  else meta = `${summary.ply} moves · ${timeAgo(summary.finishedAt)}`;

  const mine = seats.of(summary);
  return el(
    'a',
    { class: `mi${active ? ' active' : ''}`, href: `#/match/${summary.id}` },
    el('div', { class: 'mi-top' }, el('span', { class: 'mi-id' }, `#${summary.id}`), el('span', { class: 'mi-name' }, summary.name), statusPill(summary)),
    el(
      'div',
      { class: 'mi-players' },
      el('span', { class: 'pn' }, el('i', { class: 'dot p1' }), p1 || el('span', { class: 'open' }, 'open seat')),
      el('span', { class: 'vs' }, 'vs'),
      el('span', { class: 'pn' }, el('i', { class: 'dot p2' }), p2 || el('span', { class: 'open' }, 'open seat')),
    ),
    el('div', { class: 'mi-meta' }, mine ? `You're P${mine.seat} · ${meta}` : meta),
    summary.status === 'running'
      ? el('div', { class: 'mi-bar' }, el('i', { style: `flex:${t1}` }), el('i', { style: `flex:${t2}` }))
      : null,
  );
}

function renderLobby() {
  const list = app.matches;
  const groups = [
    ['Live now', list.filter((m) => m.status === 'running' || m.status === 'queued'), 'No matches are being played right now.'],
    ['Waiting for an opponent', list.filter((m) => m.status === 'waiting'), 'No open tables. Create a match and someone can join it.'],
    ['Recent results', list.filter((m) => m.status === 'finished' || m.status === 'cancelled'), 'Finished matches show up here.'],
  ];
  $('#match-list').replaceChildren(
    ...groups.map(([title, items, empty]) =>
      el(
        'section',
        { class: 'ml-group' },
        el('h2', { class: 'ml-title' }, title, el('span', { class: 'ml-count' }, items.length)),
        items.length ? items.map(matchItem) : el('p', { class: 'ml-empty' }, empty),
      ),
    ),
  );

  const live = list.filter((m) => m.status === 'running').length;
  const waiting = list.filter((m) => m.status === 'waiting');
  fill(
    $('#home-stats'),
    el('span', {}, `${live} live ${live === 1 ? 'match' : 'matches'}`),
    el('span', {}, '·'),
    el('span', {}, `${waiting.length} waiting for an opponent`),
    waiting[0] ? el('a', { href: `#/match/${waiting[0].id}` }, el('i', { class: 'dot p2' }), `Join ${waiting[0].players[0]?.name || 'a player'}`) : null,
  );
}

// ---------- Match view ----------

function openMatch(id) {
  stopPlayback();
  app.match = {
    id,
    loaded: false,
    missing: false,
    summary: null,
    initial: null,
    moves: [],
    log: [],
    frames: [],
    replay: null,
    ply: 0,
    follow: true,
    timer: null,
  };
  board.clear();
  board.render([], null, false);
  $('#m-title').replaceChildren(el('span', { class: 'mid' }, `Match #${id}`));
  $('#m-meta').replaceChildren('Loading…');
  $('#m-result').hidden = true;
  $('#m-moves').replaceChildren();
  $('#m-log').replaceChildren();
  $('#m-p1').replaceChildren();
  $('#m-p2').replaceChildren();
  $('#m-turn').replaceChildren();
  showOverlay(el('div', { class: 'overlay-card' }, el('span', { class: 'spinner' }), el('p', {}, 'Loading match…')));
}

function closeMatch() {
  stopPlayback();
  app.match = null;
}

function loadSnapshot(snapshot) {
  const m = app.match;
  if (!m || m.id !== snapshot.id) return;
  const { initial, moves, log, ...summary } = snapshot;
  m.summary = summary;
  m.initial = initial;
  m.moves = moves.slice();
  m.log = log.slice();
  m.loaded = true;
  m.missing = false;
  buildFrames(m);
  m.ply = m.follow ? m.moves.length : Math.min(m.ply, m.moves.length);
  renderMatch(false);
}

function buildFrames(m) {
  m.frames = [];
  m.replay = null;
  if (!m.initial) return;
  try {
    m.replay = OTT.Game.fromJSON({ tokens: m.initial, maxPlies: m.summary.maxPlies });
    m.frames.push(m.replay.tokens());
    for (const record of m.moves) {
      m.replay.play(record);
      m.frames.push(m.replay.tokens());
    }
  } catch (error) {
    console.error('Could not replay this match', error);
  }
}

async function resync() {
  const m = app.match;
  if (!m) return;
  const { ok, data } = await api('GET', `/api/matches/${m.id}`);
  if (ok && app.match === m) loadSnapshot(data);
}

function onUpdate(summary) {
  const m = app.match;
  if (!m || m.id !== summary.id || !m.loaded) return;
  const ended = summary.status !== m.summary.status && (summary.status === 'finished' || summary.status === 'cancelled');
  m.summary = summary;
  if (ended) m.follow = false;
  renderHeader();
  renderPlayers();
  renderResult();
  renderOverlay();
  renderReplayBar();
  if (ended) {
    renderMoves();
    highlightMove();
  }
}

function onMove({ record, summary }) {
  const m = app.match;
  if (!m || m.id !== summary.id || !m.loaded) return;
  if (!m.replay || record.ply !== m.moves.length + 1) {
    resync();
    return;
  }
  m.summary = summary;
  m.moves.push(record);
  try {
    m.replay.play(record);
  } catch {
    resync();
    return;
  }
  m.frames.push(m.replay.tokens());
  const list = $('#m-moves');
  if (m.moves.length === 1) list.replaceChildren();
  list.append(moveRow(record));

  if (m.follow) {
    m.ply = m.moves.length;
    renderPosition(true);
  } else {
    renderReplayBar();
  }
  renderHeader();
}

function onLog(entry) {
  const m = app.match;
  if (!m || !m.loaded) return;
  m.log.push(entry);
  const box = $('#m-log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (m.log.length === 1) box.replaceChildren();
  box.append(logLine(entry));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function showMissing(id) {
  const m = app.match;
  if (!m || m.id !== id) return;
  m.missing = true;
  $('#m-title').replaceChildren(el('span', { class: 'mid' }, `Match #${id}`));
  $('#m-meta').replaceChildren('Not found');
  showOverlay(
    el(
      'div',
      { class: 'overlay-card' },
      el('h3', {}, 'This match no longer exists'),
      el('p', {}, 'It may have been removed after finishing, or the server was restarted.'),
      el('div', { class: 'oc-actions' }, el('a', { class: 'btn', href: '#/' }, 'Back to all matches')),
    ),
  );
}

// ----- rendering

function renderMatch(animate) {
  renderHeader();
  renderResult();
  renderOverlay();
  renderMoves();
  renderLog();
  renderPosition(animate);
}

function renderHeader() {
  const { summary } = app.match;
  const mine = seats.of(summary);
  $('#m-title').replaceChildren(el('span', { class: 'mid' }, `#${summary.id} `), summary.name);

  const meta = [statusPill(summary)];
  if (summary.watchers) meta.push(el('span', { class: 'meta-i' }, icon('eye'), `${summary.watchers} watching`));
  if (summary.startedAt) meta.push(el('span', {}, `Started ${clock(summary.startedAt)}`));
  else meta.push(el('span', {}, `Created ${timeAgo(summary.createdAt)}`));
  if (mine) meta.push(el('span', {}, `You're P${mine.seat} (${COLOR[mine.seat]})`));
  $('#m-meta').replaceChildren(...meta);

  const download = $('#m-download');
  download.hidden = !summary.startedAt;
  download.href = `/api/matches/${summary.id}/log`;
  $('#m-cancel').hidden = !(mine && (summary.status === 'waiting' || summary.status === 'queued'));
}

function countsAt(frame) {
  const counts = { 1: { total: 0 }, 2: { total: 0 } };
  for (const type of OTT.TYPES) counts[1][type] = counts[2][type] = 0;
  for (const token of frame) {
    counts[token.owner][token.type]++;
    counts[token.owner].total++;
  }
  return counts;
}

function renderPlayers() {
  const m = app.match;
  const { summary } = m;
  const frame = m.frames[m.ply];
  const counts = frame ? countsAt(frame) : summary.tokens;
  const toMove = currentTurn();
  const mine = seats.of(summary);
  const winner = summary.result?.winner;

  for (const seat of [1, 2]) {
    const player = summary.players[seat - 1];
    const card = $(`#m-p${seat}`);
    card.classList.toggle('active', summary.status === 'running' && toMove === seat);
    const tags = [];
    if (mine && mine.seat === seat) tags.push(el('span', { class: 'chip-you' }, 'You'));
    if (player?.house) tags.push(el('span', { class: 'chip-house' }, 'House'));
    if (winner === seat && summary.status === 'finished') tags.push(el('span', { class: `tc p${seat}`, title: 'Winner' }, icon('trophy', 'ui-i')));
    card.replaceChildren(
      el('div', { class: 'pc-name' }, el('i', { class: `dot p${seat}` }), el('b', {}, player ? player.name : 'Open seat'), ...tags),
      el('div', { class: 'pc-seat' }, `P${seat} · ${COLOR[seat]} · goal ${OTT.TARGETS[seat]}`),
      el(
        'div',
        { class: 'pc-counts' },
        ...OTT.TYPES.map((type) =>
          el('span', { class: `pc-count${counts[seat][type] ? '' : ' zero'}`, title: `${counts[seat][type]} ${type}` }, icon(type), counts[seat][type]),
        ),
        el('span', { class: 'pc-total' }, `${counts[seat].total} left`),
      ),
    );
  }

  const turn = $('#m-turn');
  const parts = [];
  if (summary.status === 'running' || summary.status === 'finished') {
    parts.push(el('span', { class: 'tb-big' }, m.ply), el('span', {}, `of ${summary.maxPlies} moves`));
    if (summary.status === 'running' || m.ply < m.moves.length) {
      parts.push(el('span', { class: 'tb-who' }, el('i', { class: `dot p${toMove}` }), `${COLOR[toMove]} to move`));
    }
  } else {
    parts.push(el('span', { class: 'tb-big' }, 'vs'));
  }
  turn.replaceChildren(...parts);
}

function currentTurn() {
  const m = app.match;
  if (m.ply === m.moves.length && m.summary.status === 'running') return m.summary.turn;
  return m.ply % 2 === 0 ? 1 : 2;
}

function renderResult() {
  const { summary } = app.match;
  const box = $('#m-result');
  const result = summary.result;
  if (!result || (summary.status !== 'finished' && summary.status !== 'cancelled')) {
    box.hidden = true;
    return;
  }
  const mine = seats.of(summary);
  let headline;
  if (summary.status === 'cancelled') headline = 'Match cancelled';
  else if (!result.winner) headline = 'Draw';
  else if (mine) headline = mine.seat === result.winner ? 'Your bot won!' : 'Your bot lost';
  else headline = `${playerName(summary, result.winner)} wins`;

  box.className = `result${result.winner ? ` win${result.winner}` : ''}`;
  box.replaceChildren(
    el('span', { class: 'r-icon' }, icon(result.winner ? 'trophy' : 'alert')),
    el('div', {}, el('strong', {}, headline), el('span', {}, result.message || '')),
  );
  box.hidden = false;
}

function showOverlay(content) {
  const overlay = $('#m-overlay');
  overlay.replaceChildren(content);
  overlay.hidden = false;
}

function renderOverlay() {
  const m = app.match;
  const { summary } = m;
  const overlay = $('#m-overlay');
  const mine = seats.of(summary);

  if (summary.status === 'waiting') {
    const open = summary.players.findIndex((p) => !p) + 1;
    const host = summary.players[2 - open];
    const actions = mine
      ? [
          el('button', { class: 'btn primary', type: 'button', onclick: copyLink }, icon('link', 'ui-i'), 'Copy invite link'),
          el('button', { class: 'btn danger', type: 'button', onclick: cancelMatch }, 'Cancel match'),
        ]
      : [
          el('button', { class: `btn p${open}`, type: 'button', onclick: () => dialog.open({ mode: 'join', match: summary }) }, `Join as P${open} (${COLOR[open]})`),
          el('button', { class: 'btn', type: 'button', onclick: copyLink }, icon('link', 'ui-i'), 'Copy link'),
        ];
    showOverlay(
      el(
        'div',
        { class: 'overlay-card' },
        el('h3', {}, mine ? 'Waiting for an opponent' : `${host?.name || 'Someone'} is looking for an opponent`),
        el(
          'p',
          {},
          mine
            ? 'Your bot passed the check and is seated. Share the link. The match starts when someone joins with their bot.'
            : `Submit your bot to take the ${COLOR[open]} seat. The match starts right away.`,
        ),
        el('div', { class: 'oc-actions' }, ...actions),
      ),
    );
    return;
  }
  if (summary.status === 'queued') {
    showOverlay(
      el(
        'div',
        { class: 'overlay-card' },
        el('span', { class: 'spinner' }),
        el('h3', {}, 'Both bots are in'),
        el('p', {}, 'The match starts as soon as the server has a free table.'),
      ),
    );
    return;
  }
  if (summary.status === 'cancelled' && !m.initial) {
    showOverlay(el('div', { class: 'overlay-card' }, el('h3', {}, 'Cancelled'), el('p', {}, summary.result?.message || 'This match never started.')));
    return;
  }
  overlay.hidden = true;
}

function renderPosition(animate) {
  const m = app.match;
  const frame = m.frames[m.ply] || [];
  const last = m.ply > 0 ? m.moves[m.ply - 1] : null;
  board.render(frame, last, animate);
  renderPlayers();
  renderReplayBar();
  highlightMove();
}

function renderReplayBar() {
  const m = app.match;
  const total = m.moves.length;
  const live = m.summary?.status === 'running';
  const slider = $('#m-slider');
  slider.max = String(total);
  slider.value = String(m.ply);
  slider.disabled = total === 0;
  $('#m-ply').textContent = m.ply === 0 ? (total ? 'Start position' : 'No moves yet') : `Move ${m.ply} of ${total}`;

  const bar = $('#m-replay');
  bar.querySelector('[data-step="first"]').disabled = m.ply === 0;
  bar.querySelector('[data-step="prev"]').disabled = m.ply === 0;
  bar.querySelector('[data-step="next"]').disabled = m.ply >= total;
  bar.querySelector('[data-step="last"]').disabled = m.ply >= total;
  const play = bar.querySelector('[data-step="play"]');
  play.disabled = total === 0;
  play.replaceChildren(icon(m.timer ? 'pause' : 'play'));
  play.setAttribute('aria-label', m.timer ? 'Pause' : 'Play');

  const liveButton = $('#m-live');
  liveButton.hidden = !live;
  liveButton.classList.toggle('on', live && m.follow);
  liveButton.title = m.follow ? 'Following the live game' : 'Jump to the live position';
}

function moveRow(record) {
  let outcome = null;
  if (record.outcome === 'win') outcome = el('span', { class: 'mv-out win' }, 'beats', icon(record.defender.type), record.defender.type);
  if (record.outcome === 'lose') outcome = el('span', { class: 'mv-out lose' }, 'lost to', icon(record.defender.type), record.defender.type);
  return el(
    'li',
    { class: `mv p${record.player}`, dataset: { ply: record.ply }, title: `Show the board after move ${record.ply}` },
    el('span', { class: 'mv-ply' }, record.ply),
    el('span', { class: 'mv-tok', title: record.type }, icon(record.type)),
    el('span', { class: 'mv-text' }, el('span', { class: 'mv-path' }, `${record.from} → ${record.to}`), outcome),
  );
}

function renderMoves() {
  const m = app.match;
  const list = $('#m-moves');
  if (!m.moves.length) {
    const note =
      m.summary.status === 'waiting' || m.summary.status === 'queued' ? 'Moves appear here once the match starts.' : 'No moves were played.';
    list.replaceChildren(el('li', { class: 'empty-note' }, note));
  } else {
    list.replaceChildren(...m.moves.map(moveRow));
  }
  if (m.summary.result && m.summary.status === 'finished') list.append(el('li', { class: 'mv-end' }, m.summary.result.message));
}

function highlightMove() {
  const m = app.match;
  const list = $('#m-moves');
  const previous = list.querySelector('.mv.current');
  if (previous) previous.classList.remove('current');
  const row = list.querySelector(`.mv[data-ply="${m.ply}"]`);
  if (!row) return;
  row.classList.add('current');
  const top = row.offsetTop - list.offsetTop;
  if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - row.offsetHeight) {
    list.scrollTop = top - list.clientHeight / 2;
  }
}

function logLine(entry) {
  return el(
    'div',
    { class: `log-line k-${entry.kind}${entry.player ? ` p${entry.player}` : ''}` },
    el('time', {}, clock(entry.at)),
    el('span', { class: 'lt' }, entry.text),
  );
}

function renderLog() {
  const m = app.match;
  const box = $('#m-log');
  box.replaceChildren(...(m.log.length ? m.log.map(logLine) : [el('div', { class: 'empty-note' }, 'Nothing logged yet.')]));
  box.scrollTop = box.scrollHeight;
}

// ----- replay controls

function setPly(ply, animate = true) {
  const m = app.match;
  if (!m || !m.loaded) return;
  const target = Math.max(0, Math.min(m.moves.length, ply));
  const step = Math.abs(target - m.ply);
  m.ply = target;
  m.follow = target === m.moves.length && m.summary.status === 'running';
  if (step === 0) renderReplayBar();
  else renderPosition(animate && step === 1);
}

function stopPlayback() {
  const m = app.match;
  if (m && m.timer) {
    clearInterval(m.timer);
    m.timer = null;
    renderReplayBar();
  }
}

function togglePlayback() {
  const m = app.match;
  if (!m || !m.moves.length) return;
  if (m.timer) return stopPlayback();
  if (m.ply >= m.moves.length) setPly(0, false);
  m.timer = setInterval(() => {
    if (m.ply >= m.moves.length) {
      stopPlayback();
      return;
    }
    setPly(m.ply + 1);
  }, REPLAY_STEP_MS);
  renderReplayBar();
}

function goLive() {
  const m = app.match;
  if (!m) return;
  stopPlayback();
  m.follow = true;
  setPly(m.moves.length, false);
  renderReplayBar();
}

function wireMatchControls() {
  $('#m-replay').addEventListener('click', (event) => {
    const button = event.target.closest('[data-step]');
    if (!button || !app.match) return;
    const m = app.match;
    const step = button.dataset.step;
    if (step === 'play') return togglePlayback();
    stopPlayback();
    if (step === 'first') setPly(0, false);
    if (step === 'prev') setPly(m.ply - 1);
    if (step === 'next') setPly(m.ply + 1);
    if (step === 'last') setPly(m.moves.length, false);
  });
  $('#m-slider').addEventListener('input', (event) => {
    stopPlayback();
    setPly(Number(event.target.value), false);
  });
  $('#m-live').addEventListener('click', goLive);
  $('#m-moves').addEventListener('click', (event) => {
    const row = event.target.closest('.mv[data-ply]');
    if (!row) return;
    stopPlayback();
    setPly(Number(row.dataset.ply), false);
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('active', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      }
      $('#m-moves').hidden = tab.dataset.tab !== 'moves';
      $('#m-log').hidden = tab.dataset.tab !== 'log';
      if (tab.dataset.tab === 'log') $('#m-log').scrollTop = $('#m-log').scrollHeight;
    });
  }

  $('#m-copy').addEventListener('click', copyLink);
  $('#m-cancel').addEventListener('click', cancelMatch);

  document.addEventListener('keydown', (event) => {
    if (app.route.view !== 'match' || !app.match?.loaded) return;
    if (event.target.closest('input, textarea, select, dialog') || event.metaKey || event.ctrlKey || event.altKey) return;
    const m = app.match;
    const keys = {
      ArrowLeft: () => setPly(m.ply - 1),
      ArrowRight: () => setPly(m.ply + 1),
      Home: () => setPly(0, false),
      End: () => setPly(m.moves.length, false),
      ' ': () => togglePlayback(),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    if (event.key !== ' ') stopPlayback();
    action();
  });
}

async function copyLink() {
  const ok = await copyText(location.href);
  toast(ok ? 'Link copied' : 'Could not copy. Copy the address bar instead.', ok ? '' : 'bad');
}

async function cancelMatch() {
  const m = app.match;
  const mine = m && seats.of(m.summary);
  if (!mine || !confirm('Cancel this match? Your bot will leave the table.')) return;
  const { ok, data } = await api('POST', `/api/matches/${m.id}/cancel`, { secret: mine.secret });
  if (!ok) toast(data?.error || 'Could not cancel the match.', 'bad');
}

// ---------- Docs ----------

function renderDocs() {
  $('#docs-examples').replaceChildren(
    ...app.examples.map((example) =>
      el(
        'div',
        { class: 'example' },
        el('h3', {}, example.name),
        el('p', {}, example.description),
        el(
          'div',
          { class: 'ex-actions' },
          el('button', { class: 'btn sm primary', type: 'button', onclick: () => dialog.open({ mode: 'create', template: example.id }) }, 'Use as template'),
          el('a', { class: 'btn sm', href: `/library/examples/${example.id}.js?download=1` }, icon('download', 'ui-i'), 'Download'),
        ),
      ),
    ),
  );
  if (app.config) {
    for (const node of document.querySelectorAll('[data-config]')) node.textContent = app.config[node.dataset.config];
  }
}

// ---------- Startup ----------

function onSubmitted({ match, seat, secret }) {
  seats.remember(match, seat, secret);
  toast(match.status === 'waiting' ? 'Your bot is seated. Waiting for an opponent.' : 'Your bot is in. The match is starting.');
  location.hash = `#/match/${match.id}`;
}

async function start() {
  const [examples, config] = await Promise.all([api('GET', '/api/examples'), api('GET', '/api/config')]);
  app.examples = examples.ok ? examples.data : [];
  app.config = config.ok ? config.data : null;

  dialog = new SubmitDialog({ examples: app.examples, config: app.config, onSubmitted });
  for (const button of document.querySelectorAll('[data-action="new-match"]')) {
    button.addEventListener('click', () => dialog.open({ mode: 'create' }));
  }
  for (const link of document.querySelectorAll('[data-jump]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById(link.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  wireMatchControls();
  renderDocs();
  window.addEventListener('hashchange', onRoute);
  onRoute();

  // Keep "3 min ago" labels fresh.
  setInterval(() => {
    renderLobby();
    if (app.match?.loaded) renderHeader();
  }, 30 * 1000);
}

start();
