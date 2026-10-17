// E2E smoke test: 1 human bot + 2 CPUs play a whole game. Run while server is up.
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:' + (process.env.PORT || 3000));
let started = false, plays = 0, rounds = 0, lastPhase = '';
const send = o => ws.send(JSON.stringify(o));
ws.on('open', () => send({ t: 'create', name: 'tester' }));
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.t === 'error') { console.log('ERR', m.msg); return; }
  if (m.t !== 'state') return;
  if (m.phase === 'lobby' && !started) { started = true; send({ t: 'addcpu' }); send({ t: 'addcpu' }); setTimeout(() => send({ t: 'settings', settings: { chips: 1 } }), 100); setTimeout(() => send({ t: 'start' }), 300); return; }
  if (m.phase !== lastPhase) { if (m.phase === 'roundEnd') rounds++; lastPhase = m.phase; console.log('phase', m.phase, m.bust ? m.bust.name + ' bust@' + m.bust.total : '', m.winner || ''); }
  if (m.phase === 'gameOver') { console.log('GAME OVER winner', m.winner, 'plays', plays, 'handsOK', m.reveal ? 'reveal' : 'noreveal'); process.exit(0); }
  if (m.phase === 'playing' && m.cur === m.you.id && m.hand.length) {
    const c = m.hand[Math.floor(Math.random() * m.hand.length)];
    if (m.hand.length !== 3) { console.log('HAND SIZE BUG', m.hand.length); }
    plays++;
    const others = m.players.filter(p => p.alive && p.id !== m.you.id);
    setTimeout(() => send({ t: 'play', cardId: c.id, target: c.kind === 'shot' ? others[0].id : undefined }), 50);
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
