(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let ws, S = null, shotCard = null, lastTotal = null, toastT, countdownT, showDeck = false;

  $('#name').value = localStorage.getItem('neu-name') || '';
  const getName = () => { const n = $('#name').value.trim() || 'ゲスト'; localStorage.setItem('neu-name', n); return n; };
  const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => {
      const s = JSON.parse(localStorage.getItem('neu-session') || 'null');
      if (s) send({ t: 'rejoin', code: s.code, token: s.token });
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') {
        S = m; localStorage.setItem('neu-session', JSON.stringify({ code: m.code, token: m.you.token }));
        render();
      } else if (m.t === 'error') {
        toast(m.msg); if (m.clear) localStorage.removeItem('neu-session');
      } else if (m.t === 'left') {
        S = null; localStorage.removeItem('neu-session'); render();
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }
  connect();
  setInterval(() => send({ t: 'ping' }), 25000);

  $('#btn-create').onclick = () => send({ t: 'create', name: getName() });
  $('#btn-join').onclick = () => send({ t: 'join', code: $('#code').value, name: getName() });
  $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });

  const cardClass = c => c.kind === 'num' ? (c.v > 0 ? 'plus' : 'minus') : c.kind === 'set101' ? 'set101' : 'special';
  const cardText = c => c.kind === 'num' ? (c.v > 0 ? '+' + c.v : '' + c.v) : c.kind === 'set101' ? '101' : c.kind.toUpperCase();
  function cardDesc(c) {
    return { num: '', set101: '合計が101になる', pass: S.settings.passSkip ? '次の人を飛ばす' : '合計そのまま手番を渡す',
      turn: '回る向きが逆に', shot: '次に出す人を指名', double: '次の人は2枚出す' }[c.kind];
  }
  const isRisky = c => {
    if (c.kind === 'set101') return false;
    const after = S.total + (c.kind === 'num' ? c.v : 0);
    return after > (S.settings.bust101 ? 100 : 101);
  };

  function render() {
    const home = $('#home'), view = $('#view');
    clearInterval(countdownT);
    if (!S) { home.hidden = false; view.hidden = true; return; }
    home.hidden = true; view.hidden = false;
    view.innerHTML = S.phase === 'lobby' ? lobbyHTML() : tableHTML();
    bind();
  }

  function deckGrid(editable) {
    const spec = S.settings.deck;
    return `<div class="deckgrid">${S.deckDefs.map(d => `<div class="dk ${cardClass(d)}"><span class="dv">${cardText(d)}</span>
      ${editable ? `<button class="btn small" data-dk="${d.key}" data-d="-1">−</button><b>${spec[d.key]}</b><button class="btn small" data-dk="${d.key}" data-d="1">＋</button>` : `<b>×${spec[d.key]}</b>`}</div>`).join('')}</div>`;
  }
  const deckSum = () => S.deckDefs.reduce((s, d) => s + (S.settings.deck[d.key] || 0), 0);

  function lobbyHTML() {
    const host = S.hostId === S.you.id, st = S.settings;
    const dis = host ? '' : 'disabled';
    return `
      <h1 class="logo" style="font-size:2.6rem">NEU</h1>
      <div class="card center"><div class="small">ルームコード(友達に伝えよう)</div><p class="big-code">${esc(S.code)}</p></div>
      <div class="card"><h2>メンバー (${S.players.length}/7)</h2>
        <ul class="plist">${S.players.map(p => `<li><span class="nm">${esc(p.name)}${p.id === S.you.id ? '(あなた)' : ''}</span>
          ${p.id === S.hostId ? '<span class="tag host">ホスト</span>' : ''}${p.cpu ? '<span class="tag cpu">CPU</span>' : ''}
          ${host && p.id !== S.you.id ? `<button class="btn small" data-rm="${p.id}">削除</button>` : ''}</li>`).join('')}</ul>
        ${host ? '<button class="btn" id="add-cpu">＋ CPUを追加</button>' : ''}
      </div>
      <div class="card"><h2>ルール設定${host ? '' : '(ホストのみ変更可)'}</h2>
        <div class="setting"><div>PASSの効果<small>ON: 次の人を飛ばす / OFF: 合計そのまま手番を渡す</small></div><input type="checkbox" id="s-pass" ${st.passSkip ? 'checked' : ''} ${dis}></div>
        <div class="setting"><div>101ちょうどもバースト<small>ON: 101以上でバースト / OFF: 102以上</small></div><input type="checkbox" id="s-101" ${st.bust101 ? 'checked' : ''} ${dis}></div>
        <div class="setting"><div>チップ枚数</div><select id="s-chips" ${dis}>${[1, 2, 3, 4, 5].map(n => `<option ${n === st.chips ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div class="card"><h2>カード構成(合計 ${deckSum()}枚)${host ? '' : '(ホストのみ変更可)'}</h2>
        ${deckGrid(host)}
        ${host ? '<p class="center"><button class="btn small" id="deck-reset">公式の構成に戻す</button></p>' : ''}
      </div>
      ${host ? `<button class="btn primary" id="start">ゲーム開始</button>` : '<p class="center">ホストの開始を待っています…</p>'}
      <p class="center"><button class="btn small" id="leave">退出</button></p>`;
  }

  function tableHTML() {
    const me = S.players.find(p => p.id === S.you.id);
    const myTurn = S.phase === 'playing' && S.cur === S.you.id;
    const curP = S.players.find(p => p.id === S.cur);
    const nextP = S.players.find(p => p.id === S.nextCur);
    const limit = S.settings.bust101 ? 100 : 101;
    const t = S.total, cls = t > limit - 12 ? 'danger' : t > limit - 30 ? 'warn' : '';
    const pop = lastTotal !== null && lastTotal !== t ? 'pop' : ''; lastTotal = t;

    const seats = S.players.map(p => {
      const isCur = p.id === S.cur && S.phase === 'playing';
      const isNext = p.id === S.nextCur && S.phase === 'playing';
      return `<div class="seat ${isCur ? 'cur' : ''} ${isNext ? 'next' : ''} ${p.alive ? '' : 'dead'}">
        ${isCur ? '<div class="turn-badge cur">手番中</div>' : ''}
        ${isNext ? '<div class="turn-badge next">NEXT</div>' : ''}
        <div class="n">${esc(p.name)}${p.id === S.you.id ? '★' : ''}${p.connected ? '' : ' (切断)'}</div>
        <div class="chips">${Array.from({ length: S.settings.chips }, (_, i) => `<span class="chip ${i < p.chips ? '' : 'off'}"></span>`).join('')}</div>
        <div class="hc">${p.cpu ? 'CPU・' : ''}${p.alive ? '手札' + p.handCount : '脱落'}</div></div>`;
    }).join('');

    const log = S.log.slice().reverse().map(l => l.sys ? `<div>— ${esc(l.text)}</div>` :
      `<div>${esc(l.name)} <span class="c">${esc(l.label)}</span>${l.target ? '→' + esc(l.target) + 'を指名 ' : ''}合計 ${l.total}</div>`).join('');
    
    let status = '';
    if (S.phase === 'playing') status = myTurn ? `あなたの番です！${S.plays > 1 ? ` (あと${S.plays}枚出す)` : ''}` : `${esc(curP ? curP.name : '')} の番…${S.plays > 1 ? ` (${S.plays}枚出す)` : ''}`;
    const hand = me && me.alive ? S.hand.map(c => `<button class="pc ${cardClass(c)} ${myTurn && isRisky(c) ? 'risky' : ''}" data-card="${c.id}" ${myTurn && !isSubmitting ? '' : 'disabled'}>
      <span class="v">${cardText(c)}</span><span class="d">${cardDesc(c)}</span></button>`).join('') : '';
    return `
      <div class="seats">${seats}</div>
      <div class="felt">
        <div class="turn-indicator">
          <span class="dir-badge ${S.dir === 1 ? 'cw' : 'ccw'}">${S.dir === 1 ? '↻ 時計回り (順方向)' : '↺ 反時計回り (逆回転)'}</span>
          <div class="turn-flow-text">
            <span>手番: <b>${esc(curP ? curP.name : '-')}</b></span>
            <span class="flow-arrow">➔</span>
            <span>次は: <b>${esc(nextP ? nextP.name : '-')}</b></span>
          </div>
        </div>
        <div class="total-label">合計</div>
        <div class="total ${cls} ${pop}">${t}</div>
        <div class="gauge"><div style="width:${Math.max(0, Math.min(100, t / 101 * 100))}%"></div></div>
        <div class="gauge-lbl"><span>0</span><span>101</span></div>
        <div class="dir">山札残り: <b>${S.deckCount}</b>枚</div>
        <div class="log">${log}</div>
      </div>
      <div class="status ${myTurn ? 'me' : ''}">${status}</div>
      <div class="hand">${hand}</div>
      ${me && !me.alive ? '<p class="center">脱落しました。観戦中…</p>' : ''}
      <p class="center"><button class="btn small" id="show-deck">カード構成を見る</button> <button class="btn small" id="leave">退出</button></p>
      ${overlayHTML()}`;
  }

  function revealHTML() {
    return S.players.filter(p => p.alive || p.id === (S.bust && S.bust.pid)).map(p => `<div class="rv"><b>${esc(p.name)}</b><div class="reveal">${(S.reveal[p.id] || []).map(c => `<span class="c">${cardText(c)}</span>`).join('')}</div></div>`).join('');
  }
  function overlayHTML() {
    if (showDeck) {
      return `<div class="overlay"><div class="card modal"><h2>カード構成(合計 ${deckSum()}枚)</h2>${deckGrid(false)}
        <p class="center"><button class="btn" id="close-deck">閉じる</button></p></div></div>`;
    }
    if (shotCard !== null) {
      return `<div class="overlay"><div class="card modal"><h2>SHOT:次に出す人は?</h2><div class="targets">
        ${S.players.filter(p => p.alive && p.id !== S.you.id).map(p => `<button class="btn" data-target="${p.id}">${esc(p.name)}</button>`).join('')}
        <button class="btn small" id="cancel-shot">キャンセル</button></div></div></div>`;
    }
    if (S.phase === 'roundEnd') {
      const b = S.bust;
      const isReady = S.ready && S.ready.includes(S.you.id);
      const readyCount = S.ready ? S.ready.length : 0;
      const needCount = S.readyNeed ? S.readyNeed.length : 0;
      const isHost = S.hostId === S.you.id;

      return `<div class="overlay"><div class="card modal center"><h2 class="lose">💥 ${esc(b.name)} バースト!</h2>
        <p>合計 ${b.total}${b.eliminated ? ' ─ 脱落' : ' ─ チップ -1'}</p>${revealHTML()}
        <div class="ready-box" style="margin: 16px 0;">
          <p class="small">準備状況: <b>${readyCount} / ${needCount} 人</b> 完了</p>
          ${isReady 
            ? '<button class="btn ghost" disabled>✓ 準備完了 (他プレイヤー待機中)</button>' 
            : '<button class="btn primary" id="btn-ready">次のラウンドへ進む (準備OK)</button>'}
          ${isHost ? '<p style="margin-top:10px;"><button class="btn small" id="btn-force-start">⚡ 全員を待たずに開始 (ホスト)</button></p>' : ''}
        </div>
        <p class="small" style="opacity:0.6;">(放置時も一定時間で自動進行します)</p></div></div>`;
    }
    if (S.phase === 'gameOver') {
      const host = S.hostId === S.you.id;
      return `<div class="overlay"><div class="card modal center"><h2 class="win">🏆 ${esc(S.winner)} の勝利!</h2>
        ${S.bust ? `<p>${esc(S.bust.name)} が ${S.bust.total} でバースト</p>` : ''}
        ${host ? '<button class="btn primary" id="again">ロビーに戻る</button>' : '<p>ホストの操作を待っています…</p>'}
        <p><button class="btn small" id="leave">退出</button></p></div></div>`;
    }
    return '';
  }

  let isSubmitting = false;

  function bind() {
    isSubmitting = false;
    const q = s => document.querySelector(s);
    const on = (s, fn) => { const e = q(s); if (e) e.onclick = fn; };
    on('#leave', () => { if (confirm('退出しますか?')) send({ t: 'leave' }); });
    on('#start', () => send({ t: 'start' }));
    on('#show-deck', () => { showDeck = true; render(); });
    on('#close-deck', () => { showDeck = false; render(); });
    on('#deck-reset', () => send({ t: 'settings', settings: { deck: S.deckDefault } }));
    document.querySelectorAll('[data-dk]').forEach(b => b.onclick = () => {
      const k = b.dataset.dk, n = Math.max(0, Math.min(12, S.settings.deck[k] + +b.dataset.d));
      send({ t: 'settings', settings: { deck: { [k]: n } } });
    });
    on('#add-cpu', () => send({ t: 'addcpu' }));
    on('#again', () => send({ t: 'again' }));
    on('#btn-ready', () => send({ t: 'ready' }));
    on('#btn-force-start', () => send({ t: 'ready', force: true }));
    on('#cancel-shot', () => { shotCard = null; render(); });
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => send({ t: 'removeplayer', id: b.dataset.rm }));
    const pushSettings = () => send({ t: 'settings', settings: { passSkip: q('#s-pass').checked, bust101: q('#s-101').checked, chips: +q('#s-chips').value } });
    ['#s-pass', '#s-101', '#s-chips'].forEach(s => { const e = q(s); if (e) e.onchange = pushSettings; });
    document.querySelectorAll('[data-card]').forEach(b => b.onclick = () => {
      if (isSubmitting) return;
      const id = +b.dataset.card, c = S.hand.find(x => x.id === id);
      if (!c) return;
      if (isRisky(c) && !confirm('このカードを出すとバーストします。本当に出しますか?')) return;
      if (c.kind === 'shot') { 
        shotCard = id; render(); 
      } else { 
        isSubmitting = true;
        send({ t: 'play', cardId: id });
        b.disabled = true;
      }
    });
    document.querySelectorAll('[data-target]').forEach(b => b.onclick = () => {
      if (isSubmitting) return;
      isSubmitting = true;
      send({ t: 'play', cardId: shotCard, target: b.dataset.target }); 
      shotCard = null;
    });
  }
})();
