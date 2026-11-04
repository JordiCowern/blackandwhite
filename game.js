'use strict';
// Game rules and room state. The server owns all state; each player only ever
// receives the view built for them by Room.view(), so hidden clues stay hidden.
const crypto = require('crypto');

const TRAITS = ['Crime', 'Crime scene', 'Motive', 'Witness'];
// Each pool needs at least MAX_PLAYERS entries so no two players share a value.
const POOLS = {
  'Crime': ['Art forgery', 'Jewel heist', 'Embezzlement', 'Smuggling', 'Bank fraud', 'Cat burglary', 'Counterfeiting', 'Stole the mayor’s prize goat', 'Insurance fraud', 'Fixed the bake-off'],
  'Crime scene': ['The museum', 'The docks', 'City hall', 'The casino', 'A sleeper train', 'The opera house', 'The botanical garden', 'The bakery', 'The racetrack', 'The lighthouse'],
  'Motive': ['Revenge', 'Gambling debt', 'Jealousy', 'Boredom', 'An inheritance', 'Ambition', 'Love', 'A dare', 'Blackmail', 'A family feud'],
  'Witness': ['The night guard', 'A taxi driver', 'A nosy neighbor', 'The bartender', 'A child with a camera', 'The postman', 'A street musician', 'A pigeon keeper', 'The janitor', 'A tourist']
};
const BOT_NAMES = ['Vera', 'Mott', 'Quill', 'Juno', 'Abel', 'Ines', 'Rook', 'Tamsin', 'Otto', 'Wren'];

const LIMITS = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 8,
  MAX_ROUNDS: 25,
  TURN_MS: 60000,     // time to take a turn
  RESPOND_MS: 30000,  // time to answer a demand
  FOLLOW_MS: 25000,   // time to decide whether to leak after a refusal
  AWAY_MS: 8000,      // shorter clock when the player who must act is disconnected
  BOT_MS: 1500,       // how long bots "think"
  BIG_GAME_FROM: 6,   // games with at least this many players use duplicate clue cards
  BIG_HAND: 6         // starting hand size in those games (4 clues + 2 second copies per crime)
};

const rnd = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');
function userError(msg) { const e = new Error(msg); e.userFacing = true; return e; }
function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.onRemove = null;        // (playerId, message) => void, set by the server
    this.players = [];           // seat order
    this.hostId = null;
    this.phase = 'lobby';        // lobby | playing | ended
    this.g = null;               // game state
    this.timer = null;
    this.step = 0;               // bumps on every game transition
    this.schedStep = -1;
    this.lastActive = Date.now();
  }

  /* ---------- players and lobby ---------- */
  P(id) { return this.players.find(p => p.id === id); }
  changed() { this.onChange(this); }
  activeHumans() { return this.players.filter(p => !p.bot && !p.left); }
  get totalConns() { return this.players.reduce((s, p) => s + p.conns, 0); }
  byToken(token) { return token ? this.players.find(p => p.token === token && !p.left) : undefined; }

  uniqueName(name) {
    const base = cleanName(name) || 'Player';
    let n = base, i = 2;
    while (this.players.some(p => p.name.toLowerCase() === n.toLowerCase())) n = `${base.slice(0, 13)} ${i++}`;
    return n;
  }
  addPlayer(name, bot = false) {
    const p = { id: newId(6), token: newId(18), name: this.uniqueName(name), bot, left: false, conns: 0 };
    this.players.push(p);
    if (!bot && !this.hostId) this.hostId = p.id;
    return p;
  }
  join(name) {
    if (!cleanName(name)) throw userError('Pick a screen name first.');
    if (this.phase !== 'lobby') throw userError('That game has already started.');
    if (this.players.length >= LIMITS.MAX_PLAYERS) throw userError('That room is full.');
    const p = this.addPlayer(name);
    this.changed();
    return p;
  }
  setConn(pid, delta) {
    const p = this.P(pid);
    if (!p) return;
    p.conns = Math.max(0, p.conns + delta);
    this.lastActive = Date.now();
    if (this.g && this.g.waitingOn === pid) this.schedule();
    this.changed();
  }
  leave(p) {
    if (this.phase === 'playing') {
      p.left = true; p.bot = true;
      this.log('sys', () => `${p.name} left the room. A bot takes over their seat.`);
      this.schedule();
    } else if (this.phase === 'ended') {
      p.left = true;
    } else {
      this.players = this.players.filter(q => q !== p);
    }
    if (this.hostId === p.id) { const h = this.activeHumans()[0]; this.hostId = h ? h.id : null; }
    if (this.onRemove) this.onRemove(p.id, 'You left the room.');
  }
  purgeLeft() { this.players = this.players.filter(p => !p.left); }
  destroy() { clearTimeout(this.timer); this.timer = null; this.onChange = () => {}; }

  handle(pid, msg) {
    const p = this.P(pid);
    if (!p || p.left) throw userError('You’re no longer in this room.');
    const type = msg && msg.type;
    const needHost = () => { if (pid !== this.hostId) throw userError('Only the host can do that.'); };
    switch (type) {
      case 'addBot': {
        needHost();
        if (this.phase !== 'lobby') throw userError('Bots can only be added in the lobby.');
        if (this.players.length >= LIMITS.MAX_PLAYERS) throw userError('The room is full.');
        const name = BOT_NAMES.find(n => !this.players.some(q => q.name === n)) || 'Bot';
        this.addPlayer(name, true);
        break;
      }
      case 'remove': {
        needHost();
        if (this.phase !== 'lobby') throw userError('Players can only be removed in the lobby.');
        const t = this.P(msg.playerId);
        if (!t || t.id === pid) throw userError('That player can’t be removed.');
        this.players = this.players.filter(q => q !== t);
        if (!t.bot && this.onRemove) this.onRemove(t.id, 'The host removed you from the room.');
        break;
      }
      case 'leave': this.leave(p); break;
      case 'start': {
        needHost();
        if (this.phase === 'playing') throw userError('The game is already running.');
        this.purgeLeft();
        const n = this.players.length;
        if (n < LIMITS.MIN_PLAYERS) throw userError(`You need at least ${LIMITS.MIN_PLAYERS} players to start.`);
        if (n > LIMITS.MAX_PLAYERS) throw userError(`A game holds at most ${LIMITS.MAX_PLAYERS} players.`);
        this.startGame();
        break;
      }
      case 'lobby': {
        needHost();
        if (this.phase !== 'ended') throw userError('You can return to the lobby once the game ends.');
        this.purgeLeft();
        this.phase = 'lobby'; this.g = null;
        break;
      }
      case 'random': this.cmdRandom(pid, msg.target); break;
      case 'demand': this.cmdDemand(pid, msg.target, msg.clue); break;
      case 'pass': this.requireTurn(pid); this.pass(pid, false); break;
      case 'respond': this.cmdRespond(pid, !!msg.comply); break;
      case 'follow': this.cmdFollow(pid, msg.clue); break;
      default: throw userError('Unknown action.');
    }
    this.lastActive = Date.now();
    this.changed();
  }

  /* ---------- game setup ---------- */
  // A "clue" is one fact about one player's crime. A "card" is a physical copy of a
  // clue. In big games two clues per crime get a second card, so hands are larger.
  startGame() {
    clearTimeout(this.timer);
    const order = this.players.map(p => p.id);
    const n = order.length;
    const handSize = n >= LIMITS.BIG_GAME_FROM ? LIMITS.BIG_HAND : TRAITS.length;
    const clues = [], cards = [], st = {};
    const pools = Object.fromEntries(TRAITS.map(t => [t, shuffle(POOLS[t].slice())]));
    order.forEach((pid, i) => {
      st[pid] = { alive: true, hand: [], secrets: [], refusals: 0, backdowns: 0, know: {}, tag: null };
      TRAITS.forEach(t => {
        const id = clues.length;
        clues.push({ id, owner: pid, trait: t, value: pools[t][i] });
        st[pid].secrets.push(id);
        cards.push({ id: cards.length, clue: id });
      });
      shuffle(st[pid].secrets.slice()).slice(0, handSize - TRAITS.length)
        .forEach(id => cards.push({ id: cards.length, clue: id }));
    });
    this.g = { order, st, clues, cards, handSize, pub: new Set(), turnIdx: 0, firstIdx: 0, round: 1, pending: null, log: [], end: null, deadline: null, waitingOn: null };
    this.deal();
    const first = Math.floor(Math.random() * n);
    Object.assign(this.g, { turnIdx: first, firstIdx: first });
    this.phase = 'playing';
    const f = order[first];
    const dup = handSize > TRAITS.length ? ` With this many players, two clues about each crime have a second copy, so everyone starts with ${handSize} cards.` : '';
    this.log('sys', v => `Game on. Every clue has been dealt, and nobody holds a clue about their own crime.${dup} ${this.nm(f, v)} ${this.vb(f, v, 'go', 'goes')} first.`);
    this.bump();
  }
  // Deal evenly. Nobody gets a card about their own crime, or two copies of one clue.
  deal() {
    const g = this.g;
    for (let tries = 0; tries < 2000; tries++) {
      const hands = Object.fromEntries(g.order.map(p => [p, []]));
      let ok = true;
      for (const card of shuffle(g.cards.slice())) {
        const owner = g.clues[card.clue].owner;
        const fits = g.order.filter(p => p !== owner && hands[p].length < g.handSize && !hands[p].some(c => g.cards[c].clue === card.clue));
        if (!fits.length) { ok = false; break; }
        const room = Math.max(...fits.map(p => g.handSize - hands[p].length));
        hands[rnd(fits.filter(p => g.handSize - hands[p].length === room))].push(card.id);
      }
      if (ok) { g.order.forEach(p => { g.st[p].hand = hands[p]; }); return; }
    }
    throw new Error('Could not deal a valid starting hand');
  }

  /* ---------- helpers ---------- */
  S(pid) { return this.g.st[pid]; }
  K(clue) { return this.g.clues[clue]; }                 // clue by id
  clueOf(card) { return this.g.cards[card].clue; }
  ownerOfCard(card) { return this.K(this.clueOf(card)).owner; }
  name(pid) { const p = this.P(pid); return p ? p.name : 'Someone'; }
  nm(pid, v, cap = true) { return pid === v ? (cap ? 'You' : 'you') : this.name(pid); }
  pos(pid, v) { return pid === v ? 'your' : `${this.name(pid)}’s`; }
  vb(pid, v, a, b) { return pid === v ? a : b; }
  lbl(clue, v) { const c = this.K(clue); return `${this.pos(c.owner, v)} ${c.trait.toLowerCase()}`; }
  cardFor(pid, clue) { return this.S(pid).hand.find(cd => this.clueOf(cd) === clue); }
  holds(pid, clue) { return this.cardFor(pid, clue) !== undefined; }
  has(pid, clue) { return this.holds(pid, clue) || this.g.pub.has(clue); }
  progress(pid, x) { return this.S(x).secrets.filter(c => this.has(pid, c)).length; }
  takeable(a, t) { return this.S(t).hand.filter(cd => this.ownerOfCard(cd) !== a); }
  leverage(a, t) { return [...new Set(this.S(a).hand.map(cd => this.clueOf(cd)).filter(c => this.K(c).owner === t && !this.g.pub.has(c)))]; }
  alive() { return this.g.order.filter(pid => this.S(pid).alive); }
  current() { return this.g.order[this.g.turnIdx]; }
  log(kind, fn) { if (!this.g) return; this.g.log.push({ kind, fn }); if (this.g.log.length > 300) this.g.log.shift(); }
  tag(pid, t) { this.S(pid).tag = t; }
  everyone(f) { this.g.order.forEach(pid => f(this.S(pid))); }
  move(card, from, to) {
    if (this.ownerOfCard(card) === to) throw new Error('A player was about to receive their own clue');
    const h = this.S(from).hand; h.splice(h.indexOf(card), 1); this.S(to).hand.push(card);
  }
  bump() { this.step++; this.schedule(); }

  /* ---------- validated commands ---------- */
  requireTurn(pid) {
    if (this.phase !== 'playing' || !this.g) throw userError('The game isn’t running.');
    if (this.g.pending) throw userError('Wait for the current demand to finish.');
    if (this.current() !== pid) throw userError('It’s not your turn.');
  }
  requireTarget(pid, t) {
    if (!this.g.st[t] || t === pid || !this.S(t).alive) throw userError('Pick another suspect who isn’t in prison.');
  }
  cmdRandom(pid, t) {
    this.requireTurn(pid); this.requireTarget(pid, t);
    if (!this.takeable(pid, t).length) throw userError('They aren’t holding anything you can take.');
    this.doRandom(pid, t);
  }
  cmdDemand(pid, t, clue) {
    this.requireTurn(pid); this.requireTarget(pid, t);
    const id = Number(clue);
    const c = Number.isInteger(id) ? this.g.clues[id] : undefined;
    if (!c) throw userError('You can’t demand that clue.');
    if (c.owner === pid) throw userError('You can’t demand a clue about your own crime.');
    if (c.owner === t) throw userError('Nobody ever holds a clue about their own crime.');
    if (this.has(pid, id) || !this.S(c.owner).alive) throw userError('You can’t demand that clue.');
    this.doDemand(pid, t, id);
  }
  cmdRespond(pid, comply) {
    const pd = this.g && this.g.pending;
    if (this.phase !== 'playing' || !pd || pd.type !== 'respond' || pd.target !== pid) throw userError('Nobody is waiting on you.');
    this.resolveRespond(comply, false);
  }
  cmdFollow(pid, clue) {
    const pd = this.g && this.g.pending;
    if (this.phase !== 'playing' || !pd || pd.type !== 'follow' || pd.actor !== pid) throw userError('Nobody is waiting on you.');
    let id = null;
    if (clue !== null && clue !== undefined) {
      id = Number(clue);
      if (!pd.options.includes(id) || !this.holds(pid, id)) throw userError('You can’t leak that clue.');
    }
    this.resolveFollow(id, false);
  }

  /* ---------- actions ---------- */
  doRandom(a, t) {
    const card = rnd(this.takeable(a, t));
    const clue = this.clueOf(card);
    this.move(card, t, a);
    this.S(t).know[clue] = a;
    const c = this.K(clue);
    this.tag(a, 'Took a clue');
    this.log('', v => v === a ? `You take a random clue from ${this.name(t)}: ${this.lbl(clue, v)}, “${c.value}”.`
      : v === t ? `${this.name(a)} takes a random clue from you: ${this.lbl(clue, v)}, “${c.value}”.`
      : `${this.name(a)} takes a random clue from ${this.name(t)}.`);
    this.endTurn(a);
  }
  doDemand(a, t, clue) {
    this.tag(a, 'Made a demand');
    this.log('demand', v => `${this.nm(a, v)} ${this.vb(a, v, 'demand', 'demands')} ${this.lbl(clue, v)} from ${this.nm(t, v, false)}, threatening to leak a clue about ${t === v ? 'you' : 'them'}.`);
    if (!this.holds(t, clue)) {
      this.tag(t, 'Didn’t have it');
      this.log('', v => `${this.nm(t, v)} ${this.vb(t, v, 'don’t', 'doesn’t')} have it.`);
      this.everyone(s => { if (s.know[clue] === t) delete s.know[clue]; });
      return this.endTurn(a);
    }
    this.g.pending = { type: 'respond', actor: a, target: t, clue };
    this.bump();
  }
  resolveRespond(comply, timedOut) {
    const { actor: a, target: t, clue } = this.g.pending;
    if (comply) {
      this.move(this.cardFor(t, clue), t, a);
      this.everyone(s => { s.know[clue] = a; });
      this.tag(t, 'Handed it over');
      this.log('', v => `${this.nm(t, v)} ${this.vb(t, v, 'hand', 'hands')} it over.`);
      return this.endTurn(a);
    }
    this.everyone(s => { s.know[clue] = t; });
    this.S(a).refusals++;
    this.tag(t, timedOut ? 'Timed out' : 'Refused');
    this.log('refuse', v => `${this.nm(t, v)} ${this.vb(t, v, 'refuse', 'refuses')}${timedOut ? ' (time ran out)' : ''}.`);
    const lev = this.leverage(a, t);
    if (!lev.length) { this.backDown(a, t, true, false); return this.endTurn(a); }
    this.g.pending = { type: 'follow', actor: a, target: t, clue, options: lev };
    this.bump();
  }
  resolveFollow(clue, timedOut) {
    const { actor: a, target: t } = this.g.pending;
    if (clue !== null) {
      const h = this.S(a).hand;
      h.splice(h.indexOf(this.cardFor(a, clue)), 1);
      this.g.pub.add(clue);
      this.everyone(s => { delete s.know[clue]; });
      const c = this.K(clue);
      this.tag(a, 'Leaked a clue');
      this.log('expose', v => `${this.nm(a, v)} ${this.vb(a, v, 'leak', 'leaks')} ${this.lbl(clue, v)}: “${c.value}”. It’s on the public record now.`);
    } else {
      this.backDown(a, t, false, timedOut);
    }
    this.endTurn(a);
  }
  backDown(a, t, bluff, timedOut) {
    this.S(a).backdowns++;
    this.tag(a, 'Backed down');
    this.log('', v => v === a && bluff ? `You hold nothing on ${this.name(t)}, so you back down.`
      : `${this.nm(a, v)} ${this.vb(a, v, 'back', 'backs')} down${v === a && timedOut ? ' (time ran out)' : ''}.`);
  }
  pass(pid, timedOut) {
    this.tag(pid, timedOut ? 'Timed out' : 'Passed');
    this.log('', v => `${this.nm(pid, v)} ${this.vb(pid, v, 'pass', 'passes')}${timedOut ? ' (time ran out)' : ''}.`);
    this.endTurn(pid);
  }
  endTurn(a) {
    this.g.pending = null;
    this.checkArrests(a);
    if (this.checkEnd()) return;
    this.advance();
  }
  advance() {
    const g = this.g, n = g.order.length;
    let i = g.turnIdx;
    do { i = (i + 1) % n; if (i === g.firstIdx) g.round++; } while (!this.S(g.order[i]).alive);
    g.turnIdx = i;
    if (g.round > LIMITS.MAX_ROUNDS) return this.endByTime();
    this.bump();
  }

  /* ---------- win and lose ---------- */
  checkArrests(actor) {
    const g = this.g;
    let changed = true;
    while (changed && this.alive().length > 1) {
      changed = false;
      const order = [actor, ...g.order.filter(p => p !== actor)];
      outer: for (const x of this.alive()) {
        for (const p of order) {
          if (p === x || !this.S(p).alive) continue;
          if (this.S(x).secrets.every(c => this.has(p, c))) {
            const sx = this.S(x);
            sx.alive = false;
            const taken = sx.hand.splice(0);
            this.everyone(s => taken.forEach(cd => { const c = this.clueOf(cd); if (s.know[c] === x) delete s.know[c]; }));
            const split = this.splitHand(taken, p, x);
            sx.tag = 'In prison';
            this.tag(p, 'Made an arrest');
            const n = taken.length, kept = (split.get(p) || []).length, given = [...split.values()].reduce((s, a) => s + a.length, 0), rest = given - kept;
            this.log('elim', v => {
              let t = `${this.nm(p, v)} ${this.vb(p, v, 'have', 'has')} every clue on ${this.pos(x, v)} crime. ${this.nm(x, v)} ${this.vb(x, v, 'go', 'goes')} to prison.`;
              if (!n) return t;
              t += ` ${this.nm(p, v)} ${this.vb(p, v, 'take', 'takes')} ${kept} of the ${n} clue${n === 1 ? '' : 's'} ${x === v ? 'you were' : 'they were'} holding`;
              return t + (rest ? `, and the other ${rest} ${rest === 1 ? 'is' : 'are'} handed out among the other suspects.` : '.');
            });
            for (const [pid, cds] of split) {
              this.log('', v => v === pid ? `From ${this.pos(x, v)} hand you receive ${cds.map(cd => { const c = this.clueOf(cd); return `${this.lbl(c, v)} (“${this.K(c).value}”)`; }).join(', ')}.` : null);
            }
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  // An arrest hands out the prisoner's cards: half (rounded up) to the arrester, the
  // rest at random to the other suspects still free. Nobody ever receives a card about
  // their own crime. A card nobody can take stays with the prisoner.
  splitHand(cards, p, x) {
    const out = new Map();
    const give = (pid, cd) => { if (!out.has(pid)) out.set(pid, []); out.get(pid).push(cd); this.S(pid).hand.push(cd); };
    const others = this.alive().filter(q => q !== p);
    const want = Math.ceil(cards.length / 2);
    const rest = [];
    for (const cd of shuffle(cards.slice())) {
      if ((out.get(p) || []).length < want && this.ownerOfCard(cd) !== p) give(p, cd); else rest.push(cd);
    }
    for (const cd of rest) {
      const owner = this.ownerOfCard(cd);
      const ok = others.filter(q => q !== owner);
      if (ok.length) give(rnd(ok), cd);
      else if (owner !== p) give(p, cd);
      else this.S(x).hand.push(cd);
    }
    return out;
  }
  checkEnd() {
    const al = this.alive();
    if (al.length === 1) { this.finish({ reason: 'last', winnerId: al[0] }); return true; }
    return false;
  }
  endByTime() {
    const al = this.alive();
    const score = p => Math.max(0, ...al.filter(x => x !== p).map(x => this.progress(p, x)));
    const best = al.slice().sort((a, b) => score(b) - score(a) || this.S(b).hand.length - this.S(a).hand.length)[0];
    this.finish({ reason: 'time', winnerId: best });
  }
  finish(end) {
    clearTimeout(this.timer); this.timer = null;
    const g = this.g;
    g.end = end; g.pending = null; g.deadline = null; g.waitingOn = null;
    this.phase = 'ended';
    const w = end.winnerId;
    this.log('elim', v => end.reason === 'last'
      ? `${this.nm(w, v)} ${this.vb(w, v, 'are', 'is')} the last suspect still free. ${w === v ? 'You win.' : this.name(w) + ' wins.'}`
      : `Time’s up after ${LIMITS.MAX_ROUNDS} rounds. ${this.nm(w, v)} came closest to solving a crime and ${this.vb(w, v, 'win', 'wins')}.`);
  }

  /* ---------- clocks ---------- */
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    const g = this.g;
    if (this.phase !== 'playing' || !g) return;
    let who, ms, onTimeout, botAct;
    const pd = g.pending;
    if (pd && pd.type === 'respond') {
      who = pd.target; ms = LIMITS.RESPOND_MS;
      onTimeout = () => this.resolveRespond(false, true);
      botAct = () => this.resolveRespond(this.botRespond(pd.target, pd.actor, pd.clue), false);
    } else if (pd && pd.type === 'follow') {
      who = pd.actor; ms = LIMITS.FOLLOW_MS;
      onTimeout = () => this.resolveFollow(null, true);
      botAct = () => this.resolveFollow(Math.random() < 0.75 ? rnd(pd.options) : null, false);
    } else {
      who = this.current(); ms = LIMITS.TURN_MS;
      onTimeout = () => this.pass(who, true);
      botAct = () => this.botTurn(who);
    }
    const p = this.P(who);
    const isBot = !p || p.bot;
    const now = Date.now();
    if (isBot) ms = LIMITS.BOT_MS; else if (!p.conns) ms = LIMITS.AWAY_MS;
    let deadline = now + ms;
    // Same decision as before (e.g. a reconnect): never extend the clock.
    if (this.schedStep === this.step && g.deadline && g.waitingOn === who && !isBot) deadline = Math.min(g.deadline, deadline);
    this.schedStep = this.step;
    g.deadline = deadline; g.waitingOn = who;
    const step = this.step;
    this.timer = setTimeout(() => {
      if (this.step !== step || this.phase !== 'playing') return;
      try { (isBot ? botAct : onTimeout)(); } catch (e) { console.error('[game]', e); }
      this.changed();
    }, Math.max(0, deadline - now));
  }

  /* ---------- bots ---------- */
  botRespond(t, a, clue) {
    const c = this.K(clue), ownerAlive = this.S(c.owner).alive;
    let cost = ownerAlive ? 1.2 : 0.2;
    if (ownerAlive) {
      const after = this.S(c.owner).secrets.filter(x => x === clue || this.has(a, x)).length;
      if (after === 4) cost += 0.6;
    }
    const st = this.S(t), sa = this.S(a);
    const outThere = st.secrets.filter(x => !this.g.pub.has(x)).length;
    const othersCards = this.g.order.filter(p => p !== t).reduce((s, p) => s + this.S(p).hand.length, 0) || 1;
    let pHas = Math.min(1, outThere * sa.hand.length / othersCards);
    pHas *= 1 - 0.6 * (sa.backdowns / (sa.refusals + 1));
    const severity = 2 + st.secrets.filter(x => this.g.pub.has(x)).length;
    return pHas * severity + (Math.random() - 0.5) > cost;
  }
  botTurn(b) {
    const s = this.S(b);
    const others = this.alive().filter(p => p !== b);
    const locatedAt = c => { const k = s.know[c]; return k != null && k !== b && this.S(k).alive && !this.g.pub.has(c); };
    let best = null, bestN = 0;
    shuffle(others.slice()).forEach(x => { const n = this.progress(b, x); if (n > bestN) { bestN = n; best = x; } });
    if (best) {
      const missing = this.S(best).secrets.filter(c => !this.has(b, c));
      const located = missing.filter(locatedAt);
      if (located.length) { const c = rnd(located); return this.botDemandOrTake(b, s.know[c], c); }
      const holders = others.filter(p => p !== best);
      if (missing.length && holders.length && Math.random() < 0.3) return this.doDemand(b, rnd(holders), rnd(missing));
    }
    const withCards = others.filter(p => this.takeable(b, p).length);
    if (!withCards.length) return this.pass(b, false);
    this.doRandom(b, rnd(withCards.flatMap(p => Array(this.takeable(b, p).length).fill(p))));
  }
  botDemandOrTake(b, y, c) {
    const lev = this.leverage(b, y).length;
    if (lev || Math.random() < 0.45 || !this.takeable(b, y).length) return this.doDemand(b, y, c);
    return this.doRandom(b, y);
  }

  /* ---------- what one player is allowed to see ---------- */
  view(v) {
    const base = {
      code: this.code, phase: this.phase, you: v, hostId: this.hostId, serverNow: Date.now(),
      limits: { min: LIMITS.MIN_PLAYERS, max: LIMITS.MAX_PLAYERS, bigFrom: LIMITS.BIG_GAME_FROM, bigHand: LIMITS.BIG_HAND },
      players: this.players.map(p => ({ id: p.id, name: p.name, bot: p.bot, left: p.left, connected: p.bot || p.conns > 0 }))
    };
    const g = this.g;
    if (!g || !g.st[v]) return base;
    const me = this.S(v);
    const seen = c => { const k = me.know[c]; return k != null && k !== v ? k : null; };
    const pd = g.pending;
    const clueInfo = c => { const k = this.K(c); return { cid: c, owner: k.owner, trait: k.trait, value: k.value }; };
    // Your hand, grouped so two copies of one clue show once with a count.
    const counts = new Map();
    me.hand.forEach(cd => { const c = this.clueOf(cd); counts.set(c, (counts.get(c) || 0) + 1); });
    base.game = {
      round: g.round, maxRounds: LIMITS.MAX_ROUNDS, turn: this.current(), handSize: g.handSize,
      deadline: g.deadline, waitingOn: g.waitingOn,
      seats: g.order.map(pid => {
        const s = this.S(pid);
        return { id: pid, alive: s.alive, hand: s.hand.length, tag: s.tag, progress: pid === v ? null : this.progress(v, pid), takeable: pid === v ? null : this.takeable(v, pid).length > 0 };
      }),
      myCrime: me.secrets.map(c => { const k = this.K(c); return { cid: c, trait: k.trait, value: k.value, status: g.pub.has(c) ? 'public' : 'out', seenWith: seen(c) }; }),
      myHand: [...counts].map(([c, copies]) => ({ ...clueInfo(c), copies, ownerFree: this.S(this.K(c).owner).alive })),
      public: [...g.pub].map(clueInfo),
      cases: Object.fromEntries(g.order.filter(pid => pid !== v).map(pid => [pid, this.S(pid).secrets.map(c => {
        const k = this.K(c);
        const status = g.pub.has(c) ? 'public' : this.holds(v, c) ? 'mine' : 'hidden';
        return { cid: c, trait: k.trait, value: status === 'hidden' ? null : k.value, status, seenWith: status === 'hidden' ? seen(c) : null };
      })])),
      pending: pd ? {
        type: pd.type, actor: pd.actor, target: pd.target,
        clue: { cid: pd.clue, owner: this.K(pd.clue).owner, trait: this.K(pd.clue).trait },
        options: pd.type === 'follow' && pd.actor === v ? pd.options.map(clueInfo) : undefined,
        outThere: pd.type === 'respond' && pd.target === v ? me.secrets.filter(x => !g.pub.has(x)).length : undefined
      } : null,
      log: g.log.slice(-150).map(e => ({ kind: e.kind, text: e.fn(v) })).filter(e => e.text),
      end: g.end
    };
    return base;
  }
}

module.exports = { Room, LIMITS, TRAITS, cleanName, userError };
