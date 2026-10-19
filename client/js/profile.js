// A player's profile: their record and recent games.

import { el, fill, api, timeAgo } from './ui.js';

const REASONS = {
  target: 'reached the corner',
  eliminated: 'no tokens left',
  'no-moves': 'no legal moves',
  'turn-limit': 'move limit',
  forfeit: 'forfeit',
  error: 'server error',
};

function avatar(name, className = 'avatar') {
  return el('span', { class: className, 'aria-hidden': 'true' }, name.slice(0, 1));
}

export function playerLink(username) {
  return el('a', { class: 'player-link', href: `#/user/${encodeURIComponent(username)}` }, avatar(username), username);
}

function winRate(user) {
  return user.games ? `${Math.round((user.wins / user.games) * 100)}%` : '–';
}

/** Fills `root` with a player's profile. `liveIds` are games still on the server, which can be opened. */
export async function renderProfile(root, username, { me, liveIds }) {
  fill(root, el('div', { class: 'empty-card' }, el('span', { class: 'spinner' })));
  const { ok, status, data } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  if (!ok) {
    fill(
      root,
      el(
        'div',
        { class: 'empty-card' },
        el('b', {}, status === 404 ? 'Player not found' : 'Could not load this profile'),
        el('p', {}, data?.error || ''),
        el('p', {}, el('a', { href: '#/tournaments' }, 'See the tournaments')),
      ),
    );
    return;
  }
  const { user, matches } = data;
  const isMe = me && me.id === user.id;

  fill(
    root,
    el(
      'div',
      { class: 'profile-head' },
      avatar(user.username, 'avatar lg'),
      el(
        'div',
        {},
        el('h1', {}, user.username, isMe ? el('span', { class: 'chip-you', style: 'margin-left:10px;vertical-align:middle' }, 'You') : null),
        el('p', {}, `Joined ${new Date(user.createdAt).toLocaleDateString()}`),
      ),
    ),
    el(
      'div',
      { class: 'stat-grid' },
      [
        ['Games', user.games],
        ['Wins', user.wins],
        ['Draws', user.draws],
        ['Losses', user.losses],
        ['Win rate', winRate(user)],
      ].map(([label, value]) => el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value))),
    ),
    el('p', { class: 'table-note', style: 'margin:-14px 2px 22px' }, 'Counts games against other players. Games against house bots or yourself are practice.'),
    el('h2', { class: 'section-title' }, 'Recent games'),
    matches.length
      ? el(
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
                el('th', {}, 'Result'),
                el('th', {}, 'Opponent'),
                el('th', { class: 'hide-sm' }, 'Game'),
                el('th', { class: 'hide-md' }, 'How'),
                el('th', { class: 'num hide-sm' }, 'When'),
              ),
            ),
            el(
              'tbody',
              {},
              matches.map((m) => {
                const label = m.result === 'win' ? 'Won' : m.result === 'loss' ? 'Lost' : 'Draw';
                const title = `#${m.id} ${m.name}`;
                return el(
                  'tr',
                  {},
                  el('td', {}, el('span', { class: `res ${m.result || 'draw'}` }, label)),
                  el(
                    'td',
                    {},
                    m.opponent.registered ? playerLink(m.opponent.name) : el('span', { class: 'muted' }, m.opponent.name),
                    m.rated ? null : el('span', { class: 'practice', style: 'margin-left:8px' }, 'practice'),
                  ),
                  el('td', { class: 'hide-sm' }, liveIds.has(m.id) ? el('a', { href: `#/match/${m.id}` }, title) : title),
                  el('td', { class: 'hide-md muted' }, `${REASONS[m.reason] || m.reason} · ${m.plies} moves`),
                  el('td', { class: 'num hide-sm muted' }, timeAgo(m.finishedAt)),
                );
              }),
            ),
          ),
        )
      : el('div', { class: 'empty-card' }, el('b', {}, 'No games yet'), el('p', {}, isMe ? 'Submit a bot to play your first game.' : '')),
  );
}
