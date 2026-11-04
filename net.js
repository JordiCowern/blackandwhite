// Networking for a static site. GitHub Pages can't run a server, so the host's
// browser runs the room (game.js) and every guest connects straight to the host
// over WebRTC, using PeerJS and its free public broker to find each other.
// Add ?net=local to the URL to use a same-browser stand-in instead (for testing
// with several tabs, no internet needed).
(function () {
'use strict';
const PREFIX = 'leverage-room-';           // namespaces our ids on the shared PeerJS broker
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOCAL = new URLSearchParams(location.search).get('net') === 'local';
const PEER_OPTIONS = {
  debug: 1
  // To help players on strict networks connect, add your own TURN server here, e.g.
  // config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'turn:your.turn.server:3478', username: 'u', credential: 'p' }] }
};

function makeCode() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return Array.from(a, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
function newPeer(id) {
  if (LOCAL) return new LocalPeer(id);
  if (typeof window.Peer !== 'function') throw new Error('The connection library didn’t load. Check your internet connection and reload the page.');
  return id ? new window.Peer(id, PEER_OPTIONS) : new window.Peer(PEER_OPTIONS);
}
function friendly(e) {
  const t = e && e.type;
  if (t === 'browser-incompatible') return 'This browser can’t make peer-to-peer connections. Try a current version of Chrome, Firefox, Safari or Edge.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') return 'Can’t reach the connection service. Check your internet connection and try again.';
  return (e && e.message) || 'Something went wrong with the connection. Try again.';
}
function openPeer(id) {
  return new Promise((resolve, reject) => {
    let peer;
    try { peer = newPeer(id); } catch (e) { return reject(e); }
    const onErr = e => { peer.destroy(); reject(e); };
    peer.on('open', () => { peer.off && peer.off('error', onErr); resolve(peer); });
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
    try { peer = await openPeer(PREFIX + code); }
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
    conns.set(conn, null);
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
function joinRoom(code, name, token, cb) {
  return new Promise((resolve, reject) => {
    let settled = false, gone = false, conn = null, peer = null, seq = 0;
    const pending = new Map();
    const fail = msg => { if (settled) return; settled = true; reject(new Error(msg)); try { peer && peer.destroy(); } catch {} };
    const timer = setTimeout(() => fail('Couldn’t reach that room. Check the code, and make sure the host still has the game open.'), 15000);
    try { peer = newPeer(); } catch (e) { clearTimeout(timer); return fail(e.message); }
    peer.on('error', e => {
      if (e && e.type === 'peer-unavailable') fail('There’s no open room with that code. Check it, or ask the host whether the room is still open.');
      else if (!settled) fail(friendly(e));
      else console.warn('[net] guest error', e);
    });
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => conn.send({ t: 'hello', name, token }));
      conn.on('data', d => {
        if (!d || typeof d !== 'object') return;
        if (d.t === 'welcome') { settled = true; clearTimeout(timer); resolve(api(d)); }
        else if (d.t === 'refused') { clearTimeout(timer); fail(d.message); }
        else if (d.t === 'state') cb.onView(d.view);
        else if (d.t === 'result') {
          const p = pending.get(d.id);
          if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error)) : p.resolve(); }
        } else if (d.t === 'gone') { gone = true; cb.onGone(d.message); setTimeout(() => peer.destroy(), 100); }
      });
      conn.on('close', () => {
        if (!settled) { clearTimeout(timer); fail('Couldn’t reach that room.'); }
        else if (!gone) { gone = true; try { peer.destroy(); } catch {} cb.onLost(); }
      });
    });
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
