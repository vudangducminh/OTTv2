import { $, el, fill, icon, toast, timeAgo, clock, api, copyText, formatClock } from './ui.js';
import { AuthDialog } from './auth.js';
import { Board } from './board.js';
import { renderProfile } from './profile.js';
import { SubmitDialog } from './submit.js';
import { renderTournament, renderTournamentList } from './tournaments.js';

const OTT = window.OTT;
const COLOR = { 1: 'Red', 2: 'Blue' };
const REPLAY_STEP_MS = 520;
const VIEWS = ['home', 'match', 'user', 'tournaments', 'tournament', 'docs'];
// Views whose content is fetched from the API when shown.
const PAGE_VIEWS = new Set(['user', 'tournaments', 'tournament']);

// The fingerprint this page's code was loaded under: /v/<version>/js/app.js.
const LOADED_VERSION = (/\/v\/([0-9a-f]+)\//.exec(import.meta.url) || [])[1] || null;

const app = {
  matches: [],
  examples: [],
  config: null,
  me: null,
  route: { view: 'home', id: null },
  match: null,
};

const board = new Board($('#board'));
let dialog = null;
let auth = null;

// ---------- Account ----------

/** The seat (1 or 2) the logged-in user has in `summary`, or null. */
function mySeat(summary) {
  if (!app.me || !summary) return null;
  const player = summary.players.find((p) => p && p.userId === app.me.id);
  return player ? player.seat : null;
}

function isMe(player) {
  return Boolean(app.me && player && player.userId === app.me.id);
}

function renderAccount() {
  const box = $('#account');
  if (!app.me) {
    fill(box, el('button', { class: 'btn', type: 'button', onclick: () => auth.open() }, 'Log in'));
    return;
  }
  fill(
    box,
    el(
      'a',
      { class: 'user-chip', href: `#/user/${encodeURIComponent(app.me.username)}`, title: 'Your profile' },
      el('span', { class: 'avatar' }, app.me.username.slice(0, 1)),
      el('span', { class: 'uc-name' }, app.me.username),
    ),
    el('button', { class: 'icon-btn', type: 'button', title: 'Log out', 'aria-label': 'Log out', onclick: logout }, icon('logout')),
  );
}

function setMe(user) {
  app.me = user;
  renderAccount();
  renderLobby();
  if (app.match?.loaded) {
    renderHeader();
    renderPlayers();
    renderResult();
    renderOverlay();
  }
  if (PAGE_VIEWS.has(app.route.view)) renderPage();
}

async function logout() {
  await api('POST', '/api/auth/logout', {});
  setMe(null);
  toast('Logged out');
}

/** Runs `action` now when logged in, otherwise right after the user logs in. */
function whenLoggedIn(reason, action) {
  if (app.me) action();
  else auth.open({ reason, then: action });
}

function openNewMatch(template = null) {
  whenLoggedIn('Log in or create an account to submit a bot.', () => dialog.open({ me: app.me, mode: 'create', template }));
}

function openJoin(summary) {
  whenLoggedIn('Log in or create an account to join this match.', () => dialog.open({ me: app.me, mode: 'join', match: summary }));
}

// Finished games against other players change those players' profile records.
const seenResults = new Set();
let lobbyLoaded = false;

function noticeResults(list) {
  let changed = false;
  let mine = false;
  for (const m of list) {
    if (m.status !== 'finished' || !m.result?.rated || seenResults.has(m.id)) continue;
    seenResults.add(m.id);
    if (!lobbyLoaded) continue;
    changed = true;
    if (mySeat(m)) mine = true;
  }
  lobbyLoaded = true;
  if ((changed || mine) && app.route.view === 'user') renderPage();
}

function renderPage() {
  const context = { me: app.me, liveIds: new Set(app.matches.map((m) => m.id)) };
  const { view, id } = app.route;
  if (view === 'user') renderProfile($('#user-body'), id, context);
  if (view === 'tournaments') renderTournamentList($('#tournaments-body'), { onCreate: openNewTournament });
  if (view === 'tournament') renderTournament($('#tournament-body'), id, { ...context, actions: tournamentActions });
}

// ---------- Tournaments ----------

function openNewTournament() {
  whenLoggedIn('Log in or create an account to organize a tournament.', () => {
    const dialogEl = $('#tournament-dialog');
    $('#tournament-form').reset();
    $('#td-error').hidden = true;
    dialogEl.showModal();
    $('#tournament-form').elements.name.focus();
  });
}

async function postTournament(t, action) {
  const { ok, status, data } = await api('POST', `/api/tournaments/${t.id}/${action}`, {});
  if (status === 401) {
    setMe(null);
    auth.open({ reason: 'Your session has ended. Log in again to continue.' });
    return false;
  }
  if (!ok) toast(data?.error || 'Something went wrong.', 'bad');
  return ok;
}

const tournamentActions = {
  enter(t, update) {
    whenLoggedIn('Log in or create an account to enter this tournament.', () =>
      dialog.open({
        me: app.me,
        mode: 'tournament',
        tournament: t,
        update,
        onDone: ({ result }) => {
          toast(result === 'updated' ? 'Your bot was updated.' : `You're in ${t.name}!`);
          renderPage();
        },
      }),
    );
  },
  async leave(t) {
    if (!confirm(`Leave ${t.name}?`)) return;
    if (await postTournament(t, 'leave')) toast(`You left ${t.name}.`);
    renderPage();
  },
  async start(t) {
    const n = t.entrants.length;
    const matches = (n * (n - 1)) / 2;
    if (!confirm(`Start ${t.name} now? Entries close and ${matches} ${matches === 1 ? 'match' : 'matches'} (${matches * t.gamesPerMatch} games) will be played.`)) return;
    if (await postTournament(t, 'start')) toast(`${t.name} has started.`);
    renderPage();
  },
  async cancel(t) {
    if (!confirm(`Cancel ${t.name}? No more games will be played, and this can't be undone.`)) return;
    if (await postTournament(t, 'cancel')) toast(`${t.name} was cancelled.`);
    renderPage();
  },
};

function wireTournamentDialog() {
  const dialogEl = $('#tournament-dialog');
  const form = $('#tournament-form');
  for (const button of dialogEl.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialogEl.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#td-submit');
    submit.disabled = true;
    const { ok, status, data } = await api('POST', '/api/tournaments', { name: form.elements.name.value });
    submit.disabled = false;
    if (status === 401) {
      dialogEl.close();
      setMe(null);
      auth.open({ reason: 'Your session has ended. Log in again to continue.' });
      return;
    }
    if (!ok) {
      $('#td-error').textContent = data?.error || 'Something went wrong.';
      $('#td-error').hidden = false;
      return;
    }
    dialogEl.close();
    toast(`${data.tournament.name} is open for entries.`);
    location.hash = `#/tournament/${data.tournament.id}`;
  });
  for (const button of document.querySelectorAll('[data-action="new-tournament"]')) button.addEventListener('click', openNewTournament);
}

// Pushed by the server whenever a tournament changes; refresh whatever shows it.
let tournamentRefresh = null;
function onTournamentChanged({ id }) {
  const { view, id: shown } = app.route;
  if (!(view === 'tournaments' || (view === 'tournament' && shown === id))) return;
  clearTimeout(tournamentRefresh);
  tournamentRefresh = setTimeout(renderPage, 150);
}

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
      noticeResults(list);
    });
    on('snapshot', (snapshot) => loadSnapshot(snapshot));
    on('missing', ({ id }) => showMissing(id));
    on('update', (summary) => onUpdate(summary));
    on('move', (payload) => onMove(payload));
    on('log', (entry) => onLog(entry));
    on('tournament', (payload) => onTournamentChanged(payload));
    on('version', ({ version }) => onVersion(version));
    source.addEventListener('open', () => setConnection(true));
    source.addEventListener('error', () => setConnection(false));
  },
};

/**
 * The server was updated while this tab was open: load the new code. If a
 * dialog is open (someone may be typing), offer a reload instead.
 */
function onVersion(version) {
  if (!LOADED_VERSION || !version || version === LOADED_VERSION) return;
  let tried = null;
  try {
    tried = sessionStorage.getItem('ottv2.reloadedFor');
  } catch {
    /* storage unavailable */
  }
  const busy = document.querySelector('dialog[open]');
  if (!busy && tried !== version) {
    try {
      sessionStorage.setItem('ottv2.reloadedFor', version);
    } catch {
      /* storage unavailable */
    }
    location.reload();
    return;
  }
  if (document.getElementById('update-bar')) return;
  document.body.append(
    el(
      'div',
      { class: 'update-bar', id: 'update-bar', role: 'status' },
      el('span', {}, 'OTTv2 was updated.'),
      el('button', { class: 'btn sm primary', type: 'button', onclick: () => location.reload() }, 'Reload'),
    ),
  );
}

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
  const user = /^user\/([^/?#]+)/.exec(hash);
  if (user) return { view: 'user', id: decodeURIComponent(user[1]) };
  const tournament = /^tournament\/(\d+)/.exec(hash);
  if (tournament) return { view: 'tournament', id: Number(tournament[1]) };
  if (hash.startsWith('tournaments')) return { view: 'tournaments', id: null };
  if (hash.startsWith('docs')) return { view: 'docs', id: null };
  return { view: 'home', id: null };
}

const TITLES = {
  home: () => 'OTTv2 Arena',
  match: (id) => `Match #${id} · OTTv2`,
  user: (id) => `${id} · OTTv2`,
  tournaments: () => 'Tournaments · OTTv2',
  tournament: (id) => `Tournament #${id} · OTTv2`,
  docs: () => 'Bot library · OTTv2',
};

function onRoute() {
  const previous = app.route;
  app.route = parseRoute();
  const { view, id } = app.route;
  document.body.dataset.view = view;
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  const section = view === 'tournament' ? 'tournaments' : view;
  for (const link of document.querySelectorAll('[data-nav]')) link.classList.toggle('active', link.dataset.nav === section);

  if (view === 'match') {
    if (!app.match || app.match.id !== id) openMatch(id);
  } else {
    closeMatch();
  }
  if (PAGE_VIEWS.has(view)) renderPage();
  stream.connect(view === 'match' ? id : null);
  renderLobby();
  if (previous.view !== view || previous.id !== id) window.scrollTo(0, 0);
  document.title = TITLES[view](id);
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

  const seat = mySeat(summary);
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
    el('div', { class: 'mi-meta' }, seat ? `You're P${seat} · ${meta}` : meta),
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
    moveTimes: [],
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
  const { initial, moves, moveTimes, log, ...summary } = snapshot;
  m.summary = summary;
  m.initial = initial;
  m.moves = moves.slice();
  m.moveTimes = (moveTimes || []).slice();
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

function onMove({ record, ms, summary }) {
  const m = app.match;
  if (!m || m.id !== summary.id || !m.loaded) return;
  if (!m.replay || record.ply !== m.moves.length + 1) {
    resync();
    return;
  }
  m.summary = summary;
  m.moves.push(record);
  m.moveTimes.push(ms);
  try {
    m.replay.play(record);
  } catch {
    resync();
    return;
  }
  m.frames.push(m.replay.tokens());
  const list = $('#m-moves');
  if (m.moves.length === 1) list.replaceChildren();
  list.append(moveRow(record, ms));

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
  const seat = mySeat(summary);
  $('#m-title').replaceChildren(el('span', { class: 'mid' }, `#${summary.id} `), summary.name);

  const meta = [statusPill(summary)];
  const t = summary.tournament;
  if (t) {
    meta.push(
      el(
        'a',
        { class: 'meta-i', href: `#/tournament/${t.id}`, style: 'font-weight:600;text-decoration:none' },
        icon('trophy'),
        `${t.name} · Round ${t.round} · Game ${t.gameNumber} of ${t.gamesPerMatch}`,
      ),
    );
  }
  if (summary.players.some((p) => p?.house)) meta.push(el('span', {}, 'Practice'));
  if (summary.watchers) meta.push(el('span', { class: 'meta-i' }, icon('eye'), `${summary.watchers} watching`));
  if (summary.startedAt) meta.push(el('span', {}, `Started ${clock(summary.startedAt)}`));
  else meta.push(el('span', {}, `Created ${timeAgo(summary.createdAt)}`));
  if (seat) meta.push(el('span', {}, `You're P${seat} (${COLOR[seat]})`));
  $('#m-meta').replaceChildren(...meta);

  const download = $('#m-download');
  download.hidden = !summary.startedAt;
  download.href = `/api/matches/${summary.id}/log`;
  $('#m-cancel').hidden = !(seat && (summary.status === 'waiting' || summary.status === 'queued'));
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
  const winner = summary.result?.winner;

  for (const seat of [1, 2]) {
    const player = summary.players[seat - 1];
    const card = $(`#m-p${seat}`);
    card.classList.toggle('active', summary.status === 'running' && toMove === seat);
    const tags = [];
    if (isMe(player)) tags.push(el('span', { class: 'chip-you' }, 'You'));
    if (player?.house) tags.push(el('span', { class: 'chip-house' }, 'House'));
    if (winner === seat && summary.status === 'finished') tags.push(el('span', { class: `tc p${seat}`, title: 'Winner' }, icon('trophy', 'ui-i')));
    const name = !player
      ? 'Open seat'
      : player.userId
        ? el('a', { href: `#/user/${encodeURIComponent(player.name)}`, style: 'text-decoration:none' }, player.name)
        : player.name;
    fill(
      card,
      el('div', { class: 'pc-name' }, el('i', { class: `dot p${seat}` }), el('b', {}, name), ...tags),
      el('div', { class: 'pc-seat' }, `P${seat} · ${COLOR[seat]} · goal ${OTT.TARGETS[seat]}`),
      summary.clocks
        ? el(
            'div',
            { class: `pc-clock${summary.clocks[seat] < 30000 ? ' low' : ''}`, title: 'Thinking time left for this game' },
            `⏱ ${formatClock(summary.clocks[seat])} left`,
          )
        : null,
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
  const seat = mySeat(summary);
  let headline;
  if (summary.status === 'cancelled') headline = 'Match cancelled';
  else if (!result.winner) headline = 'Draw';
  else if (seat && !summary.players.every((p) => isMe(p))) headline = seat === result.winner ? 'Your bot won!' : 'Your bot lost';
  else headline = `${playerName(summary, result.winner)} wins`;


  box.className = `result${result.winner ? ` win${result.winner}` : ''}`;
  fill(
    box,
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
  const seat = mySeat(summary);

  if (summary.status === 'waiting') {
    const open = summary.players.findIndex((p) => !p) + 1;
    const host = summary.players[2 - open];
    const actions = seat
      ? [
          el('button', { class: 'btn primary', type: 'button', onclick: copyLink }, icon('link', 'ui-i'), 'Copy invite link'),
          el('button', { class: 'btn danger', type: 'button', onclick: cancelMatch }, 'Cancel match'),
        ]
      : [
          el(
            'button',
            { class: `btn p${open}`, type: 'button', onclick: () => openJoin(summary) },
            app.me ? `Join as P${open} (${COLOR[open]})` : `Log in to join as P${open}`,
          ),
          el('button', { class: 'btn', type: 'button', onclick: copyLink }, icon('link', 'ui-i'), 'Copy link'),
        ];
    showOverlay(
      el(
        'div',
        { class: 'overlay-card' },
        el('h3', {}, seat ? 'Waiting for an opponent' : `${host?.name || 'Someone'} is looking for an opponent`),
        el(
          'p',
          {},
          seat
            ? 'Your bot passed the check and is seated. Share the link. The match starts when another player joins with their bot.'
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

/** 300000 → "5 minutes", 90000 → "90 seconds". */
function describeDuration(ms) {
  if (ms % 60000 === 0) return `${ms / 60000} ${ms === 60000 ? 'minute' : 'minutes'}`;
  return `${Math.round(ms / 1000)} seconds`;
}

function moveRow(record, ms) {
  let outcome = null;
  if (record.outcome === 'win') outcome = el('span', { class: 'mv-out win' }, 'beats', icon(record.defender.type), record.defender.type);
  if (record.outcome === 'lose') outcome = el('span', { class: 'mv-out lose' }, 'lost to', icon(record.defender.type), record.defender.type);
  return el(
    'li',
    { class: `mv p${record.player}`, dataset: { ply: record.ply }, title: `Show the board after move ${record.ply}` },
    el('span', { class: 'mv-ply' }, record.ply),
    el('span', { class: 'mv-tok', title: record.type }, icon(record.type)),
    el(
      'span',
      { class: 'mv-text' },
      el('span', { class: 'mv-path' }, `${record.from} → ${record.to}`),
      outcome,
      // Only worth showing for moves that took a noticeable time.
      ms >= 100 ? el('span', { class: 'mv-ms', title: 'Thinking time for this move' }, `${(ms / 1000).toFixed(3)}s`) : null,
    ),
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
    list.replaceChildren(...m.moves.map((record, i) => moveRow(record, m.moveTimes[i])));
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
  if (!m || !mySeat(m.summary) || !confirm('Cancel this match? Your bot will leave the table.')) return;
  const { ok, data } = await api('POST', `/api/matches/${m.id}/cancel`, {});
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
          el('button', { class: 'btn sm primary', type: 'button', onclick: () => openNewMatch(example.id) }, 'Use as template'),
          el('a', { class: 'btn sm', href: `/library/examples/${example.id}.js?download=1` }, icon('download', 'ui-i'), 'Download'),
        ),
      ),
    ),
  );
  if (app.config) {
    for (const node of document.querySelectorAll('[data-config]')) {
      const value = app.config[node.dataset.config];
      node.textContent = node.dataset.config === 'gameTimeLimitMs' ? describeDuration(value) : value;
    }
  }
}

// ---------- Startup ----------

function onSubmitted({ match }) {
  toast(match.status === 'waiting' ? 'Your bot is seated. Waiting for an opponent.' : 'Your bot is in. The match is starting.');
  location.hash = `#/match/${match.id}`;
}

async function start() {
  const [examples, config, me] = await Promise.all([api('GET', '/api/examples'), api('GET', '/api/config'), api('GET', '/api/auth/me')]);
  app.examples = examples.ok ? examples.data : [];
  app.config = config.ok ? config.data : null;
  app.me = me.ok ? me.data.user : null;

  auth = new AuthDialog({
    onLogin: (user, mode) => {
      setMe(user);
      toast(mode === 'register' ? `Welcome, ${user.username}!` : `Logged in as ${user.username}`);
    },
  });
  dialog = new SubmitDialog({
    examples: app.examples,
    config: app.config,
    onSubmitted,
    onLoggedOut: () => {
      setMe(null);
      auth.open({ reason: 'Your session has ended. Log in again to continue.' });
    },
  });
  renderAccount();
  for (const button of document.querySelectorAll('[data-action="new-match"]')) {
    button.addEventListener('click', () => openNewMatch());
  }
  for (const link of document.querySelectorAll('[data-jump]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById(link.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  wireMatchControls();
  wireTournamentDialog();
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
