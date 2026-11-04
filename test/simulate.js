// Plays many all-bot games and checks that clues are never lost or duplicated
// and that every game reaches an ending. Run with: npm test
const { Room, LIMITS } = require('../game');
LIMITS.BOT_MS = 0;
let arrests = 0;
const origSplit = Room.prototype.splitHand;
Room.prototype.splitHand = function (cards, p, x) {
  const out = origSplit.call(this, cards, p, x);
  const kept = (out.get(p) || []).length;
  const eligible = cards.filter(cd => this.ownerOfCard(cd) !== p).length;
  if (kept < Math.min(Math.ceil(cards.length / 2), eligible)) throw new Error('Arrester got the wrong share');
  for (const [pid, cds] of out) {
    if (cds.some(cd => this.ownerOfCard(cd) === pid)) throw new Error('A player was handed their own clue');
    if (!this.S(pid).alive) throw new Error('A clue went to someone in prison');
  }
  arrests++;
  return out;
};
function play(n) {
  return new Promise((resolve, reject) => {
    const room = new Room('TEST', r => {
      const g = r.g;
      if (g) {
        const held = g.order.flatMap(p => g.st[p].hand);
        if (new Set(held).size !== held.length) return reject(new Error('A card is in two hands'));
        if (held.length + g.pub.size !== g.cards.length) return reject(new Error('A card was lost'));
        for (const p of g.order) if (g.st[p].hand.some(cd => r.ownerOfCard(cd) === p)) return reject(new Error('A player holds a clue about their own crime'));
        g.order.forEach(p => JSON.stringify(r.view(p)));
      }
      if (r.phase === 'ended' && !r.done) { r.done = true; resolve(r); }
    });
    const host = room.join('Host');
    while (room.players.length < n) room.handle(host.id, { type: 'addBot' });
    room.handle(host.id, { type: 'start' });
    room.handle(host.id, { type: 'leave' }); // a bot takes the host's seat
    setTimeout(() => reject(new Error('Game never ended')), 30000);
  });
}
(async () => {
  for (const n of [4, 5, 6, 7, 8]) {
    const tally = { last: 0, time: 0 };
    for (let i = 0; i < 40; i++) { const r = await play(n); tally[r.g.end.reason]++; r.destroy(); }
    console.log(`${n} players: ${tally.last} ended with one suspect free, ${tally.time} hit the round limit`);
  }
  console.log(`All simulations passed (${arrests} arrests checked).`);
})().catch(e => { console.error(e); process.exit(1); });
