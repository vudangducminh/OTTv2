// The tournament list and the page for one tournament: entrants, standings and match results.

import { el, fill, api, icon, timeAgo, clock } from './ui.js';
import { playerLink } from './profile.js';

const REASONS = {
  target: 'reached the corner',
  eliminated: 'no tokens left',
  'no-moves': 'no legal moves',
  'turn-limit': 'move limit',
  forfeit: 'forfeit',
  error: 'server error',
};

function statusPill(t) {
  if (t.status === 'registration') return el('span', { class: 'pill waiting' }, 'Open for entries');
  if (t.status === 'running') return el('span', { class: 'pill live' }, 'Live');
  if (t.status === 'cancelled') return el('span', { class: 'pill' }, 'Cancelled');
  return el('span', { class: 'pill' }, 'Finished');
}

function progressBar(done, total) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${percent}%` }));
}

function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

// ---------- List ----------

function card(t) {
  let detail;
  if (t.status === 'running') {
    detail = [el('div', { class: 'meta' }, `${t.finishedMatches} of ${t.totalMatches} matches played`), progressBar(t.finishedMatches, t.totalMatches)];
  } else if (t.status === 'finished' && t.champion) {
    detail = el('span', { class: 'champion' }, icon('trophy'), `Champion: ${t.champion.username}`);
  } else if (t.status === 'registration') {
    detail = el('div', { class: 'meta' }, 'Enter with your bot before it starts.');
  }
  return el(
    'a',
    { class: 't-card', href: `#/tournament/${t.id}` },
    el('div', { class: 't-card-top' }, el('h3', {}, t.name), statusPill(t)),
    el('div', { class: 'meta' }, `${t.entrants} ${t.entrants === 1 ? 'player' : 'players'}${t.organizer ? ` · by ${t.organizer.username}` : ''} · ${timeAgo(t.createdAt)}`),
    detail,
  );
}

export async function renderTournamentList(root, { onCreate }) {
  const { ok, data } = await api('GET', '/api/tournaments');
  if (!ok) {
    fill(root, el('div', { class: 'empty-card' }, el('b', {}, 'Tournaments are not available.'), el('p', {}, data?.error || '')));
    return;
  }
  const list = data.tournaments;
  if (!list.length) {
    fill(
      root,
      el(
        'div',
        { class: 'empty-card' },
        el('b', {}, 'No tournaments yet'),
        el('p', {}, 'Create one, let players enter with their bots, then start it.'),
        el('p', {}, el('button', { class: 'btn primary', type: 'button', onclick: onCreate }, 'New tournament')),
      ),
    );
    return;
  }
  const groups = [
    ['Live', list.filter((t) => t.status === 'running')],
    ['Open for entries', list.filter((t) => t.status === 'registration')],
    ['Past tournaments', list.filter((t) => t.status === 'finished' || t.status === 'cancelled')],
  ].filter(([, items]) => items.length);
  fill(
    root,
    ...groups.map(([title, items]) =>
      el('section', { class: 't-section' }, el('h2', { class: 'section-title' }, title), el('div', { class: 't-grid' }, items.map(card))),
    ),
  );
}

// ---------- One tournament ----------

// Rounds the viewer opened or closed by hand, per tournament.
const toggledRounds = new Map();
let renderCounter = 0;

function gameChip(t, match, game, liveIds) {
  const name = (side) => match[side].username;
  const colour = (side) => (game.red === side ? 'Red' : 'Blue');
  let className = 'gchip';
  let label = String(game.number);
  let title = `Game ${game.number}: ${name('a')} plays ${colour('a')}, ${name('b')} plays ${colour('b')}`;
  if (game.winner === 'a' || game.winner === 'b') {
    const loser = game.winner === 'a' ? 'b' : 'a';
    className += game.red === game.winner ? ' won-red' : ' won-blue';
    // Points at the winner's name: left player A, right player B.
    label = icon(game.winner === 'a' ? 'prev' : 'next');
    title = `Game ${game.number}: ${name(game.winner)} (${colour(game.winner)}) beat ${name(loser)} (${colour(loser)}) · ${REASONS[game.reason] || game.reason}, ${game.plies} moves`;
  } else if (game.winner === 'draw') {
    className += ' draw';
    label = '=';
    title = `Game ${game.number}: draw · ${REASONS[game.reason] || game.reason}`;
  } else if (game.live) {
    className += ' live';
    title += ' · playing now';
  } else if (game.queued) {
    className += ' queued';
    title += ' · waiting for a free table on the server';
  }
  const canOpen = game.gameId && (game.live || game.queued || liveIds.has(game.gameId));
  return canOpen
    ? el('a', { class: className, href: `#/match/${game.gameId}`, title: `${title} · click to watch` }, label)
    : el('span', { class: className, title }, label);
}

function matchRow(t, m, liveIds) {
  const finished = m.status === 'finished';
  const outcome = (side) => {
    if (!finished || m.aWins === m.bWins) return '';
    const aAhead = m.aWins > m.bWins;
    return (side === 'a') === aAhead ? ' won' : ' lost';
  };
  const live = m.games.filter((g) => g.live);
  let status;
  if (finished) status = m.aWins === m.bWins ? 'Draw' : `${(m.aWins > m.bWins ? m.a : m.b).username} wins`;
  else if (live.length) status = el('a', { href: `#/match/${live[0].gameId}` }, live.length > 1 ? `${live.length} games live · watch →` : `Watch game ${live[0].number} →`);
  else if (m.games.some((g) => g.queued)) status = 'Waiting for a table';
  else if (m.gamesPlayed > 0) status = 'In progress';
  else status = t.status === 'running' ? 'Starting' : 'Not played';
  return el(
    'div',
    { class: 't-match' },
    el('div', { class: `side a${outcome('a')}` }, el('a', { href: `#/user/${encodeURIComponent(m.a.username)}` }, m.a.username)),
    el('div', { class: `score${m.gamesPlayed ? '' : ' pending'}`, title: m.draws ? `${m.draws} drawn ${m.draws === 1 ? 'game' : 'games'}` : '' }, m.gamesPlayed ? `${m.aWins} – ${m.bWins}` : 'vs'),
    el('div', { class: `side b${outcome('b')}` }, el('a', { href: `#/user/${encodeURIComponent(m.b.username)}` }, m.b.username)),
    el('div', { class: 'games' }, m.games.map((g) => gameChip(t, m, g, liveIds))),
    el('div', { class: 't-status' }, status),
  );
}

function standingsTable(t, me) {
  return [
    el(
      'div',
      { class: 'table-card' },
      el(
        'table',
        { class: 'data-table' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, '#'),
            el('th', {}, 'Player'),
            el('th', { class: 'num', title: 'Matches played' }, 'MP'),
            el('th', { class: 'num', title: 'Matches won' }, 'W'),
            el('th', { class: 'num', title: 'Matches drawn' }, 'D'),
            el('th', { class: 'num', title: 'Matches lost' }, 'L'),
            el('th', { class: 'num hide-sm', title: 'Games won' }, 'GW'),
            el('th', { class: 'num hide-sm', title: 'Games lost' }, 'GL'),
            el('th', { class: 'num', title: 'Game difference: games won minus games lost' }, 'GD'),
            el('th', { class: 'num pts', title: 'Points' }, 'Pts'),
          ),
        ),
        el(
          'tbody',
          {},
          t.standings.map((row) =>
            el(
              'tr',
              { class: me && me.id === row.userId ? 'me' : '' },
              el('td', {}, el('span', { class: `rank-badge${t.status === 'finished' && row.rank <= 3 ? ` r${row.rank}` : ''}` }, row.rank)),
              el('td', {}, playerLink(row.username)),
              el('td', { class: 'num' }, row.mp),
              el('td', { class: 'num' }, row.w),
              el('td', { class: 'num' }, row.d),
              el('td', { class: 'num' }, row.l),
              el('td', { class: 'num hide-sm' }, row.gw),
              el('td', { class: 'num hide-sm' }, row.gl),
              el('td', { class: `num gd${row.gd > 0 ? ' up' : row.gd < 0 ? ' down' : ''}` }, signed(row.gd)),
              el('td', { class: 'num pts' }, row.pts),
            ),
          ),
        ),
      ),
    ),
    el(
      'p',
      { class: 'table-note' },
      `A match is ${t.gamesPerMatch} games. Match win ${t.points.win} pts, draw ${t.points.draw}, loss ${t.points.loss}. GD = games won − games lost. Ties are broken by GD, then games won. Only finished matches count.`,
    ),
  ];
}

function roundsSection(t, liveIds) {
  const toggled = toggledRounds.get(t.id) || new Map();
  toggledRounds.set(t.id, toggled);
  const legend = el(
    'div',
    { class: 'legend' },
    el('span', {}, 'The arrow points at the winner of each game:'),
    el('span', {}, el('span', { class: 'gchip won-red' }, icon('prev')), 'won as Red'),
    el('span', {}, el('span', { class: 'gchip won-blue' }, icon('next')), 'won as Blue'),
    el('span', {}, el('span', { class: 'gchip draw' }, '='), 'drawn game'),
    el('span', {}, el('span', { class: 'gchip live' }, '3'), 'playing now'),
    t.queuedGames ? el('span', {}, el('span', { class: 'gchip queued' }, '3'), 'waiting for a free table') : null,
    el('span', {}, el('span', { class: 'gchip' }, '4'), 'not played yet'),
  );
  return [
    legend,
    ...t.rounds.map((r) => {
      const done = r.matches.every((m) => m.status === 'finished');
      const started = r.matches.some((m) => m.status !== 'pending');
      const label = done ? 'Finished' : started && t.status === 'running' ? 'In progress' : t.status === 'running' ? 'Starting' : 'Not played';
      // All rounds play at once, so show them all unless there are many.
      const openByDefault = t.rounds.length <= 4 || (t.status === 'running' && !done);
      const details = el(
        'details',
        { class: 'round', open: toggled.has(r.round) ? toggled.get(r.round) : openByDefault },
        el('summary', {}, `Round ${r.round}`, el('span', { class: 'muted' }, `· ${label}`)),
        r.matches.map((m) => matchRow(t, m, liveIds)),
      );
      details.addEventListener('toggle', () => toggled.set(r.round, details.open));
      return details;
    }),
  ];
}

/**
 * Fills `root` with tournament `id`. `actions` holds enter/leave/start/cancel
 * callbacks; `liveIds` are games still on the server (they can be opened).
 */
export async function renderTournament(root, id, { me, liveIds, actions }) {
  const ticket = ++renderCounter;
  if (root.dataset.tournament !== String(id)) {
    root.dataset.tournament = String(id);
    fill(root, el('div', { class: 'empty-card' }, el('span', { class: 'spinner' })));
  }
  const { ok, status, data } = await api('GET', `/api/tournaments/${id}`);
  if (ticket !== renderCounter) return; // a newer render is on its way
  if (!ok) {
    fill(
      root,
      el(
        'div',
        { class: 'empty-card' },
        el('b', {}, status === 404 ? 'Tournament not found' : 'Could not load this tournament'),
        el('p', {}, data?.error || ''),
        el('p', {}, el('a', { href: '#/tournaments' }, 'All tournaments')),
      ),
    );
    return;
  }
  const t = data;
  const isOrganizer = me && t.organizer && t.organizer.id === me.id;
  const entered = me && t.entrants.some((e) => e.id === me.id);

  const buttons = [];
  if (t.status === 'registration') {
    if (!entered) buttons.push(el('button', { class: 'btn primary', type: 'button', onclick: () => actions.enter(t, false) }, me ? 'Enter with your bot' : 'Log in to enter'));
    else {
      buttons.push(el('button', { class: 'btn', type: 'button', onclick: () => actions.enter(t, true) }, 'Update my bot'));
      buttons.push(el('button', { class: 'btn ghost', type: 'button', onclick: () => actions.leave(t) }, 'Leave'));
    }
    if (isOrganizer) {
      buttons.push(
        el(
          'button',
          {
            class: 'btn p1',
            type: 'button',
            disabled: t.entrants.length < t.minPlayers,
            title: t.entrants.length < t.minPlayers ? `Needs at least ${t.minPlayers} players` : '',
            onclick: () => actions.start(t),
          },
          'Start tournament',
        ),
      );
    }
  }
  if (isOrganizer && (t.status === 'registration' || t.status === 'running')) {
    buttons.push(el('button', { class: 'btn danger', type: 'button', onclick: () => actions.cancel(t) }, 'Cancel tournament'));
  }

  const when = t.startedAt ? `started ${clock(t.startedAt)}` : `created ${timeAgo(t.createdAt)}`;
  const head = el(
    'div',
    { class: 't-head' },
    el(
      'div',
      {},
      el('p', { class: 'eyebrow' }, el('a', { href: '#/tournaments', style: 'text-decoration:none' }, '← Tournaments')),
      el('h1', {}, t.name, statusPill(t)),
      el('p', { class: 'meta' }, `${t.organizer ? `Organized by ${t.organizer.username} · ` : ''}${t.entrants.length} ${t.entrants.length === 1 ? 'player' : 'players'} · ${when}`),
      el(
        'div',
        { class: 't-format' },
        el('span', {}, 'Round robin'),
        el('span', {}, `${t.gamesPerMatch} games per match, colours alternate`),
        el('span', {}, `Win ${t.points.win} · Draw ${t.points.draw} · Loss ${t.points.loss}`),
      ),
    ),
    buttons.length ? el('div', { class: 't-actions' }, buttons) : null,
  );

  const parts = [head];
  if (t.status === 'finished' && t.standings.length) {
    const champions = t.standings.filter((row) => row.rank === 1);
    const top = champions[0];
    parts.push(
      el(
        'div',
        { class: 't-banner' },
        el('span', { class: 'r-icon' }, icon('trophy')),
        el(
          'div',
          {},
          el('strong', {}, champions.length > 1 ? `Shared first place: ${champions.map((c) => c.username).join(', ')}` : `${top.username} wins the tournament!`),
          el('span', {}, `${top.pts} points, GD ${signed(top.gd)}, ${top.w} won · ${top.d} drawn · ${top.l} lost`),
        ),
      ),
    );
  }
  if (t.status === 'running') {
    const matches = t.rounds.flatMap((r) => r.matches);
    const done = matches.filter((m) => m.status === 'finished').length;
    const waiting = t.queuedGames ? ` · ${t.queuedGames} waiting for a free table` : '';
    parts.push(
      el(
        'div',
        { class: 't-progress' },
        el('span', {}, `${done} of ${matches.length} matches finished · ${t.liveGames} ${t.liveGames === 1 ? 'game' : 'games'} playing now${waiting}`),
        progressBar(done, matches.length),
      ),
    );
  }

  if (t.status === 'registration' || !t.rounds.length) {
    parts.push(
      el('h2', { class: 'section-title' }, `Entrants (${t.entrants.length}/${t.maxPlayers})`),
      t.entrants.length
        ? el(
            'div',
            { class: 'entrants' },
            t.entrants.map((e) =>
              el(
                'div',
                { class: 'entrant' },
                el('span', { class: 'avatar' }, e.username.slice(0, 1)),
                el('div', {}, el('a', { href: `#/user/${encodeURIComponent(e.username)}`, style: 'text-decoration:none;font-weight:600' }, e.username), el('small', {}, `Entered ${timeAgo(e.joinedAt)}`)),
              ),
            ),
          )
        : el('div', { class: 'empty-card' }, el('b', {}, 'No entrants yet'), el('p', {}, 'Players enter by submitting a bot.')),
      t.status === 'registration'
        ? el('p', { class: 'table-note' }, `The organizer starts the tournament once at least ${t.minPlayers} players are in. Bots can be updated until then.`)
        : null,
    );
  } else {
    parts.push(el('h2', { class: 'section-title' }, 'Standings'), ...standingsTable(t, me));
    parts.push(el('h2', { class: 'section-title', style: 'margin-top:28px' }, 'Matches'), ...roundsSection(t, liveIds));
  }
  fill(root, ...parts);
}
