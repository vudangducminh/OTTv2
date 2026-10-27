// The dialog for submitting a bot, either to open a new match or to join one.

import { $, el, fill, icon, api, store, formatClock } from './ui.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BLANK = `const OTT = require('ottv2');

// Called once per turn. Return one of game.legalMoves(),
// or a string like 'c3 d4'.
function move(game) {
  const moves = game.legalMoves();

  // Your strategy here. For example, capture when you can:
  const capture = moves.find((m) => m.outcome === 'win');
  if (capture) return capture;

  return OTT.random(moves);
}
`;

export class SubmitDialog {
  /** onLoggedOut runs when the server says the session has ended. */
  constructor({ examples, config, onSubmitted, onLoggedOut }) {
    this.examples = examples;
    this.config = config;
    this.onSubmitted = onSubmitted;
    this.onLoggedOut = onLoggedOut;
    this.dialog = $('#submit-dialog');
    this.form = $('#submit-form');
    this.code = $('#sd-code');
    this.gutter = $('#sd-gutter');
    this.check = $('#sd-check');
    this.submitButton = $('#sd-submit');
    this.testButton = $('#sd-test');
    this.mode = 'create';
    this.match = null;
    this.busy = false;

    this._buildSelects();
    this._wireEditor();

    for (const button of this.dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => this.close());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._submit();
    });
    this.testButton.addEventListener('click', () => this._test());
    $('#sd-file').addEventListener('change', (event) => this._upload(event.target));
    $('#sd-template').addEventListener('change', (event) => {
      const id = event.target.value;
      event.target.value = '';
      if (id) this._loadTemplate(id);
    });
    window.addEventListener('hashchange', () => this.close());

    const limits = $('#sd-limits');
    if (config) limits.textContent = `${Math.round(config.gameTimeLimitMs / 60000)} min of thinking time per game, ${config.botMemoryMb} MB memory.`;
  }

  setExamples(examples) {
    this.examples = examples;
    this._buildSelects();
  }

  /**
   * mode: 'create' | 'join'. For join, pass the match summary. `me` is the
   * logged-in user; the server seats you under that username.
   */
  open({ me, mode = 'create', match = null, template = null, tournament = null, update = false, onDone = null }) {
    this.mode = mode;
    this.match = match;
    this.tournament = tournament;
    this.onDone = onDone;
    const seat = mode === 'join' ? match.players.findIndex((p) => !p) + 1 : 1;
    this.seat = seat;
    const color = seat === 1 ? 'Red' : 'Blue';
    const host = mode === 'join' ? match.players[2 - seat] : null;

    const titles = {
      create: 'New match',
      join: match ? `Join match #${match.id} · ${match.name}` : '',
      tournament: tournament ? (update ? `Update your bot for ${tournament.name}` : `Enter ${tournament.name}`) : '',
    };
    const subtitles = {
      create: `You'll play as P1 (Red) and move first. Wait for another player to join, or practise against a house bot right away.`,
      join: host
        ? `You'll play as P${seat} (${color}) against ${host.name}. It starts as soon as your bot is accepted.`
        : '',
      tournament: tournament
        ? `This bot plays every other entrant in a ${tournament.gamesPerMatch}-game match, twice as Red and twice as Blue. Match win ${tournament.points.win} points, draw ${tournament.points.draw}, loss ${tournament.points.loss}. You can update it until the tournament starts.`
        : '',
    };
    $('#sd-title').textContent = titles[mode];
    $('#sd-sub').textContent = subtitles[mode];
    fill(
      $('#sd-as'),
      el('span', { class: 'avatar', style: 'width:24px;height:24px;font-size:11px' }, me.username.slice(0, 1)),
      el('span', {}, 'Playing as ', el('b', {}, me.username)),
    );
    $('#sd-create-fields').hidden = mode !== 'create';
    this.submitButton.textContent = { create: 'Create match', join: `Join as P${seat}`, tournament: update ? 'Save bot' : 'Enter tournament' }[mode];
    this.submitButton.className = `btn ${mode === 'join' ? `p${seat}` : 'primary'}`;
    this.form.elements.name.placeholder = `Optional, e.g. ${me.username}'s match`;

    if (template) this._setCode(this._example(template)?.code || BLANK);
    else if (!this.code.value) this._setCode(store.get('ottv2.draft', null) || this._example('greedy')?.code || BLANK);
    this._hideCheck();
    this._setBusy(false);

    if (!this.dialog.open) this.dialog.showModal();
    this.code.focus();
  }

  close() {
    this._stopCheck({ quiet: true });
    if (this.dialog.open) this.dialog.close();
  }

  _example(id) {
    return this.examples.find((e) => e.id === id) || null;
  }

  _buildSelects() {
    const template = $('#sd-template');
    template.replaceChildren(
      el('option', { value: '' }, 'Load an example…'),
      ...this.examples.map((e) => el('option', { value: e.id, title: e.description }, `Example: ${e.name}`)),
      el('option', { value: '__blank' }, 'Blank template'),
    );
    const opponent = $('#sd-opponent');
    opponent.replaceChildren(
      el('option', { value: '' }, 'Another player (wait in the lobby)'),
      ...this.examples.map((e) => el('option', { value: e.id, title: e.description }, `House bot: ${e.name} (practice)`)),
    );
  }

  _wireEditor() {
    const area = this.code;
    let saveTimer = null;
    area.addEventListener('input', () => {
      this._renderGutter();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => store.set('ottv2.draft', area.value), 300);
    });
    area.addEventListener('scroll', () => {
      this.gutter.scrollTop = area.scrollTop;
    });
    area.addEventListener('keydown', (event) => {
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      } else if (event.key === 'Enter' && !event.isComposing) {
        // Keep the indentation of the current line.
        const before = area.value.slice(0, area.selectionStart);
        const line = before.slice(before.lastIndexOf('\n') + 1);
        let indent = /^\s*/.exec(line)[0];
        if (/[{[(]\s*$/.test(line)) indent += '  ';
        event.preventDefault();
        area.setRangeText(`\n${indent}`, area.selectionStart, area.selectionEnd, 'end');
        area.dispatchEvent(new Event('input'));
      }
    });
  }

  _setCode(code) {
    this.code.value = code;
    this.code.scrollTop = 0;
    this._renderGutter();
    store.set('ottv2.draft', code);
  }

  _renderGutter() {
    const lines = this.code.value.split('\n').length;
    let text = '';
    for (let i = 1; i <= lines; i++) text += `${i}\n`;
    this.gutter.textContent = text;
    this.gutter.scrollTop = this.code.scrollTop;
  }

  _loadTemplate(id) {
    const code = id === '__blank' ? BLANK : this._example(id)?.code;
    if (!code) return;
    const current = this.code.value.trim();
    const isTemplate = !current || current === BLANK.trim() || this.examples.some((e) => e.code.trim() === current);
    if (!isTemplate && !confirm('Replace your current code with this example?')) return;
    this._setCode(code);
    this._hideCheck();
  }

  _upload(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size > (this.config?.maxCodeBytes || 100 * 1024)) {
      this._showCheck('bad', 'That file is too large for a bot.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this._setCode(String(reader.result));
      this._hideCheck();
    };
    reader.readAsText(file);
  }

  _setBusy(busy, label) {
    this.busy = busy;
    this.submitButton.disabled = busy;
    this.testButton.disabled = busy;
    if (busy && label) this._showCheck('busy', label);
  }

  _hideCheck() {
    this.check.hidden = true;
    this.check.replaceChildren();
  }

  /** `action`: an optional { label, onClick } button, e.g. to stop a running check. */
  _showCheck(kind, title, logs = [], action = null) {
    const iconName = kind === 'ok' ? 'check' : kind === 'bad' ? 'alert' : null;
    this.check.className = `check ${kind}`;
    fill(
      this.check,
      el(
        'div',
        { class: 'check-title' },
        iconName ? icon(iconName) : el('span', { class: 'spinner', style: 'width:16px;height:16px;margin:0' }),
        el('span', {}, title),
        action ? el('button', { class: 'btn sm', type: 'button', onclick: action.onClick }, action.label) : null,
      ),
      logs.length ? el('pre', {}, `console output:\n${logs.join('\n')}`) : null,
    );
    this.check.hidden = false;
  }

  /**
   * Runs the bot's first move on a test board on the server, with the same
   * clock it gets in a game, and shows the clock while it thinks. Resolves
   * with the finished check, or null if it was stopped or couldn't run.
   */
  async _runCheck(code) {
    const started = await api('POST', '/api/check', { code, seat: this.seat });
    if (this._sessionEnded(started.status)) return null;
    if (!started.ok) {
      this._showCheck('bad', started.data?.error || 'The check could not start.');
      return null;
    }
    let check = started.data.check;
    const id = check.id;
    this.checkId = id;
    const since = Date.now() - check.elapsedMs;
    const show = () => {
      if (this.checkId !== id) return;
      this._showCheck(
        'busy',
        `Running your bot's first move on a test board… ⏱ ${formatClock(Date.now() - since)} of its ${formatClock(check.limitMs)} clock`,
        [],
        { label: 'Stop', onClick: () => this._stopCheck() },
      );
    };
    show();
    const timer = setInterval(show, 250);
    try {
      while (check.status === 'running') {
        await sleep(400);
        if (this.checkId !== id) return null; // stopped
        const polled = await api('GET', `/api/check/${id}`);
        if (this._sessionEnded(polled.status)) return null;
        if (!polled.ok) {
          this._showCheck('bad', polled.data?.error || 'Lost track of the check.');
          return null;
        }
        check = polled.data.check;
      }
    } finally {
      clearInterval(timer);
      if (this.checkId === id) this.checkId = null;
    }
    return check.cancelled ? null : check;
  }

  _stopCheck({ quiet = false } = {}) {
    const id = this.checkId;
    if (!id) return;
    this.checkId = null;
    api('POST', `/api/check/${id}/stop`, {});
    if (quiet) return;
    this._setBusy(false);
    this._showCheck('bad', 'Stopped. Your bot was not submitted.');
  }

  _readForm() {
    const form = this.form.elements;
    const code = this.code.value;
    if (!code.trim()) {
      this._showCheck('bad', 'Paste or write your bot code first.');
      this.code.focus();
      return null;
    }
    // No player name: the server uses the logged-in account's username.
    return { name: form.name.value.trim() || undefined, code, opponent: form.opponent.value || undefined };
  }

  /** A 401 means the session ended (logged out elsewhere, or expired). */
  _sessionEnded(status) {
    if (status !== 401) return false;
    this.close();
    this.onLoggedOut();
    return true;
  }

  async _test() {
    if (this.busy) return;
    const code = this.code.value;
    if (!code.trim()) return this._showCheck('bad', 'Paste or write your bot code first.');
    this._setBusy(true);
    const check = await this._runCheck(code);
    this._setBusy(false);
    if (!check) return;
    if (check.ok) {
      const took = `${(check.ms / 1000).toFixed(3)} s`;
      this._showCheck('ok', `Looks good. On a test board your bot played ${check.move.from} → ${check.move.to} in ${took} (out of its ${formatClock(check.limitMs)} game clock).`, check.logs);
    } else {
      this._showCheck('bad', check.error, check.logs);
    }
  }

  async _submit() {
    if (this.busy) return;
    const values = this._readForm();
    if (!values) return;
    this._setBusy(true);
    const check = await this._runCheck(values.code);
    if (!check || !check.ok) {
      this._setBusy(false);
      if (check) this._showCheck('bad', `Your bot did not pass the check: ${check.error}`, check.logs);
      return;
    }
    // The server accepts the bot without testing it again: it passed this check.
    this._showCheck('busy', 'Your bot passed the check. Submitting…');
    const checkId = check.id;
    const request = {
      create: () => api('POST', '/api/matches', { ...values, checkId }),
      join: () => api('POST', `/api/matches/${this.match.id}/join`, { code: values.code, checkId }),
      tournament: () => api('POST', `/api/tournaments/${this.tournament.id}/entry`, { code: values.code, checkId }),
    }[this.mode];
    const { ok, status, data } = await request();
    this._setBusy(false);
    if (this._sessionEnded(status)) return;
    if (!ok) {
      this._showCheck('bad', data?.botError || data?.error || 'Something went wrong.', data?.logs || []);
      return;
    }
    this.form.elements.name.value = '';
    this.close();
    if (this.onDone) this.onDone(data);
    else this.onSubmitted(data);
  }
}
