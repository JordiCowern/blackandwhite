'use strict';
// Leverage game server. No dependencies: Node's http module serves the client,
// a small JSON API handles room and game actions, and server-sent events (SSE)
// push each player their own up-to-date view.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Room, cleanName } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 2000;
const IDLE_MS = 30 * 60 * 1000; // close rooms nobody has been connected to for 30 minutes
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, which are easy to misread

const rooms = new Map();   // code -> Room
const streams = new Map(); // code -> Set<{ res, pid }>

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

function userError(msg) { const e = new Error(msg); e.userFacing = true; return e; }
function makeCode() {
  for (;;) {
    let c = '';
    for (const b of crypto.randomBytes(5)) c += CODE_CHARS[b % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 16384) { reject(userError('That request is too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(userError('That request couldn’t be read.')); }
    });
    req.on('error', reject);
  });
}
function send(res, data, event) {
  res.write((event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room) {
  const set = streams.get(room.code);
  if (!set) return;
  for (const s of set) {
    try { send(s.res, room.view(s.pid)); } catch (e) { console.error('[broadcast]', e); }
  }
}
function closePlayer(code, pid, message) {
  const set = streams.get(code);
  if (!set) return;
  for (const s of [...set]) {
    if (s.pid !== pid) continue;
    send(s.res, { message }, 'gone');
    s.res.end();
    set.delete(s);
  }
}
function createRoom() {
  const code = makeCode();
  const room = new Room(code, broadcast);
  room.onRemove = (pid, msg) => setImmediate(() => closePlayer(code, pid, msg));
  rooms.set(code, room);
  streams.set(code, new Set());
  return room;
}
function destroyRoom(code, message) {
  const room = rooms.get(code);
  if (room) room.destroy();
  const set = streams.get(code);
  if (set) for (const s of set) { try { send(s.res, { message }, 'gone'); s.res.end(); } catch {} }
  rooms.delete(code);
  streams.delete(code);
}

function openStream(req, res, room, token) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // stops nginx-style proxies from buffering the stream
  });
  res.write('retry: 2000\n\n');
  const pl = room && room.byToken(token);
  if (!pl) {
    send(res, { message: room ? 'You’re no longer in that room.' : 'That room doesn’t exist anymore.' }, 'gone');
    return res.end();
  }
  const s = { res, pid: pl.id };
  streams.get(room.code).add(s);
  room.setConn(pl.id, 1); // broadcasts, which includes this new stream
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    const set = streams.get(room.code);
    if (set) set.delete(s);
    if (rooms.get(room.code) === room) room.setConn(pl.id, -1);
  });
}

function serveStatic(p, res) {
  if (p === '/') p = '/index.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC, decodeURIComponent(p))); } catch { return json(res, 400, { error: 'Bad path.' }); }
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'Not found.' });
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app so links like /?room=ABCDE always load.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });

    if (p === '/api/rooms' && req.method === 'POST') {
      const body = await readBody(req);
      if (!cleanName(body.name)) throw userError('Pick a screen name first.');
      if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is full right now. Try again in a few minutes.' });
      const room = createRoom();
      const pl = room.join(body.name);
      return json(res, 200, { code: room.code, playerId: pl.id, token: pl.token });
    }

    const m = p.match(/^\/api\/rooms\/([A-Za-z]{5})\/(join|events|action)$/);
    if (m) {
      const code = m[1].toUpperCase();
      const room = rooms.get(code);
      const what = m[2];
      if (what === 'events' && req.method === 'GET') return openStream(req, res, room, url.searchParams.get('token'));
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
      if (!room) return json(res, 404, { error: 'There’s no room with that code. Check it and try again.' });
      const body = await readBody(req);
      if (what === 'join') {
        const pl = room.join(body.name);
        return json(res, 200, { code, playerId: pl.id, token: pl.token });
      }
      const pl = room.byToken(body.token);
      if (!pl) return json(res, 403, { error: 'You’re not in this room anymore.' });
      room.handle(pl.id, body);
      if (!room.activeHumans().length) setImmediate(() => destroyRoom(code, 'Everyone left, so the room closed.'));
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    return serveStatic(p, res);
  } catch (e) {
    if (e.userFacing) return json(res, 400, { error: e.message });
    console.error('[server]', e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.totalConns > 0) room.lastActive = now;
    else if (now - room.lastActive > IDLE_MS) destroyRoom(code, 'This room closed after sitting idle.');
  }
}, 60000).unref();

server.listen(PORT, HOST, () => console.log(`Leverage is running on http://localhost:${PORT}`));
