const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

const COOKIE = 'ott_session';
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

// Failed logins per client address before it has to wait.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** "scrypt$N$r$p$salt$key", so the cost can be raised later without breaking old hashes. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and doesn't reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* ignore malformed cookies */
    }
  }
  return cookies;
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, 'Usernames are 3–20 characters: letters, numbers, - and _.');
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new ApiError(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > MAX_PASSWORD) throw new ApiError(400, 'That password is too long.');
}

class Accounts {
  constructor(db, config) {
    this.db = db;
    this.sessionDays = config.sessionDays || 30;
    this.failures = new Map(); // address → { count, since }
  }

  /** Creates an account. Returns the user (no session). */
  async create(username, password) {
    validateUsername(username);
    validatePassword(password);
    const user = await this.db.createUser(username, await hashPassword(password));
    if (!user) throw new ApiError(409, 'That username is taken.');
    return user;
  }

  /** Creates an account and logs it in. Returns { user, cookie }. */
  async register(username, password) {
    const user = await this.create(typeof username === 'string' ? username.trim() : username, password);
    return { user, cookie: await this._startSession(user) };
  }

  /** Returns { user, cookie }. `address` is used to slow down password guessing. */
  async login(username, password, address) {
    this._checkThrottle(address);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw new ApiError(400, 'Enter your username and password.');
    }
    const found = await this.db.findLogin(username.trim());
    const ok = await verifyPassword(password.slice(0, MAX_PASSWORD), found ? found.passwordHash : await DUMMY_HASH);
    if (!found || !ok) {
      this._recordFailure(address);
      throw new ApiError(401, 'Wrong username or password.');
    }
    this.failures.delete(address);
    return { user: found.user, cookie: await this._startSession(found.user) };
  }

  /** Ends the session in `cookieHeader`. Returns the cookie that clears it. */
  async logout(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (token) await this.db.deleteSession(hashToken(token));
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** The logged-in user for a request's Cookie header, or null. */
  async userFromCookie(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (!token || token.length > 100) return null;
    return this.db.userForSession(hashToken(token));
  }

  /** Sets a new password and logs the account out everywhere. */
  async resetPassword(username, password) {
    validatePassword(password);
    const found = await this.db.findLogin(username);
    if (!found) throw new ApiError(404, `There is no user called ${username}.`);
    await this.db.setPassword(found.user.id, await hashPassword(password));
    await this.db.deleteUserSessions(found.user.id);
    return found.user;
  }

  async _startSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = this.sessionDays * 24 * 60 * 60;
    await this.db.createSession(user.id, hashToken(token), new Date(Date.now() + maxAge * 1000));
    // HttpOnly: page scripts can't read it. SameSite=Lax: other sites can't send it with their requests.
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  _checkThrottle(address) {
    const entry = this.failures.get(address);
    if (!entry) return;
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
      this.failures.delete(address);
      return;
    }
    if (entry.count >= MAX_FAILURES) {
      const minutes = Math.ceil((FAILURE_WINDOW_MS - (Date.now() - entry.since)) / 60000);
      throw new ApiError(429, `Too many failed logins. Try again in ${minutes} min.`);
    }
  }

  _recordFailure(address) {
    const entry = this.failures.get(address);
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) this.failures.set(address, { count: 1, since: Date.now() });
    else entry.count += 1;
  }
}

module.exports = { Accounts, hashPassword, verifyPassword, parseCookies };
