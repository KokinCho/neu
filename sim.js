// CPU strength simulation: runs full games through the real game logic (server.js) without sockets/timers.
//   node sim.js            -> new vs old comparisons
//   node sim.js tune       -> parameter sweep (new params vs default)
const { makeRoom, newPlayer, startGame, startRound, play, chooseCardBasic, DECK_DEFS } = require('./server');
const { chooseCardSmart, chooseShotTarget, PARAMS } = require('./cpu');

const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// specs: [{ name, strategy: 'basic' | 'smart', params? }]
function playGame(specs) {
  const players = shuffle(specs).map((s, i) => { const p = newPlayer(s.name, null, true); p.spec = s; return p; });
  const r = makeRoom('SIM', players[0]); r.players = players; r.manual = true;
  startGame(r);
  let guard = 0;
  while (r.phase !== 'gameOver' && guard++ < 20000) {
    if (r.phase === 'roundEnd') { startRound(r, r.nextStarter); continue; }
    const p = r.players[r.cur];
    let card, target = null;
    if (p.spec.strategy === 'basic') {
      card = chooseCardBasic(r, p);
      if (card.kind === 'shot') { const o = r.players.filter(q => q.alive && q !== p); target = o[Math.floor(Math.random() * o.length)].id; }
    } else {
      card = chooseCardSmart(r, p, DECK_DEFS, p.spec.params || PARAMS);
      if (card.kind === 'shot') target = chooseShotTarget(r, p);
    }
    const err = play(r, p, card.id, target);
    if (err) throw new Error('illegal move: ' + err);
  }
  if (r.phase !== 'gameOver') throw new Error('game did not finish');
  return r.winner;
}

function match(specs, n) {
  const wins = {}; specs.forEach(s => wins[s.name] = 0);
  for (let i = 0; i < n; i++) wins[playGame(specs)]++;
  return wins;
}
const pct = (w, n) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, (100 * v / n).toFixed(1) + '%']));

const N = Number(process.env.N) || 3000;
if (process.argv[2] === 'tune') {
  const grid = [
    ['DEFAULT', {}],
    ['ATT=6', { ATT: 6 }], ['ATT=16', { ATT: 16 }],
    ['PEN=5', { PEN: 5 }], ['PEN=12', { PEN: 12 }],
    ['RESW=1.5', { RESW: 1.5 }], ['RESW=5', { RESW: 5 }],
    ['DUMP=1', { DUMP: 1 }], ['DUMP=6', { DUMP: 6 }],
    ['LAMBDA=0.8', { LAMBDA: 0.8 }], ['LAMBDA=1.8', { LAMBDA: 1.8 }],
  ];
  for (const [label, delta] of grid) {
    const cand = { name: 'cand', strategy: 'smart', params: { ...PARAMS, ...delta } };
    const base = { name: 'base', strategy: 'smart', params: { ...PARAMS } };
    // 1 candidate vs 3 baseline copies (fair share = 25%)
    const w = match([cand, base, { ...base, name: 'b2' }, { ...base, name: 'b3' }], N);
    console.log(label.padEnd(12), 'cand win', (100 * w.cand / N).toFixed(1) + '%');
  }
} else {
  const smart = n => ({ name: n, strategy: 'smart' }), basic = n => ({ name: n, strategy: 'basic' });
  let w;
  w = match([smart('smart'), basic('old1'), basic('old2'), basic('old3')], N);
  console.log('1 new vs 3 old (fair = 25%):', pct(w, N));
  w = match([smart('new1'), smart('new2'), basic('old1'), basic('old2')], N);
  console.log('2 new vs 2 old (fair = 50% per side):', 'new', ((w.new1 + w.new2) / N * 100).toFixed(1) + '%', 'old', ((w.old1 + w.old2) / N * 100).toFixed(1) + '%');
  w = match([smart('new'), basic('old')], N);
  console.log('1v1 new vs old (fair = 50%):', pct(w, N));
}
