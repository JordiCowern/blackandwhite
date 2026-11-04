// Networking for a static site. GitHub Pages can't run a server, so the host's
// browser runs the room (game.js) and every guest connects straight to the host
// over WebRTC, using PeerJS and its free public broker to find each other.
// Add ?net=local to the URL to use a same-browser stand-in instead (for testing
// with several tabs, no internet needed).
(function () {
'use strict';
const PREFIX = 'leverage-room-';           // namespaces our ids on the shared PeerJS broker (ids are lowercase)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const params = new URLSearchParams(location.search);
const LOCAL = params.get('net') === 'local';
const DEBUG = params.has('debug');         // add ?debug to the URL to log every connection step
const log = (...a) => { if (DEBUG) console.log('[net]', ...a); };
const peerId = code => PREFIX + code.toLowerCase();

// STUN servers let browsers find a direct route to each other. The PeerJS relays are
// the ones PeerJS uses by default; your own relay from config.js is added in front.
const BASE_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
];
let iceCache = null;
async function iceServers() {
  if (iceCache) return iceCache;
  const cfg = window.LEVERAGE_CONFIG || {};
  let relay = [];
  if (cfg.turnCredentialsUrl) {
    try {
      const r = await fetch(cfg.turnCredentialsUrl);
      if (r.ok) relay = await r.json();
      log('relay servers from config', relay);
    } catch (e) { console.warn('[net] could not load TURN credentials', e); }
  }
  iceCache = [...relay, ...(cfg.extraIceServers || []), ...BASE_ICE];
  return iceCache;
}

const MSG = {
  broker: 'Couldn’t reach the service the game uses to find rooms. Check your internet connection and try again in a minute.',
  direct: 'Found the room, but couldn’t open a connection to the host’s browser. One of your networks is probably blocking direct connections. Try a different network (a phone hotspot works for a quick check), or set up the free relay described in the README.',
  hello: 'Connected to the host, but their page didn’t answer. Ask the host to reload the site and make a new room.',
  missing: 'There’s no open room with that code. Check it, or ask the host whether the room is still open.'
};

function makeCode() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return Array.from(a, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
async function newPeer(id) {
  if (LOCAL) return new LocalPeer(id);
  if (typeof window.Peer !== 'function') throw new Error('The connection library didn’t load. Check your internet connection and reload the page.');
  const options = { debug: DEBUG ? 3 : 1, config: { iceServers: await iceServers() } };
  return id ? new window.Peer(id, options) : new window.Peer(options);
}
function friendly(e) {
  const t = e && e.type;
  if (t === 'browser-incompatible') return 'This browser can’t make peer-to-peer connections. Try a current version of Chrome, Firefox, Safari or Edge.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Can’t reach the connection service. Check your internet connection and try again.';
  return (e && e.message) || 'Something went wrong with the connection. Try again.';
}
async function openPeer(id) {
  const peer = await newPeer(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.destroy(); reject(new Error(MSG.broker)); }, 12000);
    const onErr = e => { clearTimeout(timer); peer.destroy(); reject(e); };
    peer.on('open', pid => { clearTimeout(timer); log('host registered as', pid); peer.off && peer.off('error', onErr); resolve(peer); });
    peer.on('error', onErr);
  });
}
function safeSend(conn, msg) { try { if (conn.open) conn.send(msg); } catch (e) { console.warn('[net] send failed', e); } }

/* ---------- host ---------- */
async function createHost(name, cb) {
  const { Room, cleanName } = window.LeverageGame;
  if (!cleanName(name)) throw new Error('Pick a screen name first.');
  let peer = null, code = null;
  for (let i = 0; i < 5 && !peer; i++) {
    code = makeCode();
    try { peer = await openPeer(peerId(code)); }
    catch (e) { if (!e || e.type !== 'unavailable-id') throw new Error(friendly(e)); }
  }
  if (!peer) throw new Error('Couldn’t find a free room code. Try again.');

  const conns = new Map(); // DataConnection -> player id (null until they say hello)
  let me = null, closed = false;
  const room = new Room(code, () => {
    for (const [c, pid] of conns) if (pid) safeSend(c, { t: 'state', view: room.view(pid) });
    if (me) cb.onView(room.view(me.id));
  });
  room.onRemove = (pid, message) => setTimeout(() => {
    for (const [c, p] of conns) {
      if (p !== pid) continue;
      safeSend(c, { t: 'gone', message });
      conns.delete(c);
      setTimeout(() => c.close(), 400);
    }
  }, 0);
  me = room.join(name);
  room.setConn(me.id, 1);

  peer.on('connection', conn => {
    log('guest connecting', conn.peer);
    conns.set(conn, null);
    conn.on('open', () => log('guest connection open', conn.peer));
    conn.on('iceStateChanged', s => log('guest connection state', conn.peer, s));
    conn.on('data', d => onData(conn, d));
    conn.on('close', () => {
      const pid = conns.get(conn);
      conns.delete(conn);
      if (pid && !closed) room.setConn(pid, -1);
    });
    conn.on('error', e => console.warn('[net] guest connection error', e));
  });
  peer.on('disconnected', () => { if (!closed) peer.reconnect(); }); // lost the broker; open games keep working
  peer.on('error', e => { console.warn('[net] host error', e); if (cb.onStatus) cb.onStatus(friendly(e)); });

  function onData(conn, d) {
    if (!d || typeof d !== 'object' || closed) return;
    if (d.t === 'hello') {
      try {
        let p = room.byToken(d.token);
        if (!p) p = room.join(d.name);
        conns.set(conn, p.id);
        safeSend(conn, { t: 'welcome', playerId: p.id, token: p.token });
        room.setConn(p.id, 1); // sends this guest their first view
      } catch (e) {
        safeSend(conn, { t: 'refused', message: e.userFacing ? e.message : 'The host couldn’t add you to the room.' });
        setTimeout(() => conn.close(), 400);
      }
      return;
    }
    if (d.t === 'action') {
      const pid = conns.get(conn);
      if (!pid) return;
      try { room.handle(pid, d.msg || {}); safeSend(conn, { t: 'result', id: d.id }); }
      catch (e) {
        if (!e.userFacing) console.error('[game]', e);
        safeSend(conn, { t: 'result', id: d.id, error: e.userFacing ? e.message : 'Something went wrong. Try again.' });
      }
    }
  }
  function close(message) {
    if (closed) return;
    closed = true;
    for (const c of conns.keys()) safeSend(c, { t: 'gone', message: message || 'The host closed the room.' });
    room.destroy();
    setTimeout(() => { try { peer.destroy(); } catch {} }, 400);
  }
  window.addEventListener('pagehide', () => close('The host left the page, so the room closed.'));

  return {
    code, playerId: me.id, role: 'host',
    act(msg) {
      if (msg.type === 'leave') { close(); return Promise.resolve(); }
      try { room.handle(me.id, msg); return Promise.resolve(); }
      catch (e) { if (!e.userFacing) console.error('[game]', e); return Promise.reject(new Error(e.userFacing ? e.message : 'Something went wrong. Try again.')); }
    },
    close
  };
}

/* ---------- guest ---------- */
// Joining goes through three steps, each with its own time limit and message, so a
// failure says where it broke: reaching the broker, connecting to the host, or the
// host answering.
function joinRoom(code, name, token, cb) {
  return new Promise((resolve, reject) => {
    let settled = false, gone = false, conn = null, peer = null, seq = 0, timer = null;
    const pending = new Map();
    const fail = msg => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      log('join failed:', msg);
      reject(new Error(msg));
      try { peer && peer.destroy(); } catch {}
    };
    const step = (name, ms, msg) => { log('step:', name); clearTimeout(timer); timer = setTimeout(() => fail(msg), ms); };
    step('reaching the broker', 12000, MSG.broker);
    newPeer().then(p => {
      peer = p;
      peer.on('error', e => {
        log('peer error', e && e.type, e);
        if (e && e.type === 'peer-unavailable') fail(MSG.missing);
        else if (!settled) fail(friendly(e));
      });
      peer.on('open', id => {
        log('registered with broker as', id);
        step('connecting to the host', 20000, MSG.direct);
        conn = peer.connect(peerId(code), { reliable: true, serialization: 'json' });
        conn.on('iceStateChanged', s => { log('connection state', s); if (s === 'failed') fail(MSG.direct); });
        conn.on('error', e => { log('connection error', e); if (!settled) fail(MSG.direct); });
        conn.on('open', () => {
          step('waiting for the host to answer', 8000, MSG.hello);
          conn.send({ t: 'hello', name, token });
        });
        conn.on('data', d => {
          if (!d || typeof d !== 'object') return;
          if (d.t === 'welcome') { if (settled) return; settled = true; clearTimeout(timer); log('joined'); resolve(api(d)); }
          else if (d.t === 'refused') fail(d.message);
          else if (d.t === 'state') cb.onView(d.view);
          else if (d.t === 'result') {
            const q = pending.get(d.id);
            if (q) { pending.delete(d.id); d.error ? q.reject(new Error(d.error)) : q.resolve(); }
          } else if (d.t === 'gone') { gone = true; cb.onGone(d.message); setTimeout(() => peer.destroy(), 100); }
        });
        conn.on('close', () => {
          log('connection closed');
          if (!settled) fail(MSG.direct);
          else if (!gone) { gone = true; try { peer.destroy(); } catch {} cb.onLost(); }
        });
      });
    }).catch(e => fail(e.message || MSG.broker));

    function api(w) {
      return {
        code, playerId: w.playerId, token: w.token, role: 'guest',
        act(msg) {
          return new Promise((res, rej) => {
            if (!conn || !conn.open) return rej(new Error('You’re not connected to the room right now.'));
            const id = ++seq;
            pending.set(id, { resolve: res, reject: rej });
            conn.send({ t: 'action', id, msg });
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('The host didn’t answer. Try again.')); } }, 8000);
          });
        },
        close() { gone = true; try { peer.destroy(); } catch {} }
      };
    }
  });
}

/* ---------- same-browser stand-in for PeerJS (?net=local) ---------- */
class Emitter {
  constructor() { this.h = {}; }
  on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); return this; }
  off(ev, f) { this.h[ev] = (this.h[ev] || []).filter(x => x !== f); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach(f => f(...a)); }
}
class LocalPeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || 'peer-' + Math.random().toString(36).slice(2);
    this.conns = {};
    this.bc = new BroadcastChannel('leverage-local-net');
    this.bc.onmessage = e => this.receive(e.data);
    setTimeout(() => this.emit('open', this.id), 30);
  }
  connect(to) {
    const c = new LocalConn(this, to, Math.random().toString(36).slice(2));
    this.conns[c.cid] = c;
    this.bc.postMessage({ k: 'open?', to, from: this.id, cid: c.cid });
    c.timer = setTimeout(() => { if (!c.open) this.emit('error', { type: 'peer-unavailable' }); }, 1000);
    return c;
  }
  receive(m) {
    if (m.to !== this.id) return;
    if (m.k === 'open?') {
      const c = new LocalConn(this, m.from, m.cid);
      c.open = true; this.conns[m.cid] = c;
      this.emit('connection', c);
      this.bc.postMessage({ k: 'open!', to: m.from, cid: m.cid });
      setTimeout(() => c.emit('open'), 0);
      return;
    }
    const c = this.conns[m.cid];
    if (!c) return;
    if (m.k === 'open!') { clearTimeout(c.timer); c.open = true; c.emit('open'); }
    else if (m.k === 'data') c.emit('data', m.d);
    else if (m.k === 'close') { c.open = false; delete this.conns[m.cid]; c.emit('close'); }
  }
  reconnect() {}
  destroy() { Object.values(this.conns).forEach(c => c.close()); setTimeout(() => this.bc.close(), 50); }
}
class LocalConn extends Emitter {
  constructor(peer, remote, cid) { super(); this.peer = peer; this.peerId = remote; this.cid = cid; this.open = false; }
  send(d) { this.peer.bc.postMessage({ k: 'data', to: this.peerId, cid: this.cid, d: JSON.parse(JSON.stringify(d)) }); }
  close() {
    if (!this.open) return;
    this.open = false;
    this.peer.bc.postMessage({ k: 'close', to: this.peerId, cid: this.cid });
    delete this.peer.conns[this.cid];
    this.emit('close');
  }
}

window.LeverageNet = { createHost, joinRoom, local: LOCAL };
})();
