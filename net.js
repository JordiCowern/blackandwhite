// Networking for a static site. GitHub Pages can't run a server, so the host's browser
// runs the room (game.js), and players exchange messages through a public MQTT message
// service over ordinary secure WebSockets. That avoids the direct browser-to-browser
// connections that many networks block.
//
// Anyone can read a public MQTT service, so every message after the room's public key
// is end-to-end encrypted: each guest agrees a private key with the host (ECDH P-256)
// and messages are sealed with AES-GCM. Other people can't read hidden clues off the wire.
//
// Add ?net=local to the URL to use a same-browser stand-in instead (for testing with
// several tabs, no internet needed). Add ?debug to log every connection step.
(function () {
'use strict';
const params = new URLSearchParams(location.search);
const LOCAL = params.get('net') === 'local';
const DEBUG = params.has('debug');
const log = (...a) => { if (DEBUG) console.log('[net]', ...a); };
const CFG = window.LEVERAGE_CONFIG || {};
const BROKERS = (CFG.brokers && CFG.brokers.length) ? CFG.brokers : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const BASE = 'leverage-game/v3/';
const T = { key: c => `${BASE}${c}/key`, host: c => `${BASE}${c}/host`, to: (c, id) => `${BASE}${c}/to/${id}` };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const enc = new TextEncoder(), dec = new TextDecoder();
const MSG = {
  broker: 'Couldn’t reach the message service the game uses. Check your internet connection and try again in a minute.',
  missing: 'There’s no open room with that code. Check it, or ask the host whether the room is still open.',
  hello: 'Found the room, but the host’s page didn’t answer. Ask the host to reload the site and make a new room.',
  lib: 'The connection library didn’t load. Check your internet connection and reload the page.',
  secure: 'This page has to be opened over https to connect.'
};

function makeCode() { const a = crypto.getRandomValues(new Uint8Array(5)); return Array.from(a, b => CODE_CHARS[b % CODE_CHARS.length]).join(''); }
function randId(n = 10) { return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join(''); }
function lib() { if (LOCAL) return localMqtt; if (!window.mqtt || !window.mqtt.connect) throw new Error(MSG.lib); return window.mqtt; }
const parse = p => { try { const s = typeof p === 'string' ? p : dec.decode(p); return s ? JSON.parse(s) : null; } catch { return null; } };
// Runs async jobs one at a time, in order.
function serial() { let p = Promise.resolve(); return fn => { p = p.then(fn).catch(e => console.warn('[net]', e)); }; }

/* ---------- encryption ---------- */
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function newKeys() {
  if (!crypto.subtle) throw new Error(MSG.secure);
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  return { kp, pub: await crypto.subtle.exportKey('jwk', kp.publicKey) };
}
async function sharedKey(kp, jwk) {
  const other = await crypto.subtle.importKey('jwk', jwk, ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: other }, kp.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { iv: b64(iv), d: b64(ct) };
}
async function unseal(key, m) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, key, unb64(m.d));
  return JSON.parse(dec.decode(pt));
}
const sameKey = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;

/* ---------- message service helpers ---------- */
function connect(url, extra) {
  return new Promise((resolve, reject) => {
    let client, done = false;
    try {
      client = lib().connect(url, { clean: true, keepalive: 20, reconnectPeriod: 2000, connectTimeout: 8000, clientId: 'lev_' + randId(8), ...extra });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => { if (done) return; done = true; try { client.end(true); } catch {} reject(new Error(MSG.broker)); }, 9000);
    client.on('connect', () => { if (done) return; done = true; clearTimeout(timer); log('connected to', url); resolve(client); });
    client.on('error', e => {
      log('service error', url, e && e.message);
      if (done) return;
      done = true; clearTimeout(timer); try { client.end(true); } catch {}
      reject(new Error(MSG.broker));
    });
  });
}
function subscribe(client, topic) { return new Promise((res, rej) => client.subscribe(topic, { qos: 1 }, e => e ? rej(e) : res())); }
function publish(client, topic, obj, opts) { client.publish(topic, obj == null ? '' : JSON.stringify(obj), { qos: 1, ...(opts || {}) }); }
// A room exists when its key topic holds a retained public key.
function peekRoom(client, code, ms) {
  return new Promise(resolve => {
    let done = false;
    const topic = T.key(code);
    const finish = v => { if (done) return; done = true; client.removeListener('message', onMsg); resolve(v); };
    const onMsg = (t, p) => { if (t !== topic) return; const m = parse(p); if (m && m.pub) finish(m); };
    client.on('message', onMsg);
    subscribe(client, topic).catch(() => {});
    setTimeout(() => finish(null), ms);
  });
}

/* ---------- host ---------- */
async function createHost(name, cb) {
  const { Room, cleanName } = window.LeverageGame;
  if (!cleanName(name)) throw new Error('Pick a screen name first.');
  const keys = await newKeys();
  let client = null, code = null, url = null;
  for (const u of BROKERS) {
    // Pick an unused code with a plain probe connection first, so a "will" can never
    // touch someone else's room.
    let probe;
    try { probe = await connect(u, {}); } catch { log('could not use', u); continue; }
    let free = null;
    for (let i = 0; i < 4 && !free; i++) { const c0 = makeCode(); if (!(await peekRoom(probe, c0, 1200))) free = c0; }
    try { probe.end(false); } catch {}
    if (!free) continue;
    // If the host's page vanishes, the service clears the room's key (the "will").
    try { client = await connect(u, { will: { topic: T.key(free), payload: '', retain: true, qos: 1 } }); }
    catch { log('could not use', u); continue; }
    code = free; url = u;
    break;
  }
  if (!client) throw new Error(MSG.broker);
  log('hosting', code, 'on', url);

  const sessions = new Map(); // guest client id -> { key, jwk, pid, last, online, out, wantState }
  const inbox = serial();
  let me = null, closed = false, flushTimer = null;

  function send(s, gid, obj) {
    s.out(async () => { publish(client, T.to(code, gid), await seal(s.key, obj)); });
  }
  function flush() {
    flushTimer = null;
    for (const [gid, s] of sessions) if (s.wantState && s.pid && s.online) { s.wantState = false; send(s, gid, { t: 'state', view: room.view(s.pid) }); }
  }
  const room = new Room(code, () => {
    for (const s of sessions.values()) s.wantState = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 0); // send one up-to-date view, not one per change
    if (me) cb.onView(room.view(me.id));
  });
  room.onRemove = (pid, message) => setTimeout(() => {
    for (const [gid, s] of sessions) {
      if (s.pid !== pid) continue;
      send(s, gid, { t: 'gone', message });
      s.online = false; s.pid = null;
      s.out(() => { sessions.delete(gid); });
    }
  }, 0);
  me = room.join(name);
  room.setConn(me.id, 1);

  publish(client, T.key(code), { pub: keys.pub, v: 3 }, { retain: true });
  await subscribe(client, T.host(code));
  client.on('message', (t, p) => {
    if (t !== T.host(code) || closed) return;
    const m = parse(p);
    if (m && typeof m.f === 'string') inbox(() => handle(m));
  });
  client.on('connect', () => { if (!closed) { log('reconnected'); publish(client, T.key(code), { pub: keys.pub, v: 3 }, { retain: true }); } });
  client.on('offline', () => { if (!closed && cb.onStatus) cb.onStatus('Lost the connection to the message service. Reconnecting…'); });

  async function handle(m) {
    if (m.t === 'bye') { // a guest's page closed
      const s = sessions.get(m.f);
      if (s && s.online && s.pid) { s.online = false; room.setConn(s.pid, -1); }
      return;
    }
    let s = sessions.get(m.f);
    if (m.k && (!s || !sameKey(s.jwk, m.k))) {
      if (s && s.online && s.pid) room.setConn(s.pid, -1);
      s = { key: await sharedKey(keys.kp, m.k), jwk: m.k, pid: null, last: Date.now(), online: false, out: serial(), wantState: false };
      sessions.set(m.f, s);
    }
    if (!s) return;
    let body;
    try { body = await unseal(s.key, m); } catch { return; }
    s.last = Date.now();
    if (body.t === 'hello') {
      try {
        let p = room.byToken(body.token);
        if (!p) p = room.join(body.name);
        for (const [gid, o] of sessions) if (o !== s && o.pid === p.id) { if (o.online) room.setConn(p.id, -1); sessions.delete(gid); }
        const already = s.online && s.pid === p.id;
        s.pid = p.id;
        send(s, m.f, { t: 'welcome', playerId: p.id, token: p.token });
        if (already) { s.wantState = true; flush(); } else { s.online = true; room.setConn(p.id, 1); }
      } catch (e) {
        send(s, m.f, { t: 'refused', message: e.userFacing ? e.message : 'The host couldn’t add you to the room.' });
      }
    } else if (body.t === 'ping') {
      if (!s.pid) return;
      const p = room.P(s.pid);
      if (!s.online && p && !p.left) { s.online = true; room.setConn(s.pid, 1); }
      send(s, m.f, { t: 'pong' });
    } else if (body.t === 'action') {
      if (!s.pid) return;
      try { room.handle(s.pid, body.msg || {}); send(s, m.f, { t: 'result', id: body.id }); }
      catch (e) {
        if (!e.userFacing) console.error('[game]', e);
        send(s, m.f, { t: 'result', id: body.id, error: e.userFacing ? e.message : 'Something went wrong. Try again.' });
      }
    }
  }
  // Guests ping every few seconds; one that goes quiet is shown as offline.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) if (s.online && s.pid && now - s.last > 15000) { s.online = false; room.setConn(s.pid, -1); }
  }, 3000);

  function close(message) {
    if (closed) return;
    closed = true;
    clearInterval(sweep);
    for (const [gid, s] of sessions) if (s.pid) send(s, gid, { t: 'gone', message: message || 'The host closed the room.' });
    room.destroy();
    setTimeout(() => { try { publish(client, T.key(code), null, { retain: true }); client.end(false); } catch {} }, 400);
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
async function joinRoom(code, name, token, cb) {
  const keys = await newKeys();
  const myId = randId(10);
  let client = null, roomKey = null, reached = false;
  for (const u of BROKERS) {
    let c;
    try { c = await connect(u, { will: { topic: T.host(code), payload: JSON.stringify({ f: myId, t: 'bye' }), qos: 0, retain: false } }); }
    catch { log('could not use', u); continue; }
    reached = true;
    const k = await peekRoom(c, code, 3000);
    if (k) { client = c; roomKey = k; log('found room', code, 'on', u); break; }
    c.end(true);
  }
  if (!client) throw new Error(reached ? MSG.missing : MSG.broker);
  const key = await sharedKey(keys.kp, roomKey.pub);
  await subscribe(client, T.to(code, myId));

  return new Promise((resolve, reject) => {
    let settled = false, gone = false, seq = 0, lastHeard = Date.now();
    const pending = new Map(), inbox = serial(), out = serial();
    const send = obj => out(async () => publish(client, T.host(code), { f: myId, ...(await seal(key, obj)) }));
    const stop = () => { clearInterval(ping); clearInterval(watch); try { client.end(false); } catch {} };
    const fail = msg => { if (settled) return; settled = true; clearTimeout(timer); stop(); log('join failed:', msg); reject(new Error(msg)); };
    const end = (fn, arg) => { if (gone) return; gone = true; stop(); fn(arg); };
    const timer = setTimeout(() => fail(MSG.hello), 10000);

    client.on('message', (t, p) => {
      if (t === T.key(code)) {
        const m = parse(p);
        if (!m || !m.pub || !sameKey(m.pub, roomKey.pub)) { if (!settled) fail(MSG.missing); else end(cb.onGone, 'The host closed the room.'); }
        return;
      }
      if (t !== T.to(code, myId)) return;
      const m = parse(p);
      if (!m) return;
      inbox(async () => {
        let d;
        try { d = await unseal(key, m); } catch { return; }
        lastHeard = Date.now();
        if (d.t === 'welcome') { if (settled) return; settled = true; clearTimeout(timer); log('joined'); resolve(api(d)); }
        else if (d.t === 'refused') fail(d.message);
        else if (d.t === 'state') cb.onView(d.view);
        else if (d.t === 'result') {
          const q = pending.get(d.id);
          if (q) { pending.delete(d.id); d.error ? q.reject(new Error(d.error)) : q.resolve(); }
        } else if (d.t === 'gone') end(cb.onGone, d.message);
      });
    });
    client.on('connect', () => { if (settled && !gone) send({ t: 'ping' }); });
    const ping = setInterval(() => { if (settled && !gone) send({ t: 'ping' }); }, 5000);
    const watch = setInterval(() => { if (settled && !gone && Date.now() - lastHeard > 20000) end(cb.onLost); }, 2000);

    out(async () => publish(client, T.host(code), { f: myId, k: keys.pub, ...(await seal(key, { t: 'hello', name, token })) }));

    function api(w) {
      return {
        code, playerId: w.playerId, token: w.token, role: 'guest',
        act(msg) {
          return new Promise((res, rej) => {
            if (gone) return rej(new Error('You’re not connected to the room right now.'));
            const id = ++seq;
            pending.set(id, { resolve: res, reject: rej });
            send({ t: 'action', id, msg });
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('The host didn’t answer. Try again.')); } }, 8000);
          });
        },
        close() { if (!gone) { gone = true; stop(); } }
      };
    }
  });
}

/* ---------- same-browser stand-in for the message service (?net=local) ---------- */
class Emitter {
  constructor() { this.h = {}; }
  on(ev, f) { (this.h[ev] = this.h[ev] || []).push(f); return this; }
  removeListener(ev, f) { this.h[ev] = (this.h[ev] || []).filter(x => x !== f); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach(f => f(...a)); }
}
const localMqtt = {
  connect(url, opts) {
    const RET = 'leverage-local-retained:';
    const c = new Emitter();
    const subs = new Set();
    const ch = new BroadcastChannel('leverage-local-mqtt');
    let ended = false;
    const deliver = (topic, payload) => { if (subs.has(topic)) setTimeout(() => c.emit('message', topic, enc.encode(payload)), 0); };
    ch.onmessage = e => deliver(e.data.topic, e.data.payload);
    c.subscribe = (topic, o, cb) => {
      subs.add(topic); if (cb) cb(null);
      const r = localStorage.getItem(RET + topic);
      if (r) deliver(topic, r);
    };
    c.publish = (topic, payload, o = {}) => {
      if (ended) return;
      payload = String(payload || '');
      if (o.retain) { if (payload) localStorage.setItem(RET + topic, payload); else localStorage.removeItem(RET + topic); }
      ch.postMessage({ topic, payload });
      deliver(topic, payload);
    };
    const will = () => { if (!ended && opts.will) { c.publish(opts.will.topic, opts.will.payload, { retain: opts.will.retain }); } ended = true; };
    window.addEventListener('pagehide', will);
    c.end = () => { ended = true; window.removeEventListener('pagehide', will); setTimeout(() => ch.close(), 50); c.emit('close'); };
    setTimeout(() => c.emit('connect'), 20);
    return c;
  }
};

window.LeverageNet = { createHost, joinRoom, local: LOCAL };
})();
