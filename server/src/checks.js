// Bot checks that run in the background. The test move gets the bot's whole
// game clock (5 minutes by default), which is longer than a request may stay
// open through Cloudflare (100 s), so the browser starts a check, follows it,
// and then submits the bot along with the id of the check it passed.

const crypto = require('node:crypto');
const { ApiError } = require('./errors');
const { checkBot } = require('./sandbox');

const KEEP_MS = 15 * 60 * 1000; // finished checks are remembered this long
const MAX_RUNNING = 20; // each running check holds a bot process

const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');

class Checks {
  constructor({ timeLimitMs }) {
    this.timeLimitMs = timeLimitMs;
    this.jobs = new Map();
  }

  /** Starts checking `code` for `user`. A user's earlier unfinished check is stopped. */
  start(user, code, seat) {
    if (!user) throw new ApiError(401, 'Log in to submit a bot.');
    this._sweep();
    for (const job of this.jobs.values()) {
      if (job.userId === user.id && job.status === 'running') this._stop(job);
    }
    if ([...this.jobs.values()].filter((j) => j.status === 'running').length >= MAX_RUNNING) {
      throw new ApiError(503, 'Too many bots are being tested right now. Try again in a minute.');
    }

    const job = {
      id: crypto.randomBytes(12).toString('base64url'),
      userId: user.id,
      codeHash: typeof code === 'string' ? hash(code) : null,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      result: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    checkBot(code, seat === 2 ? 2 : 1, { signal: job.controller.signal })
      .then((result) => this._finish(job, result))
      .catch((error) => {
        console.error('Bot check failed:', error);
        this._finish(job, { ok: false, error: 'The check failed on the server.', logs: [] });
      });
    return this.view(job);
  }

  /** The user's own check, as the browser sees it. */
  get(user, id) {
    return this.view(this._own(user, id));
  }

  stop(user, id) {
    const job = this._own(user, id);
    if (job.status === 'running') this._stop(job);
    return this.view(job);
  }

  /** True when `user` passed check `id` with exactly this code. */
  passed(user, id, code) {
    const job = id && this.jobs.get(String(id));
    return Boolean(
      user && job && job.userId === user.id && job.status === 'done' && job.result.ok && typeof code === 'string' && job.codeHash === hash(code),
    );
  }

  view(job) {
    const base = {
      id: job.id,
      status: job.status,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      limitMs: this.timeLimitMs,
    };
    return job.status === 'done' ? { ...base, ...job.result } : base;
  }

  _own(user, id) {
    if (!user) throw new ApiError(401, 'Log in to submit a bot.');
    const job = this.jobs.get(String(id));
    if (!job || job.userId !== user.id) throw new ApiError(404, 'There is no such check.');
    return job;
  }

  _stop(job) {
    job.controller.abort();
    this._finish(job, { ok: false, cancelled: true, error: 'The check was stopped.', logs: [] });
  }

  _finish(job, result) {
    if (job.status === 'done') return;
    job.status = 'done';
    job.finishedAt = Date.now();
    job.result = result;
  }

  _sweep() {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, job] of this.jobs) if (job.status === 'done' && job.finishedAt < cutoff) this.jobs.delete(id);
  }
}

module.exports = { Checks };
