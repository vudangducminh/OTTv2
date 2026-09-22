const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Game state lives entirely in playhtml's room, so this process only serves
// files. Nothing here is stateful; restarting it does not disturb a live game.
const port = Number(process.env.PORT || 6767);
const bindAddress = process.env.HOST || '0.0.0.0';
const publicDirectory = __dirname;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function resolveFilePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(publicDirectory, `.${requested}`);
  const insideRoot = filePath === publicDirectory || filePath.startsWith(`${publicDirectory}${path.sep}`);
  return insideRoot ? filePath : null;
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const filePath = resolveFilePath(url.pathname);
  if (!filePath) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
});

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

server.listen(port, bindAddress, () => {
  console.log(`OTTv2 board hall on http://localhost:${port}`);
  // playhtml scopes its room by window.location.hostname, so everyone has to
  // reach the hall through the same address to land in the same room.
  for (const address of localAddresses()) console.log(`               and http://${address}:${port}`);
});
