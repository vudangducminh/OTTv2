// The ranking table and player profile pages.

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

function delta(before, after) {
  if (before === null || after === null || before === undefined || after === undefined) return el('span', { class: 'practice' }, 'practice');
  const change = after - before;
  return el('span', { class: `delta ${change >= 0 ? 'up' : 'down'}` }, `${change >= 0 ? '+' : ''}${change}`);
}

function winRate(user) {
  return user.games ? `${Math.round((user.wins / user.games) * 100)}%` : '–';
}

function loading(root) {
  fill(root, el('div', { class: 'empty-card' }, el('span', { class: 'spinner' })));
}

/** Fills `root` with the leaderboard. `me` is the logged-in user or null. */
export async function renderRanking(root, { me }) {
  if (!root.childElementCount) loading(root);
  const { ok, data } = await api('GET', '/api/leaderboard');
  if (!ok) {
    fill(root, el('div', { class: 'empty-card' }, el('b', {}, 'The ranking is not available.'), el('p', {}, data?.error || '')));
    return;
  }
  const players = data.players;
  if (!players.length) {
    fill(
      root,
      el(
        'div',
        { class: 'empty-card' },
        el('b', {}, 'No rated games yet'),
        el('p', {}, 'The ranking fills up once two players with accounts play each other.'),
      ),
    );
    return;
  }
  fill(
    root,
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
            el('th', {}, 'Rank'),
            el('th', {}, 'Player'),
            el('th', { class: 'num' }, 'Rating'),
            el('th', { class: 'num hide-sm' }, 'Games'),
            el('th', { class: 'num' }, 'W'),
            el('th', { class: 'num' }, 'L'),
            el('th', { class: 'num hide-sm' }, 'D'),
            el('th', { class: 'num hide-md' }, 'Win rate'),
          ),
        ),
        el(
          'tbody',
          {},
          players.map((p) =>
            el(
              'tr',
              { class: me && me.id === p.id ? 'me' : '' },
              el('td', {}, el('span', { class: `rank-badge${p.rank <= 3 ? ` r${p.rank}` : ''}` }, p.rank)),
              el('td', {}, playerLink(p.username)),
              el('td', { class: 'num rating' }, p.rating),
              el('td', { class: 'num hide-sm' }, p.games),
              el('td', { class: 'num' }, p.wins),
              el('td', { class: 'num' }, p.losses),
              el('td', { class: 'num hide-sm' }, p.draws),
              el('td', { class: 'num hide-md' }, winRate(p)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Fills `root` with a player's profile. `liveIds` are matches still on the server, which can be opened. */
export async function renderProfile(root, username, { me, liveIds }) {
  loading(root);
  const { ok, status, data } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  if (!ok) {
    fill(
      root,
      el(
        'div',
        { class: 'empty-card' },
        el('b', {}, status === 404 ? 'Player not found' : 'Could not load this profile'),
        el('p', {}, data?.error || ''),
        el('p', {}, el('a', { href: '#/ranking' }, 'See the ranking')),
      ),
    );
    return;
  }
  const { user, matches } = data;
  const isMe = me && me.id === user.id;
  const standing = user.rank ? `Rank #${user.rank} of ${user.ranked}` : 'Unranked until the first rated game';

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
        el('p', {}, `${standing} · joined ${new Date(user.createdAt).toLocaleDateString()}`),
      ),
    ),
    el(
      'div',
      { class: 'stat-grid' },
      [
        ['Rating', user.rating],
        ['Rated games', user.games],
        ['Wins', user.wins],
        ['Losses', user.losses],
        ['Draws', user.draws],
        ['Win rate', winRate(user)],
      ].map(([label, value]) => el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value))),
    ),
    el('h2', { class: 'section-title' }, 'Recent matches'),
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
                el('th', { class: 'hide-sm' }, 'Match'),
                el('th', { class: 'hide-md' }, 'How'),
                el('th', { class: 'num' }, 'Rating'),
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
                  el('td', {}, m.opponent.registered ? playerLink(m.opponent.name) : el('span', { class: 'muted' }, m.opponent.name)),
                  el('td', { class: 'hide-sm' }, liveIds.has(m.id) ? el('a', { href: `#/match/${m.id}` }, title) : title),
                  el('td', { class: 'hide-md muted' }, `${REASONS[m.reason] || m.reason} · ${m.plies} moves`),
                  el('td', { class: 'num' }, m.rated ? el('span', {}, `${m.ratingAfter} `, delta(m.ratingBefore, m.ratingAfter)) : delta(null, null)),
                  el('td', { class: 'num hide-sm muted' }, timeAgo(m.finishedAt)),
                );
              }),
            ),
          ),
        )
      : el('div', { class: 'empty-card' }, el('b', {}, 'No matches yet'), el('p', {}, isMe ? 'Submit a bot to play your first match.' : '')),
  );
}
