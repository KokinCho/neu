'use strict';
/**
 * Neu CPU strategy.
 * - 山札の構成と場に出たカード(捨て札)・自分の手札から「未知のカード」の分布を数え、
 *   次の人がバーストする確率を見積もる(カウンティング)。
 * - 自分の次の手番で安全に出せるカード(マイナス/特殊/余裕のある数字)が残るかを評価する。
 * - 合計が低いうちは「見送り用カード」(マイナス・特殊・101)を温存し、大きい数字から先に出す。
 */
const PARAMS = { ATT: 10, PEN: 8, LAMBDA: 1.2, RESW: 3, DUMP: 3, NOISE: 0.3 };

// 温存したい度合い(見送りに使える/攻撃にも使える貴重なカード)
const RES = { set101: 1.5, pass: 1.6, turn: 1.6, shot: 1.8, double: 1.4 };
const resValue = c => c.kind === 'num' ? (c.v === -10 ? 2.0 : c.v < 0 ? 1.0 : 0) : (RES[c.kind] || 0);

function unknownPool(r, p, defs) {
  const spec = r.settings.deck, cnt = {};
  for (const d of defs) cnt[d.key] = spec[d.key] || 0;
  const dec = c => { const d = defs.find(x => x.kind === c.kind && (c.kind !== 'num' || x.v === c.v)); if (d) cnt[d.key]--; };
  r.discard.forEach(dec); p.hand.forEach(dec);
  return defs.map(d => ({ d, n: Math.max(0, cnt[d.key]) })).filter(x => x.n > 0);
}
// 合計Aのとき、未知カード1枚が「安全に出せる」確率
function pSafe(pool, A, limit) {
  let tot = 0, safe = 0;
  for (const { d, n } of pool) { tot += n; if (d.kind !== 'num' || A + d.v <= limit) safe += n; }
  return tot ? safe / tot : 0.5;
}
// 手札3枚(未知)の次の人がバーストする確率。2枚出し(DOUBLE)なら安全札が2枚ほしい
function pBust(ps, plays) {
  const q = 1 - ps;
  if (plays <= 1) return q * q * q;
  const p0 = q ** 3, p1 = 3 * ps * q * q, p2 = 1 - p0 - p1;
  return 1 - (p2 + p1 * ps);
}

function chooseCardSmart(r, p, defs, params = PARAMS) {
  const { ATT, PEN, LAMBDA, RESW, DUMP, NOISE } = params;
  const limit = r.settings.bust101 ? 100 : 101;
  const T = r.total;
  const pool = unknownPool(r, p, defs);
  const opp = r.players.filter(q => q.alive && q !== p).length;
  const earliness = Math.max(0, (limit - T - 10) / limit); // 合計が低いほど1に近い
  const mustPlayAgain = r.plays > 1;                        // 自分がこの手番でもう1枚出す
  let best = null, bestScore = -Infinity;
  for (const c of p.hand) {
    let A = T;
    if (c.kind === 'num') A += c.v; else if (c.kind === 'set101') A = 101;
    let s;
    if (c.kind !== 'set101' && A > limit) {
      s = -1000 - A; // バースト(他に手がないときだけ選ばれる)
    } else {
      const rest = p.hand.filter(x => x !== c);
      // 攻撃: 次の人がバーストする確率(自分がもう1枚出すなら次の人はまだ決まらない)
      const att = mustPlayAgain ? 0 : ATT * pBust(pSafe(pool, A, limit), c.kind === 'double' ? 2 : 1);
      // 防御: 一周して自分の番が来たときに安全に出せるカードが残るか
      const drift = mustPlayAgain ? 0 : Math.min(4, Math.max(0, (limit - A) / (opp + 1))) * opp * (A < limit - 15 ? 1 : 0.4);
      const Af = A + drift;
      const known = rest.filter(x => x.kind !== 'num' || Af + x.v <= limit).length;
      const risk = PEN * Math.exp(-LAMBDA * (known + pSafe(pool, Af, limit)));
      // 温存: 序盤は見送り用カードを残し、大きい数字から先に出す
      let keep = -resValue(c) * earliness * RESW;
      if (c.kind === 'num' && c.v > 0) keep += DUMP * (c.v / 10) * earliness;
      s = att - risk + keep + Math.random() * NOISE;
    }
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

// SHOT: チップが少ない(脱落に近い)相手を指名する
function chooseShotTarget(r, p) {
  const others = r.players.filter(q => q.alive && q !== p);
  others.sort((a, b) => a.chips - b.chips || Math.random() - 0.5);
  return others[0].id;
}

module.exports = { chooseCardSmart, chooseShotTarget, PARAMS };
