const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ApiError } = require('./errors');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const LOBBY_THROTTLE_MS = 400;
const HEARTBEAT_MS = 20 * 1000;

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function readJson(request, limit) {
  // HTML forms on other sites can't send this content type without the
  // browser asking us first, so it also blocks cross-site form posts.
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) {
    return Promise.reject(new ApiError(415, 'Send the request body as JSON.'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, 'The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new ApiError(400, 'The request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Fingerprint of the client files and the library, from their sizes and
 * modification times. It changes whenever any of them changes.
 */
function assetVersion(config) {
  const parts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        parts.push(`${full}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(config.clientDir);
  walk(config.libraryDir);
  return crypto.createHash('sha1').update(parts.sort().join('\n')).digest('hex').slice(0, 12);
}

const ASSET_LINK = /(href|src)="(?:\/library\/ottv2\.js|styles\.css|favicon\.svg|js\/app\.js)"/g;

/**
 * The page, with its scripts and styles under /v/<fingerprint>/. Cloudflare
 * tells browsers to keep JS and CSS for hours; a new fingerprint after every
 * change means a normal reload always gets the current code. Imports inside
 * the modules are relative, so they pick up the same prefix.
 */
function sendIndex(config, request, response) {
  const version = assetVersion(config);
  const html = fs.readFileSync(path.join(config.clientDir, 'index.html'), 'utf8').replace(ASSET_LINK, (match, attr) => {
    const file = match.slice(attr.length + 2, -1).replace(/^\//, '');
    return `${attr}="/v/${version}/${file}"`;
  });
  response.writeHead(200, {
    'content-type': CONTENT_TYPES['.html'],
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : html);
}

/**
 * Serves files under `root`, refusing anything that resolves outside it.
 * `immutable` (fingerprinted URLs) lets browsers and Cloudflare keep the file.
 */
function serveStatic(root, pathname, request, response, immutable = false) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const filePath = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const headers = {
    'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  // Let people save the library and example bots straight from the docs page.
  if (request.url.includes('download=1')) headers['content-disposition'] = `attachment; filename="${path.basename(filePath)}"`;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
  return true;
}

/**
 * Live updates over Server-Sent Events. Each browser tab holds one stream: it
 * always receives the lobby, plus every event of the match it is watching.
 */
class Hub {
  /** `version()` is the current fingerprint of the client code (see assetVersion). */
  constructor(arena, tournaments, version = () => null) {
    this.version = version;
    this.arena = arena;
    this.clients = new Set();
    this.lobbyTimer = null;
    this.changedTournaments = new Set();
    this.tournamentTimer = null;

    // Tournament pages re-fetch when told which tournament changed.
    if (tournaments) tournaments.on('changed', (id) => this._queueTournament(id));

    arena.on('lobby', () => this._queueLobby());
    // Watchers need the dealt board, which summaries don't carry.
    arena.on('match-start', (match) => this._toWatchers(match.id, 'snapshot', match.snapshot()));
    arena.on('match-update', (match) => this._toWatchers(match.id, 'update', match.summary()));
    arena.on('match-move', (match, record) =>
      this._toWatchers(match.id, 'move', { record, ms: match.moveTimes[record.ply - 1], summary: match.summary() }),
    );
    arena.on('match-log', (match, entry) => this._toWatchers(match.id, 'log', entry));

    setInterval(() => {
      for (const client of this.clients) client.response.write(': ping\n\n');
    }, HEARTBEAT_MS).unref();
  }

  open(request, response, watchId) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');
    // Tabs reconnect after every deploy; one loaded with older code sees a
    // different version here and reloads itself.
    response.write(`event: version\ndata: ${JSON.stringify({ version: this.version() })}\n\n`);

    let match = null;
    if (watchId) match = this.arena.matches.get(Number(watchId)) || null;
    const client = { response, watch: match ? match.id : null };
    this.clients.add(client);

    if (watchId && !match) this._send(client, 'missing', { id: Number(watchId) });
    if (match) {
      match.watchers += 1;
      this._send(client, 'snapshot', match.snapshot());
      this._watchersChanged(match, client);
    }
    this._send(client, 'lobby', this.arena.list());

    request.on('close', () => {
      this.clients.delete(client);
      if (match) {
        match.watchers = Math.max(0, match.watchers - 1);
        this._watchersChanged(match);
      }
    });
  }

  _watchersChanged(match, except) {
    const payload = `event: update\ndata: ${JSON.stringify(match.summary())}\n\n`;
    for (const client of this.clients) if (client.watch === match.id && client !== except) client.response.write(payload);
    this._queueLobby();
  }

  _send(client, event, data) {
    client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  _toWatchers(id, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) if (client.watch === id) client.response.write(payload);
  }

  _queueTournament(id) {
    this.changedTournaments.add(id);
    if (this.tournamentTimer) return;
    this.tournamentTimer = setTimeout(() => {
      this.tournamentTimer = null;
      for (const changed of this.changedTournaments) {
        const payload = `event: tournament\ndata: ${JSON.stringify({ id: changed })}\n\n`;
        for (const client of this.clients) client.response.write(payload);
      }
      this.changedTournaments.clear();
    }, LOBBY_THROTTLE_MS);
  }

  // Moves arrive several times a second across all matches, so lobby updates
  // are batched.
  _queueLobby() {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      const payload = `event: lobby\ndata: ${JSON.stringify(this.arena.list())}\n\n`;
      for (const client of this.clients) client.response.write(payload);
    }, LOBBY_THROTTLE_MS);
  }
}

/**
 * The HTTP server: API routes, the live event stream, and the client's files.
 * `accounts`, `db` and `tournaments` are optional; without them there are no logins, profiles or tournaments.
 */
function createServer({ arena, accounts = null, db = null, tournaments = null, checks = null, config }) {
  const hub = new Hub(arena, tournaments, () => assetVersion(config));
  const bodyLimit = config.maxCodeBytes + 16 * 1024;

  const currentUser = (req) => (accounts ? accounts.userFromCookie(req.headers.cookie) : null);

  // Through the Cloudflare tunnel every request arrives from the tunnel
  // container, so the visitor's address and HTTPS use come from its headers.
  const clientAddress = (req) => {
    if (config.trustProxy) {
      const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress;
  };
  const viaHttps = (req) =>
    Boolean(config.trustProxy) &&
    (/^https$/i.test(req.headers['x-forwarded-proto'] || '') || /"scheme"\s*:\s*"https"/.test(req.headers['cf-visitor'] || ''));
  const needAccounts = () => {
    if (!accounts) throw new ApiError(503, 'Accounts are not available on this server.');
  };
  const needTournaments = () => {
    if (!tournaments) throw new ApiError(503, 'Tournaments are not available on this server.');
  };

  const routes = [
    ['GET', /^\/api\/stream$/, (req, res, _params, url) => hub.open(req, res, url.searchParams.get('match'))],
    [
      'GET',
      /^\/api\/health$/,
      async (req, res) => {
        const database = db ? await db.healthy() : null;
        sendJson(res, database === false ? 503 : 200, { ok: database !== false, database });
      },
    ],

    // ----- accounts
    [
      'POST',
      /^\/api\/auth\/register$/,
      async (req, res) => {
        needAccounts();
        const body = await readJson(req, 4096);
        const { user, cookie } = await accounts.register(body.username, body.password, { secure: viaHttps(req) });
        sendJson(res, 201, { user }, { 'set-cookie': cookie });
      },
    ],
    [
      'POST',
      /^\/api\/auth\/login$/,
      async (req, res) => {
        needAccounts();
        const body = await readJson(req, 4096);
        const { user, cookie } = await accounts.login(body.username, body.password, clientAddress(req), { secure: viaHttps(req) });
        sendJson(res, 200, { user }, { 'set-cookie': cookie });
      },
    ],
    [
      'POST',
      /^\/api\/auth\/logout$/,
      async (req, res) => {
        needAccounts();
        await readJson(req, 4096);
        sendJson(res, 200, { ok: true }, { 'set-cookie': await accounts.logout(req.headers.cookie, { secure: viaHttps(req) }) });
      },
    ],
    ['GET', /^\/api\/auth\/me$/, async (req, res) => sendJson(res, 200, { user: await currentUser(req) })],

    // ----- player profiles
    [
      'GET',
      /^\/api\/users\/([A-Za-z0-9_-]{1,40})$/,
      async (req, res, [username]) => {
        if (!db) throw new ApiError(503, 'Profiles are not available on this server.');
        const profile = await db.profile(username);
        if (!profile) throw new ApiError(404, `There is no player called ${username}.`);
        sendJson(res, 200, profile);
      },
    ],

    // ----- tournaments
    [
      'GET',
      /^\/api\/tournaments$/,
      async (req, res) => {
        needTournaments();
        sendJson(res, 200, { tournaments: await tournaments.list() });
      },
    ],
    [
      'POST',
      /^\/api\/tournaments$/,
      async (req, res) => {
        needTournaments();
        const body = await readJson(req, 4096);
        sendJson(res, 201, { tournament: await tournaments.create(await currentUser(req), body) });
      },
    ],
    [
      'GET',
      /^\/api\/tournaments\/(\d+)$/,
      async (req, res, [id]) => {
        needTournaments();
        sendJson(res, 200, await tournaments.detail(id));
      },
    ],
    [
      'POST',
      /^\/api\/tournaments\/(\d+)\/entry$/,
      async (req, res, [id]) => {
        needTournaments();
        const body = await readJson(req, bodyLimit);
        sendJson(res, 200, { result: await tournaments.enter(await currentUser(req), id, body.code, body.checkId) });
      },
    ],
    ...['leave', 'start', 'cancel'].map((action) => [
      'POST',
      new RegExp(`^/api/tournaments/(\\d+)/${action}$`),
      async (req, res, [id]) => {
        needTournaments();
        await readJson(req, 4096);
        await tournaments[action](await currentUser(req), id);
        sendJson(res, 200, { ok: true });
      },
    ]),

    // ----- matches
    ['GET', /^\/api\/matches$/, (req, res) => sendJson(res, 200, arena.list())],
    ['GET', /^\/api\/matches\/(\d+)$/, (req, res, [id]) => sendJson(res, 200, arena.get(id).snapshot())],
    [
      'GET',
      /^\/api\/matches\/(\d+)\/log$/,
      (req, res, [id]) => {
        const match = arena.get(id);
        const text = match.logText();
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="ottv2-match-${match.id}.log"`,
          'cache-control': 'no-store',
        });
        res.end(text);
      },
    ],
    [
      'POST',
      /^\/api\/matches$/,
      async (req, res) => {
        const body = await readJson(req, bodyLimit);
        const { match, seat } = await arena.create(await currentUser(req), body);
        sendJson(res, 201, { match: match.summary(), seat });
      },
    ],
    [
      'POST',
      /^\/api\/matches\/(\d+)\/join$/,
      async (req, res, [id]) => {
        const body = await readJson(req, bodyLimit);
        const { match, seat } = await arena.join(id, await currentUser(req), body);
        sendJson(res, 200, { match: match.summary(), seat });
      },
    ],
    [
      'POST',
      /^\/api\/matches\/(\d+)\/cancel$/,
      async (req, res, [id]) => {
        await readJson(req, 4096);
        sendJson(res, 200, { match: arena.cancel(id, await currentUser(req)).summary() });
      },
    ],
    // A bot check runs in the background: start it, follow it, stop it.
    [
      'POST',
      /^\/api\/check$/,
      async (req, res) => {
        if (!checks) throw new ApiError(503, 'Bot checks are not available on this server.');
        const body = await readJson(req, bodyLimit);
        sendJson(res, 202, { check: checks.start(await currentUser(req), body.code, Number(body.seat)) });
      },
    ],
    [
      'GET',
      /^\/api\/check\/([A-Za-z0-9_-]{1,40})$/,
      async (req, res, [id]) => {
        if (!checks) throw new ApiError(503, 'Bot checks are not available on this server.');
        sendJson(res, 200, { check: checks.get(await currentUser(req), id) });
      },
    ],
    [
      'POST',
      /^\/api\/check\/([A-Za-z0-9_-]{1,40})\/stop$/,
      async (req, res, [id]) => {
        if (!checks) throw new ApiError(503, 'Bot checks are not available on this server.');
        await readJson(req, 4096);
        sendJson(res, 200, { check: checks.stop(await currentUser(req), id) });
      },
    ],
    [
      'GET',
      /^\/api\/examples$/,
      (req, res) => sendJson(res, 200, arena.examples.map(({ id, name, description, code }) => ({ id, name, description, code }))),
    ],
    [
      'GET',
      /^\/api\/config$/,
      (req, res) =>
        sendJson(res, 200, {
          moveDelayMs: config.moveDelayMs,
          gameTimeLimitMs: config.gameTimeLimitMs,
          loadTimeLimitMs: config.loadTimeLimitMs,
          botMemoryMb: config.botMemoryMb,
          maxCodeBytes: config.maxCodeBytes,
        }),
    ],
  ];

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && request.method === method) {
          await handler(request, response, match.slice(1), url);
          return;
        }
      }
      if (url.pathname.startsWith('/api/')) throw new ApiError(404, 'Unknown API endpoint.');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'Method not allowed.');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendIndex(config, request, response);
        return;
      }
      // /v/<fingerprint>/… is the same file as /…, but cacheable forever.
      const versioned = /^\/v\/[0-9a-f]{6,40}(\/.*)$/.exec(url.pathname);
      const pathname = versioned ? versioned[1] : url.pathname;
      const served = pathname.startsWith('/library/')
        ? serveStatic(config.libraryDir, pathname.slice('/library'.length), request, response, Boolean(versioned))
        : serveStatic(config.clientDir, pathname, request, response, Boolean(versioned));
      if (!served) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
      }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message, ...error.details });
      } else {
        console.error(error);
        sendJson(response, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });
}

module.exports = { createServer };
