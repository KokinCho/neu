'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { chooseCardSmart, chooseShotTarget } = require('./cpu');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server });

/* ---------------- Game logic ---------------- */
const rooms = new Map();
const MAX_PLAYERS = 7;
const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const CPU_NAMES = ['ロボ太', 'ノイ子', 'AIくん', 'コンピ', 'マシン', 'ボット', 'ハル'];

const DECK_DEFS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50].map(v => ({ key: 'n' + v, kind: 'num', v })),
  { key: 'nm1', kind: 'num', v: -1 }, { key: 'nm10', kind: 'num', v: -10 },
  { key: 'set101', kind: 'set101', v: 0 }, { key: 'pass', kind: 'pass', v: 0 }, { key: 'turn', kind: 'turn', v: 0 },
  { key: 'shot', kind: 'shot', v: 0 }, { key: 'double', kind: 'double', v: 0 },
];
const DECK_DEFAULT = { n1: 3, n2: 3, n3: 3, n4: 3, n5: 3, n6: 3, n7: 3, n8: 3, n9: 3, n10: 6, n50: 2, nm1: 2, nm10: 4, set101: 5, pass: 4, turn: 4, shot: 2, double: 2 };
const deckTotal = spec => DECK_DEFS.reduce((s, d) => s + (spec[d.key] || 0), 0);
function makeDeck(spec) {
  let id = 0; const d = [];
  for (const def of DECK_DEFS) for (let i = 0; i < (spec[def.key] || 0); i++) d.push({ id: id++, kind: def.kind, v: def.v });
  return shuffle(d);
}
const cardLabel = c => c.kind === 'num' ? (c.v > 0 ? '+' + c.v : '' + c.v) : c.kind === 'set101' ? '101' : c.kind.toUpperCase();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(c)) return c;
  }
}
const alivePlayers = r => r.players.filter(p => p.alive);
const idxOf = (r, id) => r.players.findIndex(p => p.id === id);
function nextAlive(r, idx, dir, steps) {
  const n = r.players.length;
  for (let s = 0; s < steps; s++) { do { idx = (idx + dir + n) % n; } while (!r.players[idx].alive); }
  return idx;
}
function pushLog(r, entry) { r.log.push(entry); if (r.log.length > 30) r.log.shift(); }

function view(r, p) {
  const ended = r.phase === 'roundEnd' || r.phase === 'gameOver';
  return {
    t: 'state', deckDefs: DECK_DEFS, deckDefault: DECK_DEFAULT, code: r.code, phase: r.phase, hostId: r.hostId, settings: r.settings,
    you: { id: p.id, token: p.token }, hand: p.hand,
    ready: r.ready ? [...r.ready] : [], readyNeed: r.phase === 'roundEnd' ? readyNeed(r) : [],
    players: r.players.map(q => ({ id: q.id, name: q.name, cpu: q.cpu, chips: q.chips, alive: q.alive, handCount: q.hand.length, connected: q.cpu || q.connected })),
    total: r.total, dir: r.dir, cur: r.players[r.cur] ? r.players[r.cur].id : null,
    nextCur: (r.phase === 'playing' && r.players[r.cur])
      ? (r.plays > 1 ? r.players[r.cur].id : r.players[r.shotTarget !== null ? r.shotTarget : nextAlive(r, r.cur, r.dir, r.skipNext ? 2 : 1)].id)
      : null,
    plays: r.plays,
    deckCount: r.deck.length, log: r.log.slice(-8), bust: r.bust, winner: r.winner,
    reveal: ended ? Object.fromEntries(r.players.map(q => [q.id, q.hand])) : null,
  };
}
function broadcast(r) {
  for (const p of r.players) if (!p.cpu && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(view(r, p)));
}
function sendErr(ws, msg, clear) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', msg, clear })); }

function draw(r) {
  if (!r.deck.length) { r.deck = shuffle(r.discard); r.discard = []; }
  return r.deck.pop() || null;
}

function startRound(r, starterIdx) {
  r.deck = makeDeck(r.settings.deck); r.discard = [];
  for (const p of r.players) { p.hand = []; }
  for (const p of alivePlayers(r)) for (let i = 0; i < 3; i++) p.hand.push(draw(r));
  r.total = 0; r.dir = 1; r.cur = starterIdx; r.plays = 1; r.nextPlays = 1; r.shotTarget = null; r.skipNext = false;
  r.bust = null; r.phase = 'playing'; r.seq++;
  pushLog(r, { sys: true, text: `ラウンド開始(${r.players[starterIdx].name}から)` });
  broadcast(r); scheduleCpu(r);
}

function startGame(r) {
  for (const p of r.players) { p.chips = r.settings.chips; p.alive = true; p.hand = []; }
  r.winner = null; r.log = [];
  startRound(r, Math.floor(Math.random() * r.players.length));
}

function play(r, p, cardId, targetId) {
  if (r.phase !== 'playing') return '今はカードを出せません';
  if (r.players[r.cur] !== p) return 'あなたの番ではありません';
  const ci = p.hand.findIndex(c => c && c.id === cardId);
  if (ci < 0) return 'そのカードは持っていません';
  const card = p.hand[ci];
  let target = -1;
  if (card.kind === 'shot') {
    target = idxOf(r, targetId);
    if (target < 0 || !r.players[target].alive || r.players[target] === p) return '指名する相手を選んでください';
  }
  p.hand.splice(ci, 1); r.discard.push(card);
  switch (card.kind) {
    case 'num': r.total += card.v; break;
    case 'set101': r.total = 101; break;
    case 'turn': r.dir = -r.dir; break;
    case 'shot': r.shotTarget = target; break;
    case 'double': r.nextPlays = 2; break;
    case 'pass': r.skipNext = r.settings.passSkip; break;
  }
  pushLog(r, { pid: p.id, name: p.name, label: cardLabel(card), kind: card.kind, total: r.total, target: card.kind === 'shot' ? r.players[target].name : null });
  r.seq++;
  const limit = r.settings.bust101 ? 100 : 101;
  if (card.kind !== 'set101' && r.total > limit) return bust(r, p);

  const nc = draw(r); if (nc) p.hand.push(nc);
  r.plays--;
  if (r.plays <= 0) {
    r.plays = r.nextPlays; r.nextPlays = 1;
    if (r.shotTarget !== null) { r.cur = r.shotTarget; r.shotTarget = null; r.skipNext = false; }
    else { r.cur = nextAlive(r, r.cur, r.dir, r.skipNext ? 2 : 1); r.skipNext = false; }
  }
  broadcast(r); scheduleCpu(r);
  return null;
}

function bust(r, p) {
  p.chips--; if (p.chips <= 0) p.alive = false;
  r.bust = { pid: p.id, name: p.name, total: r.total, eliminated: !p.alive };
  pushLog(r, { sys: true, text: `${p.name} がバースト!(${r.total})` });
  r.seq++;
  const alive = alivePlayers(r);
  if (alive.length <= 1) {
    r.phase = 'gameOver'; r.winner = alive[0] ? alive[0].name : p.name;
    broadcast(r); return null;
  }
  r.phase = 'roundEnd'; r.ready = new Set();
  const li = idxOf(r, p.id);
  r.nextStarter = p.alive ? li : nextAlive(r, li, 1, 1);
  clearTimeout(r.roundTimer);
  // 全員が「次へ」を押すを待つ(人間がいない/全員脱落なら短い待ち、それ以外は60秒で自動進行)
  r.roundTimer = r.manual ? null : setTimeout(() => { if (r.phase === 'roundEnd') startRound(r, r.nextStarter); }, readyNeed(r).length ? 60000 : 4000);
  broadcast(r);
  return null;
}
function readyNeed(r) { return r.players.filter(q => !q.cpu && q.alive && q.connected).map(q => q.id); }
function checkReady(r) {
  if (r.phase !== 'roundEnd') return;
  const need = readyNeed(r);
  if (need.length && need.every(id => r.ready.has(id))) { clearTimeout(r.roundTimer); startRound(r, r.nextStarter); }
}

/* ---- CPU ---- */
// 旧アルゴリズム(比較用に残す): 特殊カードを早めに使ってしまう
function chooseCardBasic(r, p) {
  const limit = r.settings.bust101 ? 100 : 101;
  let best = null, bestScore = -Infinity;
  for (const c of p.hand) {
    if (!c) continue;
    let after = r.total, s = 0;
    if (c.kind === 'num') after += c.v; else if (c.kind === 'set101') after = 101;
    if (c.kind !== 'set101' && after > limit) s = -1000 - after;
    else {
      const t = r.total;
      if (c.kind === 'num') s = c.v > 0 ? -after / 4 : (t >= 75 ? 30 + (-c.v) / 5 : -8);
      else if (c.kind === 'set101') s = t >= 55 ? 45 : -60;
      else if (c.kind === 'double') s = t >= 70 ? 35 : -5;
      else if (c.kind === 'shot') s = t >= 75 ? 28 : 0;
      else s = t >= 80 ? 25 : 2; // pass / turn
      if (c.kind === 'num' && c.v > 0 && t >= 90) s -= 20;
    }
    s += Math.random() * 3;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}
const DISCONNECT_GRACE = 30000; // 切断してからCPUが代打ちするまでの猛予(スマホの一時切断対策)
const CPU_DELAY = Number(process.env.NEU_CPU_DELAY) || 1300;
// CPU(と切断中プレイヤーの代打ち)が選ぶカードとSHOTの指名先
function cpuDecide(r, p) {
  const card = p.strategy === 'basic' ? chooseCardBasic(r, p) : chooseCardSmart(r, p, DECK_DEFS);
  if (!card) return null;
  let target = null;
  if (card.kind === 'shot') {
    if (p.strategy === 'basic') { const o = alivePlayers(r).filter(q => q !== p); target = o[Math.floor(Math.random() * o.length)].id; }
    else target = chooseShotTarget(r, p);
  }
  return { card, target };
}
function scheduleCpu(r) {
  clearTimeout(r.cpuTimer);
  if (r.manual || r.phase !== 'playing') return;
  const p = r.players[r.cur];
  if (!(p.cpu || !p.connected)) return;
  const seq = r.seq;
  const delay = p.cpu ? CPU_DELAY : Math.max(900, DISCONNECT_GRACE - (Date.now() - (p.dcAt || 0)));
  r.cpuTimer = setTimeout(() => {
    if (r.phase !== 'playing' || r.seq !== seq || r.players[r.cur] !== p) return;
    if (!p.cpu && p.connected) return;
    const d = cpuDecide(r, p);
    if (d) play(r, p, d.card.id, d.target);
  }, delay);
}

/* ---------------- Rooms / connections ---------------- */
function newPlayer(name, ws, cpu) {
  return { id: rid(), token: rid(), name: String(name || 'プレイヤー').slice(0, 10), cpu: !!cpu, ws: ws || null, connected: !cpu, chips: 3, alive: true, hand: [] };
}
function makeRoom(code, host) {
  return { code, players: [host], hostId: host.id, phase: 'lobby', settings: { passSkip: false, bust101: false, chips: 3, deck: { ...DECK_DEFAULT } },
    deck: [], discard: [], total: 0, dir: 1, cur: 0, plays: 1, nextPlays: 1, shotTarget: null, skipNext: false, log: [], bust: null, winner: null, seq: 0 };
}
function humans(r) { return r.players.filter(p => !p.cpu); }
function cleanupIfEmpty(r) {
  clearTimeout(r.deleteTimer);
  if (humans(r).some(p => p.connected)) return;
  r.deleteTimer = setTimeout(() => {
    clearTimeout(r.cpuTimer); clearTimeout(r.roundTimer); rooms.delete(r.code);
  }, 10 * 60 * 1000);
}
function removePlayer(r, p) {
  r.players = r.players.filter(q => q !== p);
  if (r.hostId === p.id) { const h = humans(r)[0]; r.hostId = h ? h.id : null; }
  if (!humans(r).length) { clearTimeout(r.cpuTimer); clearTimeout(r.roundTimer); rooms.delete(r.code); return; }
  broadcast(r);
}
function sanitizeSettings(s, base) {
  const o = { ...base };
  if (typeof s.passSkip === 'boolean') o.passSkip = s.passSkip;
  if (typeof s.bust101 === 'boolean') o.bust101 = s.bust101;
  if (Number.isInteger(s.chips) && s.chips >= 1 && s.chips <= 5) o.chips = s.chips;
  if (s.deck && typeof s.deck === 'object') {
    o.deck = { ...o.deck };
    for (const d of DECK_DEFS) if (Number.isInteger(s.deck[d.key]) && s.deck[d.key] >= 0 && s.deck[d.key] <= 12) o.deck[d.key] = s.deck[d.key];
  }
  return o;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') return;
    const r = ws.room, p = ws.player;
    try {
      switch (m.t) {
        case 'create': {
          const code = makeCode();
          const pl = newPlayer(m.name, ws);
          const room = makeRoom(code, pl);
          rooms.set(code, room); ws.room = room; ws.player = pl; broadcast(room); break;
        }
        case 'join': {
          const room = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!room) return sendErr(ws, 'ルームが見つかりません');
          if (room.phase !== 'lobby') return sendErr(ws, 'ゲーム進行中のため参加できません');
          if (room.players.length >= MAX_PLAYERS) return sendErr(ws, 'ルームが満員です');
          const pl = newPlayer(m.name, ws);
          room.players.push(pl); ws.room = room; ws.player = pl; cleanupIfEmpty(room); broadcast(room); break;
        }
        case 'rejoin': {
          const room = rooms.get(String(m.code || ''));
          const pl = room && room.players.find(q => q.token === m.token && !q.cpu);
          if (!pl) return sendErr(ws, '前回のルームには戻れませんでした', true);
          clearTimeout(pl.dcTimer); pl.ws = ws; pl.connected = true; ws.room = room; ws.player = pl;
          clearTimeout(room.deleteTimer); broadcast(room); scheduleCpu(room); break;
        }
        case 'leave': {
          if (!r) break;
          ws.room = null; ws.player = null;
          if (r.phase === 'lobby') removePlayer(r, p); else { p.connected = false; p.ws = null; p.dcAt = 0; cleanupIfEmpty(r); checkReady(r); broadcast(r); scheduleCpu(r); }
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'left' }));
          break;
        }
        case 'settings':
          if (!r || r.phase !== 'lobby' || r.hostId !== p.id) break;
          r.settings = sanitizeSettings(m.settings || {}, r.settings); broadcast(r); break;
        case 'addcpu': {
          if (!r || r.phase !== 'lobby' || r.hostId !== p.id) break;
          if (r.players.length >= MAX_PLAYERS) return sendErr(ws, '満員です');
          const used = new Set(r.players.map(q => q.name));
          const name = CPU_NAMES.find(n => !used.has(n)) || 'CPU' + r.players.length;
          r.players.push(newPlayer(name, null, true)); broadcast(r); break;
        }
        case 'removeplayer': {
          if (!r || r.phase !== 'lobby' || r.hostId !== p.id) break;
          const q = r.players.find(x => x.id === m.id);
          if (q && q !== p) {
            if (!q.cpu && q.ws) { q.ws.room = null; q.ws.player = null; q.ws.send(JSON.stringify({ t: 'left' })); }
            removePlayer(r, q);
          }
          break;
        }
        case 'start':
          if (!r || r.hostId !== p.id || (r.phase !== 'lobby')) break;
          if (r.players.length < 2) return sendErr(ws, '2人以上必要です(CPUを追加できます)');
          { const need = r.players.length * 3 + 5, have = deckTotal(r.settings.deck);
            if (have < need) return sendErr(ws, `カードが少なすぎます(${have}枚)。${need}枚以上にしてください`); }
          startGame(r); break;
        case 'play': {
          if (!r) break;
          const err = play(r, p, m.cardId, m.target);
          if (err) sendErr(ws, err);
          break;
        }
        case 'ready': {
          if (!r || r.phase !== 'roundEnd') break;
          if (m.force && r.hostId === p.id) {
            clearTimeout(r.roundTimer);
            startRound(r, r.nextStarter);
          } else {
            if (!r.ready) r.ready = new Set();
            r.ready.add(p.id);
            checkReady(r);
            broadcast(r);
          }
          break;
        }
        case 'again':
          if (!r || r.hostId !== p.id || r.phase !== 'gameOver') break;
          r.players = r.players.filter(q => q.cpu || q.connected);
          for (const q of r.players) { q.hand = []; q.alive = true; q.chips = r.settings.chips; }
          r.phase = 'lobby'; r.bust = null; r.winner = null; r.log = []; broadcast(r); break;
      }
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    const r = ws.room, p = ws.player;
    if (!r || !p) return;
    if (p.ws !== ws) return;
    p.connected = false; p.ws = null; p.dcAt = Date.now();
    if (r.phase === 'lobby') {
      // ロビーでも切断直後には消さず、猛予後に削除
      clearTimeout(p.dcTimer);
      p.dcTimer = setTimeout(() => { if (!p.connected && r.players.includes(p) && r.phase === 'lobby') removePlayer(r, p); }, DISCONNECT_GRACE);
      cleanupIfEmpty(r); broadcast(r);
    } else { cleanupIfEmpty(r); checkReady(r); broadcast(r); scheduleCpu(r); }
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`NEU server on http://localhost:${PORT}`));

// シミュレーション/テスト用
module.exports = { makeRoom, newPlayer, startGame, startRound, play, cpuDecide, chooseCardBasic, DECK_DEFS };
