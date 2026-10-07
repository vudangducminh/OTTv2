const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ArenaError } = require('./arena');

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

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ArenaError(413, 'The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new ArenaError(400, 'The request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

/** Serves files under `root`, refusing anything that resolves outside it. */
function serveStatic(root, pathname, request, response) {
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
    'cache-control': 'no-cache',
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
  constructor(arena) {
    this.arena = arena;
    this.clients = new Set();
    this.lobbyTimer = null;

    arena.on('lobby', () => this._queueLobby());
    // Watchers need the dealt board, which summaries don't carry.
    arena.on('match-start', (match) => this._toWatchers(match.id, 'snapshot', match.snapshot()));
    arena.on('match-update', (match) => this._toWatchers(match.id, 'update', match.summary()));
    arena.on('match-move', (match, record) => this._toWatchers(match.id, 'move', { record, summary: match.summary() }));
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

function createServer(arena, config) {
  const hub = new Hub(arena);
  const bodyLimit = config.maxCodeBytes + 16 * 1024;

  const routes = [
    ['GET', /^\/api\/stream$/, (req, res, _params, url) => hub.open(req, res, url.searchParams.get('match'))],
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
        const { match, seat, secret } = await arena.create(body);
        sendJson(res, 201, { match: match.summary(), seat, secret });
      },
    ],
    [
      'POST',
      /^\/api\/matches\/(\d+)\/join$/,
      async (req, res, [id]) => {
        const body = await readJson(req, bodyLimit);
        const { match, seat, secret } = await arena.join(id, body);
        sendJson(res, 200, { match: match.summary(), seat, secret });
      },
    ],
    [
      'POST',
      /^\/api\/matches\/(\d+)\/cancel$/,
      async (req, res, [id]) => {
        const body = await readJson(req, 4096);
        sendJson(res, 200, { match: arena.cancel(id, body.secret).summary() });
      },
    ],
    [
      'POST',
      /^\/api\/check$/,
      async (req, res) => {
        const body = await readJson(req, bodyLimit);
        sendJson(res, 200, await arena.check(body.code, Number(body.seat)));
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
          moveTimeLimitMs: config.moveTimeLimitMs,
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
      if (url.pathname.startsWith('/api/')) throw new ArenaError(404, 'Unknown API endpoint.');
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new ArenaError(405, 'Method not allowed.');
      const served = url.pathname.startsWith('/library/')
        ? serveStatic(config.libraryDir, url.pathname.slice('/library'.length), request, response)
        : serveStatic(config.clientDir, url.pathname, request, response);
      if (!served) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
      }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof ArenaError) {
        sendJson(response, error.status, { error: error.message, ...error.details });
      } else {
        console.error(error);
        sendJson(response, 500, { error: 'Something went wrong on the server.' });
      }
    }
  });
}

module.exports = { createServer };
