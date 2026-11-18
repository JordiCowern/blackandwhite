(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SESSION_KEY = 'leverage:session', NAME_KEY = 'leverage:name';


let session = null;                  // { code, role, token, playerId }
let state = null;
let net = null;                      // the live room connection from net.js
let offset = 0;        // server clock minus local clock
let connected = true;
const ui = { sel: null, demand: null, modalKey: null };

// The room session lives in sessionStorage, so each tab is its own player and a reload
// rejoins the same seat. The screen name is remembered across visits in localStorage.
const store = k => k === SESSION_KEY ? sessionStorage : localStorage;
function read(k) { try { return JSON.parse(store(k).getItem(k)); } catch { return null; } }
function write(k, v) { try { v == null ? store(k).removeItem(k) : store(k).setItem(k, JSON.stringify(v)); } catch {} }

function act(type, extra = {}) {
  if (!net) return Promise.resolve();
  return net.act({ type, ...extra }).catch(e => toast(e.message));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function show(screen) {
  ['home', 'lobby', 'game'].forEach(id => { $('#' + id).hidden = id !== screen; });
  document.body.dataset.screen = screen;
}

/* ---------- connecting ---------- */
const callbacks = {
  onView(v) { offset = v.serverNow - Date.now(); state = v; connected = true; render(); },
  onGone(message) { leaveLocally(message); },
  onLost() { connected = false; renderStatus(); reconnect(); },
  onStatus(message) { toast(message); }
};
function roomLink(code) {
  const q = new URLSearchParams({ room: code });
  if (window.LeverageNet.local) q.set('net', 'local');
  return `${location.origin}${location.pathname}?${q}`;
}
function setUrl(code) {
  const q = new URLSearchParams();
  if (code) q.set('room', code);
  if (window.LeverageNet.local) q.set('net', 'local');
  const s = q.toString();
  history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
}
async function reconnect() {
  if (!session || session.role !== 'guest') return leaveLocally('You lost the connection to the room.');
  const s = session;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(r => setTimeout(r, attempt ? 2500 : 600));
    if (session !== s) return;
    try {
      net = await window.LeverageNet.joinRoom(s.code, read(NAME_KEY) || 'Player', s.token, callbacks);
      return;
    } catch (e) {
      if (/no open room/i.test(e.message)) break; // the host is gone
    }
  }
  if (session === s) leaveLocally('You lost the connection to the room. The host may have closed it.');
}
function leaveLocally(message) {
  if (net) { try { net.close(); } catch {} net = null; }
  session = null; state = null; ui.sel = null; ui.demand = null; ui.modalKey = null; ui.lastEvent = null; ui.logLen = null;
  write(SESSION_KEY, null);
  $('#decision').hidden = true;
  setUrl(null);
  show('home');
  $('#homeError').textContent = message || '';
}
function enterRoom(handle) {
  net = handle;
  session = { code: handle.code, role: handle.role, token: handle.token || null, playerId: handle.playerId };
  write(SESSION_KEY, session);
  setUrl(handle.code);
  $('#homeError').textContent = '';
}
window.addEventListener('beforeunload', e => {
  if (session && session.role === 'host') { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- home ---------- */
function getName() {
  const name = $('#nameInput').value.trim();
  if (!name) { $('#homeError').textContent = 'Pick a screen name first.'; $('#nameInput').focus(); return null; }
  write(NAME_KEY, name);
  return name;
}
$('#createBtn').onclick = async () => {
  const name = getName(); if (!name) return;
  const b = $('#createBtn'); b.disabled = true;
  $('#homeError').textContent = 'Opening a room…';
  try { enterRoom(await window.LeverageNet.createHost(name, callbacks)); }
  catch (e) { $('#homeError').textContent = e.message; }
  finally { b.disabled = false; }
};
$('#joinForm').onsubmit = async e => {
  e.preventDefault();
  const name = getName(); if (!name) return;
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(code)) { $('#homeError').textContent = 'Room codes are five letters.'; $('#codeInput').focus(); return; }
  const b = e.submitter; if (b) b.disabled = true;
  $('#homeError').textContent = 'Connecting to the room…';
  try { enterRoom(await window.LeverageNet.joinRoom(code, name, null, callbacks)); }
  catch (err) { $('#homeError').textContent = err.message; }
  finally { if (b) b.disabled = false; }
};
$('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

/* ---------- shared controls ---------- */
$$('[data-rules]').forEach(b => b.onclick = () => { $('#rules').hidden = false; $('#rulesClose').focus(); });
$('#rulesClose').onclick = () => { $('#rules').hidden = true; };
$$('[data-leave]').forEach(b => b.onclick = async () => {
  if (!session) return;
  if (session.role === 'host') {
    if (!confirm('Close the room? It ends the game for everyone, because the room runs in your browser.')) return;
  } else if (state && state.phase === 'playing' && !confirm('Leave the game? A bot will take over your seat.')) return;
  await act('leave');
  leaveLocally('');
});
$('#copyLink').onclick = async () => {
  const link = roomLink(state.code);
  try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
  catch { toast(link); }
};

/* ---------- helpers on state ---------- */
const me = () => state.you;
const pinfo = id => state.players.find(p => p.id === id) || { name: 'Someone', bot: false, connected: false };
const pname = id => id === me() ? 'You' : pinfo(id).name;
const possessive = id => id === me() ? 'your' : `${pinfo(id).name}’s`;
const clueLabel = (owner, trait) => `${possessive(owner)} ${trait.toLowerCase()}`;
const isHost = () => state.hostId === me();
const seat = id => state.game.seats.find(s => s.id === id);
const clock = deadline => deadline ? `<span class="clock" data-deadline="${deadline}"></span>` : '';

/* ---------- render ---------- */
function render() {
  if (!state) return;
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); $('#decision').hidden = true; ui.modalKey = null; ui.lastEvent = null; ui.logLen = null; }
  else { show('game'); renderGame(); }
  tick();
}
function renderStatus() {
  if (!state || !state.game) return;
  const g = state.game;
  let text;
  if (!connected) text = 'Reconnecting…';
  else if (state.phase === 'ended') text = 'Game over.';
  else text = `Round ${g.round} of ${g.maxRounds}. ${g.turn === me() ? 'Your turn.' : pinfo(g.turn).name + '’s turn.'}`;
  $('#status').textContent = text;
}

function renderLobby() {
  $('#roomCode').textContent = state.code;
  $('#hostNote').hidden = !(session && session.role === 'host');
  const n = state.players.length, { min, max } = state.limits;
  $('#playerCount').textContent = `Players (${n} of ${max})`;
  $('#playerList').innerHTML = state.players.map(p => `
    <li>
      <span class="mini-avatar">${esc(p.name[0] || '?')}</span>
      <span class="pname">${esc(p.name)}${p.id === me() ? ' (you)' : ''}</span>
      ${p.id === state.hostId ? '<span class="badge host">Host</span>' : ''}
      ${p.bot ? '<span class="badge">Bot</span>' : ''}
      ${!p.connected ? '<span class="badge off">Offline</span>' : ''}
      ${isHost() && p.id !== me() ? `<button class="icon-btn" data-remove="${esc(p.id)}">Remove</button>` : ''}
    </li>`).join('');
  $$('[data-remove]').forEach(b => b.onclick = () => act('remove', { playerId: b.dataset.remove }));
  const need = Math.max(0, min - n);
  if (isHost()) {
    $('#lobbyControls').innerHTML = `
      <button class="btn ghost" id="addBot" ${n >= max ? 'disabled' : ''}>Add a bot</button>
      <button class="btn" id="startBtn" ${need ? 'disabled' : ''}>Start game</button>
      <p class="lobby-note">${need ? `Waiting for ${need} more player${need === 1 ? '' : 's'}. Games need ${min} to ${max}.` : 'Everyone’s here. Start whenever you’re ready.'}</p>`;
    $('#addBot').onclick = () => act('addBot');
    $('#startBtn').onclick = () => act('start');
  } else {
    $('#lobbyControls').innerHTML = `<p class="lobby-note">${need ? `Waiting for ${need} more player${need === 1 ? '' : 's'}.` : ''} ${esc(pinfo(state.hostId).name)} will start the game.</p>`;
  }
}

function renderGame() {
  const g = state.game;
  if (!g) return;
  if (ui.sel != null && (!seat(ui.sel) || !seat(ui.sel).alive || ui.sel === me())) ui.sel = null;
  renderStatus();
  renderTable(g);
  renderSide(g);
  renderBar(g);
  renderDecision(g);
  animateEvents(g);
  measureBar();
}
function measureBar() {
  const h = document.querySelector('.actionbar').offsetHeight;
  if (h && h !== ui.barH) { ui.barH = h; document.documentElement.style.setProperty('--bar-h', `${h}px`); }
}
window.addEventListener('resize', measureBar);

/* ---------- phone panel tabs ---------- */
// On phones the tabs open and close a sheet over the table; on wider screens they
// just switch which panel shows.
const phone = window.matchMedia('(max-width: 920px)');
function setTab(name, open) {
  const lay = $('#layout');
  if (phone.matches) {
    const isOpen = lay.dataset.sheet === 'open';
    if (open === undefined) open = !(isOpen && lay.dataset.mtab === name);
    lay.dataset.sheet = open ? 'open' : '';
  }
  lay.dataset.mtab = name;
  $$('.mtabs [data-mtab]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.mtab === name && (!phone.matches || lay.dataset.sheet === 'open')));
  });
}
$$('.mtabs [data-mtab]').forEach(b => b.onclick = () => setTab(b.dataset.mtab));

/* ---------- color templates ---------- */
const PALETTES = [
  { id: '', name: 'Interrogation', note: 'Follows your device’s light or dark mode', table: '#323a4a', rim: '#1f2531', a: '#a8261b', b: '#2f5d50' },
  { id: 'midnight', name: 'Midnight', table: '#1b2a4a', rim: '#0a1020', a: '#ff7a59', b: '#5fd0b0' },
  { id: 'evidence', name: 'Evidence board', table: '#7f5536', rim: '#4f3220', a: '#b3261e', b: '#2e6b5a' },
  { id: 'noir', name: 'Noir', table: '#1d1d1d', rim: '#000000', a: '#e0393e', b: '#d6d6d6' },
  { id: 'neon', name: 'Neon', table: '#24104a', rim: '#0b0518', a: '#ff3d8b', b: '#2de2e6' },
  { id: 'daylight', name: 'Daylight', table: '#2f4b7c', rim: '#1c2f52', a: '#d1495b', b: '#2a7f62' }
];
function currentPalette() { return document.documentElement.dataset.palette || ''; }
function setPalette(id) {
  if (id) document.documentElement.dataset.palette = id; else delete document.documentElement.dataset.palette;
  try { id ? localStorage.setItem('leverage:palette', id) : localStorage.removeItem('leverage:palette'); } catch {}
  renderSwatches();
}
function renderSwatches() {
  const cur = currentPalette();
  $('#swatches').innerHTML = PALETTES.map(p => `
    <button class="swatch" data-palette="${p.id}" aria-pressed="${p.id === cur}" title="${esc(p.note || p.name)}">
      <span class="preview" style="background:${p.table};border-color:${p.rim}"><i style="background:${p.a}"></i><i style="background:${p.b}"></i></span>
      ${esc(p.name)}
    </button>`).join('');
  $$('#swatches [data-palette]').forEach(b => b.onclick = () => setPalette(b.dataset.palette));
}
$$('[data-colors]').forEach(b => b.onclick = () => { renderSwatches(); $('#colors').hidden = false; $('#colorsClose').focus(); });
$('#colorsClose').onclick = () => { $('#colors').hidden = true; };
/* ---------- animations ---------- */
// The host sends a short list of table events (who gave a card to whom). New ones play
// as cards flying between seats, drawn on a layer above the page so re-rendering the
// table doesn't cut them off.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function animateEvents(g) {
  const evs = g.events || [];
  const last = evs.length ? evs[evs.length - 1].id : 0;
  if (ui.lastEvent == null || last < ui.lastEvent) { ui.lastEvent = last; return; } // first view, or a new game
  const fresh = evs.filter(e => e.id > ui.lastEvent);
  ui.lastEvent = last;
  let delay = 0;
  for (const e of fresh) { setTimeout(() => playEvent(e), delay); delay += e.type === 'deal' ? 350 : 200; }
}
function spot(id) {
  const el = id === 'public' ? document.querySelector('#table .center h2') : document.querySelector(`.seat-wrap[data-seat="${CSS.escape(id)}"] .avatar`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function fxEl(cls, text) { const d = document.createElement('div'); d.className = cls; if (text) d.textContent = text; $('#fx').appendChild(d); return d; }
function play(el, frames, opts) { const anim = el.animate(frames, { fill: 'both', ...opts }); anim.onfinish = () => el.remove(); }
function fly(from, to, cls, text, delay = 0) {
  const a = spot(from), b = spot(to);
  if (!a || !b) return;
  const el = fxEl('flycard' + (cls ? ' ' + cls : ''), text);
  const rot = (Math.random() * 16 - 8).toFixed(1);
  play(el, [
    { transform: `translate(${a.x}px,${a.y}px) scale(.5)`, opacity: 0 },
    { transform: `translate(${a.x}px,${a.y}px) scale(1)`, opacity: 1, offset: .15 },
    { transform: `translate(${b.x}px,${b.y}px) scale(1) rotate(${rot}deg)`, opacity: 1, offset: .85 },
    { transform: `translate(${b.x}px,${b.y}px) scale(.6) rotate(${rot}deg)`, opacity: 0 }
  ], { duration: reduceMotion.matches ? 1 : 1000, delay, easing: 'cubic-bezier(.3,.7,.25,1)' });
}
function ring(id, cls, delay = 0) {
  const p = spot(id);
  if (!p || reduceMotion.matches) return;
  play(fxEl('ring' + (cls ? ' ' + cls : '')), [
    { transform: `translate(${p.x}px,${p.y}px) scale(.8)`, opacity: .9 },
    { transform: `translate(${p.x}px,${p.y}px) scale(1.7)`, opacity: 0 }
  ], { duration: 800, delay, easing: 'ease-out' });
}
function label(id, text) {
  const p = spot(id);
  if (!p) return;
  const at = dy => `translate(${p.x}px,${p.y - dy}px) translate(-50%,-50%)`;
  play(fxEl('fx-label', text), [
    { transform: `${at(40)} scale(.8)`, opacity: 0 },
    { transform: `${at(52)} scale(1)`, opacity: 1, offset: .2 },
    { transform: `${at(58)} scale(1)`, opacity: 1, offset: .8 },
    { transform: `${at(64)} scale(1)`, opacity: 0 }
  ], { duration: 1500 });
}
function beam(from, to) {
  const a = spot(from), b = spot(to);
  if (!a || !b || reduceMotion.matches) return;
  const el = fxEl('beam');
  el.style.width = `${Math.hypot(b.x - a.x, b.y - a.y)}px`;
  const base = `translate(${a.x}px,${a.y}px) rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)`;
  play(el, [
    { transform: `${base} scaleX(0)`, opacity: 1 },
    { transform: `${base} scaleX(1)`, opacity: 1, offset: .4 },
    { transform: `${base} scaleX(1)`, opacity: 0 }
  ], { duration: 900, easing: 'ease-out' });
}
function playEvent(e) {
  switch (e.type) {
    case 'copy': ring(e.from, 'mine'); fly(e.from, e.to, 'copy'); break; // the target keeps theirs, so a copy flies
    case 'give': fly(e.from, e.to); break;
    case 'demand': beam(e.from, e.to); ring(e.to); label(e.to, 'Demand'); break;
    case 'refuse': label(e.from, 'Refused'); break;
    case 'leak': fly(e.from, 'public', 'leak', e.value); break;
    case 'arrest': ring(e.to); ring(e.to, '', 250); label(e.to, 'Imprisoned'); break;
    case 'deal': for (let i = 0; i < e.n; i++) fly(e.from, e.to, '', '', i * 140); break;
  }
}


function renderTable(g) {
  const order = g.seats.map(s => s.id);
  const mi = Math.max(0, order.indexOf(me()));
  const rot = order.slice(mi).concat(order.slice(0, mi));
  const n = rot.length;
  const latest = g.log.length ? g.log[g.log.length - 1].text : '';
  const pub = g.public.length
    ? `<div class="record">${g.public.map(c => `<span class="chip">${esc(clueLabel(c.owner, c.trait).replace(/^./, x => x.toUpperCase()))}: <span class="val">${esc(c.value)}</span></span>`).join('')}</div>`
    : '<div class="none">Nothing leaked yet</div>';
  const seats = rot.map((pid, i) => {
    const ang = (90 + i * 360 / n) * Math.PI / 180;
    const x = 50 + 50 * Math.cos(ang), y = 50 + 50 * Math.sin(ang);
    return seatHTML(seat(pid), x, y, g);
  }).join('');
  const t = $('#table');
  t.classList.toggle('crowded', n >= 6);
  t.innerHTML = `<div class="center"><h2>Public record</h2>${pub}<div class="latest">${esc(latest)}</div></div>${seats}`;
  t.querySelectorAll('[data-arrest]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    b.disabled = true;
    act('arrest', { target: b.dataset.arrest });
  });
  t.querySelectorAll('button.seat').forEach(b => b.onclick = () => {
    const id = b.dataset.pid;
    ui.sel = ui.sel === id ? null : id;
    if (ui.sel) setTab('notes', phone.matches ? $('#layout').dataset.sheet === 'open' : undefined);
    renderGame(); tick();
  });
}
function seatHTML(s, x, y, g) {
  const p = pinfo(s.id), mine = s.id === me();
  const waiting = state.phase === 'playing' && g.waitingOn === s.id;
  let meta = '', dots = '';
  if (!s.alive) meta = 'In prison';
  else {
    meta = `Holding ${s.hand} clue${s.hand === 1 ? '' : 's'}`;
    if (!mine) {
      if (s.progress === 3) meta += '<br><span class="danger">One clue from prison</span>';
      dots = `<span class="dots" aria-label="You have ${s.progress} of 4 clues on ${esc(p.name)}">${[0, 1, 2, 3].map(i => `<span class="dot${i < s.progress ? ' on' : ''}"></span>`).join('')}</span>`;
    }
  }
  if (p.bot && !mine) meta += '<br>Bot';
  else if (!p.connected && !mine) meta += '<br><span class="danger">Offline</span>';
  let short = s.alive ? `${s.hand} clue${s.hand === 1 ? '' : 's'}` : 'In prison';
  if (waiting) { meta = `${mine ? 'Your move' : 'Deciding'} ${clock(g.deadline)}`; short = clock(g.deadline); }
  const cls = `seat${mine ? ' you' : ''}${waiting ? ' waiting' : ''}${s.alive ? '' : ' dead'}${!p.connected ? ' away' : ''}`;
  const inner = `<span class="tag${s.tag ? '' : ' blank'}">${esc(s.tag || '.')}</span>
    <span class="avatar">${mine ? 'You' : esc(p.name[0] || '?')}</span>
    <span class="plate"><b>${esc(mine ? 'You' : p.name)}</b><small class="m-long">${meta}</small><small class="m-short">${short}</small>${dots}</span>
    ${s.alive ? '' : '<span class="stamp">Imprisoned</span>'}`;
  const style = `style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%"`;
  const arrest = s.canArrest && state.phase === 'playing'
    ? `<button class="arrest" data-arrest="${esc(s.id)}" aria-label="Imprison ${esc(p.name)}">Imprison</button>` : '';
  if (mine) return `<div class="seat-wrap" data-seat="${esc(s.id)}" ${style}><div class="${cls}">${inner}</div></div>`;
  return `<div class="seat-wrap" data-seat="${esc(s.id)}" ${style}>${arrest}<button class="${cls}" data-pid="${esc(s.id)}" aria-pressed="${ui.sel === s.id}" aria-label="${esc(p.name)}" ${s.alive ? '' : 'disabled'}>${inner}</button></div>`;
}

function slotHTML(trait, valueHTML) { return `<div class="slot"><span class="t">${esc(trait)}</span><span>${valueHTML}</span></div>`; }
function seenText(id) { return id ? `Last seen with ${id === me() ? 'you' : esc(pinfo(id).name)}` : ''; }
function renderSide(g) {
  $('#myCrime').innerHTML = g.myCrime.map(c => {
    const where = c.status === 'public' ? '<span class="danger">On the public record</span>'
      : c.seenWith ? seenText(c.seenWith) : 'Somewhere out there';
    return slotHTML(c.trait, `<span class="val">${esc(c.value)}</span><span class="hint">${where}</span>`);
  }).join('');

  // Case notes show only the suspect you've tapped, so the panel never needs scrolling.
  const sel = ui.sel ? g.seats.find(s => s.id === ui.sel) : null;
  if (sel) {
    const name = pinfo(sel.id).name;
    $('#notesTitle').textContent = `Case notes on ${name}`;
    const status = sel.canArrest ? '<p class="case-status hot">You have every clue. Press Imprison above their seat.</p>'
      : `<p class="case-status">You have ${sel.progress} of 4 clues on ${esc(name)}’s crime.</p>`;
    $('#caseNotes').innerHTML = status + g.cases[sel.id].map((c, i) => {
      if (c.status === 'public') return slotHTML(c.trait, `<span class="val pub">${esc(c.value)}</span><span class="hint">On the public record</span>`);
      if (c.status === 'mine') return slotHTML(c.trait, `<span class="val">${esc(c.value)}</span><span class="hint">You hold this</span>`);
      return slotHTML(c.trait, `<span class="redact" style="width:${45 + (c.cid * 37 + i * 11) % 45}%"></span><span class="hint">${seenText(c.seenWith)}</span>`);
    }).join('');
  } else {
    $('#notesTitle').textContent = 'Case notes';
    $('#caseNotes').innerHTML = '<p class="empty">Tap a suspect at the table to see what you have on them.</p>';
  }

  const logEl = $('#log');
  const atTop = logEl.scrollTop < 8;
  const fresh = Math.max(0, g.log.length - (ui.logLen == null ? g.log.length : ui.logLen));
  ui.logLen = g.log.length;
  logEl.innerHTML = g.log.slice().reverse().map((e, i) => `<li class="${esc(e.kind)}${i < fresh ? ' fresh' : ''}">${esc(e.text)}</li>`).join('');
  if (atTop) logEl.scrollTop = 0;
}

// Demands name a suspect, not a clue: the target hands over a random clue on that
// suspect's crime that you don't have yet.
function demandOptions(g) {
  return g.seats
    .filter(s => s.alive && s.id !== me() && s.id !== ui.sel && s.progress < 4) // nobody holds their own clues
    .map(s => `<option value="${esc(s.id)}">A clue on ${esc(pinfo(s.id).name)}’s crime (you have ${s.progress} of 4)</option>`)
    .join('');
}

function renderBar(g) {
  const bar = $('#actionbar');
  const mySeat = seat(me());
  if (state.phase === 'ended') {
    const w = g.end.winnerId, iWon = w === me();
    const title = iWon ? 'You win' : `${pinfo(w).name} wins`;
    const body = g.end.reason === 'last'
      ? (iWon ? 'Everyone else is behind bars, and your crime stays unsolved.' : `${pinfo(w).name} is the last suspect still free.`)
      : `Time ran out after ${g.maxRounds} rounds. ${iWon ? 'You' : pinfo(w).name} came closest to solving a crime.`;
    bar.innerHTML = `<div class="ab-info"><b>${esc(title)}</b><span>${esc(body)}</span></div>
      <div class="ab-controls">${isHost()
        ? '<button class="act" id="again">Play again</button><button class="act ghost" id="toLobby">Back to lobby</button>'
        : `<span class="muted">Waiting for ${esc(pinfo(state.hostId).name)} to start the next game.</span>`}</div>`;
    if (isHost()) { $('#again').onclick = () => act('start'); $('#toLobby').onclick = () => act('lobby'); }
    return;
  }
  if (mySeat && !mySeat.alive) {
    bar.innerHTML = `<div class="ab-info"><b>You’re in prison</b><span>Someone pieced together your crime. You can keep watching until the game ends.</span></div>`;
    return;
  }
  const pd = g.pending;
  const myTurn = g.turn === me() && !pd;
  const t = ui.sel;
  const tSeat = t ? seat(t) : null;
  let info;
  if (pd && pd.type === 'respond') {
    info = pd.target === me() ? `<b>${esc(pinfo(pd.actor).name)} is making a demand</b><span>Answer it in the window that’s open.</span>`
      : `<b>Waiting on ${esc(pname(pd.target))}</b><span>${esc(pname(pd.actor))} demanded a clue about ${esc(possessive(pd.about))} crime. ${clock(g.deadline)}</span>`;
  } else if (pd && pd.type === 'follow') {
    info = pd.actor === me() ? `<b>They refused</b><span>Decide whether to leak a clue in the window that’s open.</span>`
      : `<b>Waiting on ${esc(pname(pd.actor))}</b><span>${esc(pname(pd.target))} refused. Will ${esc(pname(pd.actor))} follow through? ${clock(g.deadline)}</span>`;
  } else if (!myTurn) {
    info = `<b>${esc(pinfo(g.turn).name)}’s turn</b><span>Watch the table. ${clock(g.deadline)}</span>`;
  } else if (!t) {
    info = `<b>Your turn ${clock(g.deadline)}</b><span>Tap a suspect at the table to target them.</span>`;
  } else {
    const lev = g.myHand.filter(c => c.owner === t && !g.public.some(p => p.cid === c.cid)).length;
    const noTake = tSeat && !tSeat.takeable && tSeat.hand ? ` ${esc(pinfo(t).name)} has nothing new you can copy.` : '';
    const name = pinfo(t).name;
    info = `<b>Target: ${esc(name)} ${clock(g.deadline)}</b><span class="${lev ? '' : 'bluff'}">${lev
      ? `You hold ${lev} clue${lev === 1 ? '' : 's'} on ${esc(name)}, so a threat is real.`
      : `You hold nothing on ${esc(name)}. A threat would be a bluff.`}${noTake}</span>`;
  }
  const ready = g.seats.filter(s => s.canArrest).map(s => pinfo(s.id).name);
  if (ready.length) info += `<span class="ready">You have every clue on ${esc(ready.join(' and '))}. Press Imprison above ${ready.length === 1 ? 'them' : 'a suspect'} whenever you like.</span>`;
  const can = myTurn && t;
  const opts = can ? demandOptions(g) : '';
  bar.innerHTML = `<div class="ab-info">${info}</div>
    <div class="ab-controls">
      <select id="demandSel" aria-label="Whose crime to demand a clue about" ${can && opts ? '' : 'disabled'}>${opts || '<option>Demand a clue about someone’s crime</option>'}</select>
      <button class="act demand" id="demBtn" ${can && opts ? '' : 'disabled'}>Demand</button>
      <button class="act" id="randBtn" ${can && tSeat && tSeat.takeable ? '' : 'disabled'}>Copy random</button>
      <button class="act ghost" id="passBtn" ${myTurn ? '' : 'disabled'}>Pass</button>
    </div>`;
  const sel = $('#demandSel');
  if (ui.demand != null && [...sel.options].some(o => o.value === ui.demand)) sel.value = ui.demand;
  sel.onchange = () => { ui.demand = sel.value; };
  $('#demBtn').onclick = () => { ui.demand = null; act('demand', { target: t, about: sel.value }); };
  $('#randBtn').onclick = () => act('random', { target: t });
  $('#passBtn').onclick = () => act('pass');
}

function renderDecision(g) {
  const pd = state.phase === 'playing' ? g.pending : null;
  let key = null;
  if (pd && pd.type === 'respond' && pd.target === me()) key = `r:${pd.actor}:${pd.about}:${g.round}:${g.turn}`;
  if (pd && pd.type === 'follow' && pd.actor === me()) key = `f:${pd.target}:${pd.about}:${g.round}:${g.turn}`;
  const box = $('#decision');
  $('#dTimer').dataset.deadline = g.deadline || '';
  if (!key) { box.hidden = true; ui.modalKey = null; return; }
  if (key === ui.modalKey) return;
  ui.modalKey = key;
  const btns = $('#dBtns');
  btns.innerHTML = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = () => { box.hidden = true; fn(); };
    btns.appendChild(b);
  };
  if (pd.type === 'respond') {
    const from = pinfo(pd.actor).name;
    const whose = pinfo(pd.about).name;
    $('#dTitle').textContent = `${from} wants a clue about ${whose}’s crime`;
    $('#dBody').textContent = `If you hand one over, ${from} gets a random clue you hold about ${whose}’s crime that they don’t have yet. Refuse, and you risk ${from} leaking a clue about your crime. ${pd.outThere} of your clues ${pd.outThere === 1 ? 'is' : 'are'} somewhere out there, so ${from} may or may not be bluffing.`;
    add('Hand one over', '', () => act('respond', { comply: true }));
    add('Refuse', 'ghost', () => act('respond', { comply: false }));
  } else {
    const who = pinfo(pd.target).name;
    $('#dTitle').textContent = `${who} refused`;
    $('#dBody').textContent = 'You can leak a clue about their crime. It goes on the public record and counts for every player, not just you.';
    pd.options.forEach(o => add(`Leak their ${o.trait.toLowerCase()} (${o.value})`, 'danger', () => act('follow', { clue: o.cid })));
    add('Hold back', 'ghost', () => act('follow', { clue: null }));
  }
  box.hidden = false;
  btns.firstChild.focus();
}

/* ---------- clocks ---------- */
function tick() {
  const now = Date.now() + offset;
  $$('[data-deadline]').forEach(el => {
    const d = Number(el.dataset.deadline);
    el.textContent = d ? `${Math.max(0, Math.ceil((d - now) / 1000))}s` : '';
  });
}
setInterval(tick, 250);

/* ---------- start up ---------- */
session = read(SESSION_KEY);
const params = new URLSearchParams(location.search);
const urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
$('#nameInput').value = read(NAME_KEY) || '';
$('#codeInput').value = urlCode;
show('home');
if (session && session.role === 'guest' && urlCode === session.code) {
  $('#homeError').textContent = 'Reconnecting to your room…';
  window.LeverageNet.joinRoom(session.code, read(NAME_KEY) || 'Player', session.token, callbacks)
    .then(h => { enterRoom(h); })
    .catch(() => { write(SESSION_KEY, null); session = null; $('#homeError').textContent = 'That room isn’t open anymore.'; });
} else if (session && session.role === 'host') {
  write(SESSION_KEY, null); session = null;
  $('#homeError').textContent = 'Your last room closed when you left the page.';
  $('#codeInput').value = '';
  setUrl(null);
} else if (session) { write(SESSION_KEY, null); session = null; }
})();
