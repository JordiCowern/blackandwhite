(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SESSION_KEY = 'leverage:session', NAME_KEY = 'leverage:name';

let session = read(SESSION_KEY);
let state = null;
let es = null;
let offset = 0;        // server clock minus local clock
let connected = true;
const ui = { sel: null, demand: null, modalKey: null };

function read(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function write(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} }

async function post(url, body) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch { throw new Error('Can’t reach the server. Check your connection and try again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
  return j;
}
function act(type, extra = {}) {
  if (!session) return Promise.resolve();
  return post(`/api/rooms/${session.code}/action`, { token: session.token, type, ...extra }).catch(e => toast(e.message));
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
function connect() {
  if (es) es.close();
  es = new EventSource(`/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`);
  es.onmessage = e => {
    const s = JSON.parse(e.data);
    offset = s.serverNow - Date.now();
    state = s;
    connected = true;
    render();
  };
  es.addEventListener('gone', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch {}
    leaveLocally(d.message || 'That room has closed.');
  });
  es.onerror = () => { connected = false; renderStatus(); };
  es.onopen = () => { connected = true; renderStatus(); };
}
function leaveLocally(message) {
  if (es) { es.close(); es = null; }
  session = null; state = null; ui.sel = null; ui.demand = null; ui.modalKey = null;
  write(SESSION_KEY, null);
  $('#decision').hidden = true;
  history.replaceState(null, '', location.pathname);
  show('home');
  $('#homeError').textContent = message || '';
}
function enterRoom(res) {
  session = { code: res.code, token: res.token, playerId: res.playerId };
  write(SESSION_KEY, session);
  history.replaceState(null, '', `?room=${res.code}`);
  $('#homeError').textContent = '';
  connect();
}

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
  try { enterRoom(await post('/api/rooms', { name })); }
  catch (e) { $('#homeError').textContent = e.message; }
  finally { b.disabled = false; }
};
$('#joinForm').onsubmit = async e => {
  e.preventDefault();
  const name = getName(); if (!name) return;
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!/^[A-Z]{5}$/.test(code)) { $('#homeError').textContent = 'Room codes are five letters.'; $('#codeInput').focus(); return; }
  try { enterRoom(await post(`/api/rooms/${code}/join`, { name })); }
  catch (err) { $('#homeError').textContent = err.message; }
};
$('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

/* ---------- shared controls ---------- */
$$('[data-rules]').forEach(b => b.onclick = () => { $('#rules').hidden = false; $('#rulesClose').focus(); });
$('#rulesClose').onclick = () => { $('#rules').hidden = true; };
$$('[data-leave]').forEach(b => b.onclick = async () => {
  if (!session) return;
  if (state && state.phase === 'playing' && !confirm('Leave the game? A bot will take over your seat.')) return;
  await act('leave');
  leaveLocally('');
});
$('#copyLink').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
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
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); $('#decision').hidden = true; ui.modalKey = null; }
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
  t.querySelectorAll('button.seat').forEach(b => b.onclick = () => {
    const id = b.dataset.pid;
    ui.sel = ui.sel === id ? null : id;
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
  if (mine) return `<div class="${cls}" ${style}>${inner}</div>`;
  return `<button class="${cls}" ${style} data-pid="${esc(s.id)}" aria-pressed="${ui.sel === s.id}" aria-label="${esc(p.name)}" ${s.alive ? '' : 'disabled'}>${inner}</button>`;
}

function slotHTML(trait, valueHTML) { return `<div class="slot"><span class="t">${esc(trait)}</span><span>${valueHTML}</span></div>`; }
function seenText(id) { return id ? `Last seen with ${id === me() ? 'you' : esc(pinfo(id).name)}` : ''; }
function renderSide(g) {
  $('#myCrime').innerHTML = g.myCrime.map(c => {
    const where = c.status === 'public' ? '<span class="danger">On the public record</span>'
      : c.seenWith ? seenText(c.seenWith) : 'Somewhere out there';
    return slotHTML(c.trait, `<span class="val">${esc(c.value)}</span><span class="hint">${where}</span>`);
  }).join('');

  $('#hand').innerHTML = g.myHand.length ? g.myHand.map(c =>
    `<div class="card${!c.ownerFree ? ' gone' : ''}"><b>${esc(clueLabel(c.owner, c.trait).replace(/^./, x => x.toUpperCase()))}${c.copies > 1 ? ` (${c.copies} copies)` : ''}</b><span class="val">${esc(c.value)}</span>${!c.ownerFree ? '<span class="hint">Already in prison</span>' : ''}</div>`
  ).join('') : '<p class="empty">You’re holding no clues. Take one from someone to get started.</p>';

  if (ui.sel) {
    const name = pinfo(ui.sel).name;
    $('#caseTitle').textContent = `Case notes on ${name}`;
    $('#caseNotes').innerHTML = g.cases[ui.sel].map((c, i) => {
      if (c.status === 'public') return slotHTML(c.trait, `<span class="val pub">${esc(c.value)}</span><span class="hint">On the public record</span>`);
      if (c.status === 'mine') return slotHTML(c.trait, `<span class="val">${esc(c.value)}</span><span class="hint">You hold this</span>`);
      return slotHTML(c.trait, `<span class="redact" style="width:${45 + (c.cid * 37 + i * 11) % 45}%"></span><span class="hint">${seenText(c.seenWith)}</span>`);
    }).join('');
  } else {
    $('#caseTitle').textContent = 'Case notes';
    $('#caseNotes').innerHTML = '<p class="empty">Tap a suspect at the table to see what you have on them.</p>';
  }

  const logEl = $('#log');
  const atTop = logEl.scrollTop < 8;
  logEl.innerHTML = g.log.slice().reverse().map(e => `<li class="${esc(e.kind)}">${esc(e.text)}</li>`).join('');
  if (atTop) logEl.scrollTop = 0;
}

function demandOptions(g) {
  const groups = [];
  // Nobody holds clues about their own crime, so the target's own clues aren't offered.
  g.seats.filter(s => s.alive && s.id !== me() && s.id !== ui.sel).forEach(s => {
    const items = g.cases[s.id].filter(c => c.status === 'hidden');
    if (items.length) groups.push({ label: `Clues on ${pinfo(s.id).name}’s crime`, owner: s.id, items });
  });
  return groups.map(gr => `<optgroup label="${esc(gr.label)}">${gr.items.map(c =>
    `<option value="${c.cid}">${esc(clueLabel(gr.owner, c.trait).replace(/^./, x => x.toUpperCase()))}${c.seenWith ? ` (last seen with ${c.seenWith === me() ? 'you' : esc(pinfo(c.seenWith).name)})` : ''}</option>`).join('')}</optgroup>`).join('');
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
      : `<b>Waiting on ${esc(pname(pd.target))}</b><span>${esc(pname(pd.actor))} demanded ${esc(clueLabel(pd.clue.owner, pd.clue.trait))}. ${clock(g.deadline)}</span>`;
  } else if (pd && pd.type === 'follow') {
    info = pd.actor === me() ? `<b>They refused</b><span>Decide whether to leak a clue in the window that’s open.</span>`
      : `<b>Waiting on ${esc(pname(pd.actor))}</b><span>${esc(pname(pd.target))} refused. Will ${esc(pname(pd.actor))} follow through? ${clock(g.deadline)}</span>`;
  } else if (!myTurn) {
    info = `<b>${esc(pinfo(g.turn).name)}’s turn</b><span>Watch the table. ${clock(g.deadline)}</span>`;
  } else if (!t) {
    info = `<b>Your turn ${clock(g.deadline)}</b><span>Tap a suspect at the table to target them.</span>`;
  } else {
    const lev = g.myHand.filter(c => c.owner === t && !g.public.some(p => p.cid === c.cid)).length;
    const noTake = tSeat && !tSeat.takeable && tSeat.hand ? ` Everything ${esc(pinfo(t).name)} holds is about your crime, so there’s nothing to take.` : '';
    const name = pinfo(t).name;
    info = `<b>Target: ${esc(name)} ${clock(g.deadline)}</b><span class="${lev ? '' : 'bluff'}">${lev
      ? `You hold ${lev} clue${lev === 1 ? '' : 's'} on ${esc(name)}, so a threat is real.`
      : `You hold nothing on ${esc(name)}. A threat would be a bluff.`}${noTake}</span>`;
  }
  const can = myTurn && t;
  const opts = can ? demandOptions(g) : '';
  bar.innerHTML = `<div class="ab-info">${info}</div>
    <div class="ab-controls">
      <select id="demandSel" aria-label="Clue to demand" ${can && opts ? '' : 'disabled'}>${opts || '<option>Choose a clue to demand</option>'}</select>
      <button class="act demand" id="demBtn" ${can && opts ? '' : 'disabled'}>Demand</button>
      <button class="act" id="randBtn" ${can && tSeat && tSeat.takeable ? '' : 'disabled'}>Take random</button>
      <button class="act ghost" id="passBtn" ${myTurn ? '' : 'disabled'}>Pass</button>
    </div>`;
  const sel = $('#demandSel');
  if (ui.demand != null && [...sel.options].some(o => o.value === ui.demand)) sel.value = ui.demand;
  sel.onchange = () => { ui.demand = sel.value; };
  $('#demBtn').onclick = () => { ui.demand = null; act('demand', { target: t, clue: Number(sel.value) }); };
  $('#randBtn').onclick = () => act('random', { target: t });
  $('#passBtn').onclick = () => act('pass');
}

function renderDecision(g) {
  const pd = state.phase === 'playing' ? g.pending : null;
  let key = null;
  if (pd && pd.type === 'respond' && pd.target === me()) key = `r:${pd.actor}:${pd.clue.cid}:${g.round}:${g.turn}`;
  if (pd && pd.type === 'follow' && pd.actor === me()) key = `f:${pd.target}:${pd.clue.cid}:${g.round}:${g.turn}`;
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
    $('#dTitle').textContent = `${from} wants ${clueLabel(pd.clue.owner, pd.clue.trait)}`;
    $('#dBody').textContent = `Hand it over, or refuse and risk ${from} leaking a clue about your crime. ${pd.outThere} of your clues ${pd.outThere === 1 ? 'is' : 'are'} somewhere out there, so ${from} may or may not be bluffing.`;
    add('Hand it over', '', () => act('respond', { comply: true }));
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
const params = new URLSearchParams(location.search);
const urlCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
$('#nameInput').value = read(NAME_KEY) || '';
$('#codeInput').value = urlCode;
if (session && (!urlCode || urlCode === session.code)) connect();
else { if (session) write(SESSION_KEY, null); session = null; show('home'); }
})();
