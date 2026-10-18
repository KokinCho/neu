// Feature test: disconnect grace (no auto-play) + roundEnd ready flow. Run while server is up.
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 3000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

function client(name) {
  const c = { name, state: null, ws: null, token: null, code: null };
  c.open = () => new Promise(res => {
    c.ws = new WebSocket(URL);
    c.ws.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'state') { c.state = m; c.token = m.you.token; c.code = m.code; } });
    c.ws.on('open', res);
  });
  c.send = o => c.ws.send(JSON.stringify(o));
  return c;
}

(async () => {
  const A = client('A'), B = client('B');
  await A.open(); A.send({ t: 'create', name: 'A' }); await sleep(200);
  await B.open(); B.send({ t: 'join', code: A.code, name: 'B' }); await sleep(200);
  A.send({ t: 'start' }); await sleep(300);
  check('game started', A.state.phase === 'playing');
  check('nextCur provided', !!A.state.nextCur && A.state.nextCur !== A.state.cur);

  // --- disconnect grace: the player whose turn it is disconnects ---
  const curId = A.state.cur;
  const cur = A.state.you.id === curId ? A : B, other = cur === A ? B : A;
  const before = other.state.log.length;
  cur.ws.close(); await sleep(4000);
  check('no auto-play within grace', other.state.cur === curId && other.state.log.length === before, `cur=${other.state.cur === curId}`);
  // rejoin
  const R = client('R'); await R.open(); R.send({ t: 'rejoin', code: A.code, token: cur.token }); await sleep(300);
  check('rejoin keeps full hand', R.state && R.state.hand.length === 3, `hand=${R.state && R.state.hand.length}`);
  check('still my turn after rejoin', R.state.cur === R.state.you.id);

  // --- play until roundEnd, then verify ready flow ---
  const P = { [A.state.you.id === curId ? 'x' : 'y']: 0 };
  const players = [R, other];
  const byId = id => players.find(p => p.state.you.id === id);
  let guard = 0;
  while (players[0].state.phase === 'playing' && guard++ < 200) {
    const turn = byId(players[0].state.cur);
    // play the biggest positive card to bust quickly; fall back to first card
    const hand = turn.state.hand;
    const card = hand.slice().sort((a, b) => (b.kind === 'num' ? b.v : 0) - (a.kind === 'num' ? a.v : 0))[0];
    const tgt = card.kind === 'shot' ? turn.state.players.find(p => p.id !== turn.state.you.id).id : undefined;
    turn.send({ t: 'play', cardId: card.id, target: tgt });
    await sleep(120);
  }
  const s = players[0].state;
  check('reached roundEnd', s.phase === 'roundEnd', s.phase);
  check('readyNeed has both humans', s.readyNeed.length === 2, JSON.stringify(s.readyNeed.length));
  players[0].send({ t: 'ready' }); await sleep(300);
  check('waits for the other player', players[0].state.phase === 'roundEnd' && players[0].state.ready.length === 1);
  players[1].send({ t: 'ready' }); await sleep(400);
  check('starts next round when all ready', players[0].state.phase === 'playing' && players[0].state.total === 0, players[0].state.phase);
  check('hands are 3 cards again', players[0].state.hand.length === 3 && players[1].state.hand.length === 3);

  const fails = results.filter(x => !x).length;
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
