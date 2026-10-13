// The log in / create account dialog.

import { $, api } from './ui.js';

const TEXT = {
  login: { title: 'Log in', button: 'Log in', hint: '' },
  register: {
    title: 'Create an account',
    button: 'Create account',
    hint: 'Usernames are 3–20 characters: letters, numbers, - and _. Passwords need at least 8 characters.',
  },
};

export class AuthDialog {
  constructor({ onLogin }) {
    this.onLogin = onLogin;
    this.dialog = $('#auth-dialog');
    this.form = $('#auth-form');
    this.error = $('#ad-error');
    this.submitButton = $('#ad-submit');
    this.mode = 'login';
    this.then = null;

    for (const button of this.dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => this.close());
    for (const button of this.dialog.querySelectorAll('[data-mode]')) {
      button.addEventListener('click', () => this._setMode(button.dataset.mode));
    }
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this._submit();
    });
    this.dialog.addEventListener('close', () => {
      this.form.elements.password.value = '';
    });
  }

  /** `reason` explains why we're asking; `then` runs after a successful login. */
  open({ mode = 'login', reason = '', then = null } = {}) {
    this.then = then;
    $('#ad-sub').textContent = reason;
    $('#ad-sub').hidden = !reason;
    this._setMode(mode);
    if (!this.dialog.open) this.dialog.showModal();
    (this.form.elements.username.value ? this.form.elements.password : this.form.elements.username).focus();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  _setMode(mode) {
    this.mode = mode;
    const text = TEXT[mode];
    $('#ad-title').textContent = text.title;
    this.submitButton.textContent = text.button;
    $('#ad-hint').textContent = text.hint;
    $('#ad-hint').hidden = !text.hint;
    this.form.elements.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    for (const button of this.dialog.querySelectorAll('[data-mode]')) {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    this.error.hidden = true;
  }

  async _submit() {
    const username = this.form.elements.username.value.trim();
    const password = this.form.elements.password.value;
    if (!username || !password) {
      this._showError('Enter a username and a password.');
      return;
    }
    this.submitButton.disabled = true;
    const { ok, data } = await api('POST', `/api/auth/${this.mode === 'register' ? 'register' : 'login'}`, { username, password });
    this.submitButton.disabled = false;
    if (!ok) {
      this._showError(data?.error || 'Something went wrong.');
      return;
    }
    const then = this.then;
    this.then = null;
    this.close();
    this.onLogin(data.user, this.mode);
    if (then) then();
  }

  _showError(message) {
    this.error.textContent = message;
    this.error.hidden = false;
  }
}
