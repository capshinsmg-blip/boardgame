// 플레이어 클라이언트
const socket = io();
let S = null;          // 서버 공개 상태
let P = null;          // 내 비공개 데이터
let clockOffset = 0;   // serverNow - Date.now()
let overlayQueue = []; let overlayShowing = false;
let wrapupSubmitted = false; let voteSubmitted = false; let lastStageKey = '';

const token = localStorage.getItem('garden_token') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
localStorage.setItem('garden_token', token);

const $ = (id) => document.getElementById(id);
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 접속/등록 ──
const savedName = localStorage.getItem('garden_name');
if (savedName) $('nameInput').value = savedName;
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return alert('이름을 입력하세요.');
  localStorage.setItem('garden_name', name);
  socket.emit('register', { token, name });
  joined = true;
};
let joined = !!savedName;
socket.on('connect', () => { if (joined) socket.emit('register', { token, name: localStorage.getItem('garden_name') }); });

socket.on('errorMsg', (m) => notice(m));
socket.on('notice', (m) => notice(m));
socket.on('reset', () => { wrapupSubmitted = false; voteSubmitted = false; overlayQueue = []; });
socket.on('private', (p) => { P = p; render(); });
socket.on('state', (s) => {
  clockOffset = s.serverNow - Date.now();
  const stageKey = s.stage + ':' + s.phase + ':' + (s.wrapup ? (s.wrapup.revealed ? 'r' : 'w') : '');
  if (stageKey !== lastStageKey) { wrapupSubmitted = false; if (s.stage !== 'vote') voteSubmitted = false; lastStageKey = stageKey; }
  S = s; render();
});
socket.on('overlay', (o) => { overlayQueue.push(o); pumpOverlay(); });

// ── 오버레이(전체화면 연출) ──
function pumpOverlay() {
  if (overlayShowing || !overlayQueue.length) return;
  const o = overlayQueue.shift();
  overlayShowing = true;
  const kindClass = { clue: '', npc: 'npc', pond: 'pond', revelation: 'revelation', moon: '' }[o.kind] || '';
  const node = el(`<div class="overlay ${kindClass}"><div class="inner">
    <h3>${esc(o.title)}</h3><p>${esc(o.body)}</p>
    <button class="close primary">확인</button></div></div>`);
  node.querySelector('.close').onclick = () => { node.remove(); overlayShowing = false; pumpOverlay(); };
  $('overlayRoot').appendChild(node);
  if (navigator.vibrate) navigator.vibrate(120);
}
function notice(msg) {
  const n = el(`<div class="notice">${esc(msg)}</div>`);
  $('noticeRoot').appendChild(n);
  setTimeout(() => n.remove(), 3500);
}

// ── 타이머 ──
setInterval(() => {
  if (!S) return;
  const t = $('timer'); if (!t) return;
  let ends = null;
  if (S.stage === 'phase') ends = S.phaseEndsAt;
  else if (S.stage === 'wrapup' && S.wrapup && !S.wrapup.revealed) ends = S.wrapup.endsAt;
  else if (S.stage === 'speeches' && S.speech) ends = S.speech.endsAt;
  if (!ends) { t.textContent = ''; return; }
  const remain = Math.max(0, ends - (Date.now() + clockOffset));
  const m = Math.floor(remain / 60000), s = Math.floor((remain % 60000) / 1000);
  t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  t.classList.toggle('warn', remain < 60000);
}, 250);

// ── 탭 ──
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    ['main', 'sheet', 'clues', 'record'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  };
});

// ── 렌더 ──
function render() {
  if (!S) return;
  const me = S.players.find((p) => p.charId && P && p.charId === P.charId);
  const inLobby = S.stage === 'lobby';
  const registered = S.players.some((p) => p.name === localStorage.getItem('garden_name')) || !!P;
  $('s-join').classList.toggle('hidden', registered);
  $('s-lobby').classList.toggle('hidden', !(registered && inLobby));
  $('s-game').classList.toggle('hidden', !registered || inLobby);
  if (inLobby) return renderLobby();
  renderHead(); renderMain(); renderSheet(); renderClues(); renderRecord();
}

function renderLobby() {
  $('charButtons').innerHTML = '';
  S.charList.forEach((c) => {
    const mine = P && P.charId === c.id;
    const b = el(`<button class="charbtn ${c.taken && !mine ? 'taken' : ''} ${mine ? 'primary' : ''}">
      <span>${esc(c.name)}<br><small>${esc(c.publicIntro)}</small></span>
      <span>${mine ? '✓ 선택됨' : c.taken ? '선택 완료' : '선택'}</span></button>`);
    b.onclick = () => { if (mine) socket.emit('unpickChar'); else if (!c.taken) socket.emit('pickChar', c.id); };
    $('charButtons').appendChild(b);
  });
  $('lobbyPlayers').innerHTML = S.players.map((p) =>
    `<li>${esc(p.name)} ${p.charId ? '— <b>' + esc(S.charList.find(c => c.id === p.charId).name) + '</b>' : '<span class="dim">(선택 중)</span>'} ${p.connected ? '' : '<span class="off">(연결 끊김)</span>'}</li>`).join('');
}

function renderHead() {
  const h = $('phaseHead');
  if (S.stage === 'opening') { h.innerHTML = `<div class="phaseq">오프닝 — 설정서를 숙지하고 자기소개를 나누세요</div>`; return; }
  if (S.phase >= 1 && S.phaseInfo) {
    h.innerHTML = `<div class="phasemoon">${S.phase}페이즈 · ${esc(S.phaseInfo.moon)}</div>
      <div class="phaseq">"${esc(S.phaseInfo.question)}"</div>`;
  } else h.innerHTML = '';
  const moons = $('moons');
  moons.innerHTML = '';
  for (let i = 0; i < 5; i++) moons.appendChild(el(`<i class="${i < S.moonTokens ? 'on' : ''}"></i>`));
}

function renderMain() {
  const A = $('mainArea'); A.innerHTML = '';
  const add = (n) => A.appendChild(n);

  if (S.stage === 'opening') {
    add(el(`<div class="card"><h3>이야기의 시작</h3><p>${S.intro.map(esc).join('\n')}</p></div>`));
    add(el(`<div class="card"><p class="dim">[내 설정서] 탭에서 자신의 비밀을 숙지하세요. 진행자가 1페이즈를 시작합니다.</p></div>`));
    return;
  }

  if (S.stage === 'phase') {
    // 단서 진행 상황
    add(el(`<div class="card"><h3>단서 ${S.cluesRevealed} / ${S.totalClues}</h3>
      <p class="dim">형사가 단서를 한 장씩 소리 내어 공개합니다.</p></div>`));
    if (P && P.isDetective && S.cluesRevealed < S.totalClues) {
      const b = el(`<button class="primary">다음 단서 공개 (${S.cluesRevealed + 1}/${S.totalClues})</button>`);
      b.onclick = () => socket.emit('clue:reveal');
      add(b);
    }
    // 연못
    if (S.pondOpen) {
      const stood = P && P.hasStood;
      const can = P && P.canStandPond;
      const b = el(`<button class="moonbtn" ${can ? '' : 'disabled'}>${stood ? '이미 연못 앞에 섰습니다' : '연못 앞에 서겠다'}</button>`);
      if (can) b.onclick = () => {
        if (confirm('연못은 당신이 가장 감추고 싶은 진실을 모두에게 비춥니다.\n정말 연못 앞에 서겠습니까?')) socket.emit('pond:stand');
      };
      add(b);
      if (P && P.charId === 'detective' && S.phase < 5 && !stood) add(el(`<p class="dim center">형사는 5페이즈부터 연못 앞에 설 수 있습니다.</p>`));
    }
    return;
  }

  if (S.stage === 'wrapup') {
    const W = S.wrapup;
    if (!W.revealed) {
      add(el(`<div class="card"><h3>"달이 기울었습니다"</h3>
        <p>이번 장의 질문에 한 문장으로 답하세요. 거짓을 말해도 좋습니다.\n단, 한 번 입 밖에 낸 말은 주워 담을 수 없습니다.</p></div>`));
      if (P && !wrapupSubmitted && !W.submitted.includes(P.charId)) {
        const box = el(`<div class="card"><input type="text" id="ansInput" maxlength="80" placeholder="한 문장으로 답하세요">
          <button class="primary" id="ansBtn">답변 제출</button></div>`);
        add(box);
        box.querySelector('#ansBtn').onclick = () => {
          socket.emit('wrapup:answer', box.querySelector('#ansInput').value.trim());
          wrapupSubmitted = true; render();
        };
      } else {
        add(el(`<div class="card"><p class="dim">제출 완료. 다른 플레이어를 기다리는 중… (${W.submitted.length}명 제출)</p></div>`));
      }
    } else {
      const names = Object.fromEntries(S.charList.map((c) => [c.id, c.name]));
      add(el(`<div class="card"><h3>한 줄 문답 — 전원 공개</h3>${Object.entries(W.answers).map(([c, a]) =>
        `<div class="answerline"><b>${esc(names[c])}</b><span>${esc(a)}</span></div>`).join('')}</div>`));
      if (P && P.isDetective) {
        const box = el(`<div class="card"><h3>형사의 기록</h3><p class="dim">테이블의 잠정 결론을 한 문장으로 기록하세요. 기록은 형사의 직권입니다.</p>
          <input type="text" id="recInput" maxlength="120" placeholder="기록할 한 문장">
          <button class="primary" id="recBtn">기록하고 다음 장으로</button></div>`);
        add(box);
        box.querySelector('#recBtn').onclick = () => {
          const v = box.querySelector('#recInput').value.trim();
          if (!v) return alert('기록을 입력하세요.');
          socket.emit('record:submit', v);
        };
      } else {
        add(el(`<p class="dim center">형사가 추리 기록지에 결론을 적고 있습니다…</p>`));
      }
    }
    return;
  }

  if (S.stage === 'npcFinal') {
    add(el(`<div class="card"><h3>강지석의 마지막 말</h3><p class="dim">진행자가 다음 단계로 넘어갑니다.</p></div>`));
    return;
  }

  if (S.stage === 'recon') {
    add(el(`<div class="card"><h3>형사의 재구성</h3><p class="dim">형사가 추리 기록지의 다섯 줄을 낭독하며 사건의 전말을 재구성합니다. [기록] 탭에서 함께 볼 수 있습니다.</p></div>`));
    if (P && P.isDetective) add(el(`<div class="card"><p>기록지를 낭독하고, 당신이 추리한 그날 밤의 진실을 모두에게 들려주세요.</p></div>`));
    return;
  }

  if (S.stage === 'speeches') {
    const cur = S.speech.order[S.speech.idx];
    const names = Object.fromEntries(S.charList.map((c) => [c.id, c.name]));
    add(el(`<div class="card center"><h3>최후의 발언</h3>
      <p class="big">${S.speech.order.map((c, i) => i === S.speech.idx ? `<b>▶ ${esc(names[c])}</b>` : esc(names[c])).join(' → ')}</p>
      ${P && P.charId === cur ? '<p style="margin-top:10px">당신의 차례입니다. 마음을 이야기하세요.</p>' : ''}</div>`));
    return;
  }

  if (S.stage === 'vote') {
    add(el(`<div class="card center"><h3>투표 페이즈</h3>
      <p>모든 이야기가 끝났습니다.\n이 비극의 죄인이라 생각하는 이를 가리켜 주세요.\n다른 사람을 가리켜도, 자기 자신을 가리켜도 좋습니다.\n오직 당신의 마음이 시키는 대로.</p></div>`));
    if (P && !voteSubmitted && !S.votesIn.includes(P.charId)) {
      S.charList.forEach((c) => {
        if (S.npcMode === false || true) {
          const label = c.id === P.charId ? `${c.name} (나 자신)` : c.name + (c.npc ? ' (NPC)' : '');
          const b = el(`<button>${esc(label)}</button>`);
          b.onclick = () => { if (confirm(`${c.name}을(를) 지목합니까? 되돌릴 수 없습니다.`)) { socket.emit('vote:cast', c.id); voteSubmitted = true; render(); } };
          $('mainArea').appendChild(b);
        }
      });
    } else {
      add(el(`<p class="dim center">투표 완료. 전원의 손끝을 기다립니다… (${S.votesIn.length}명 완료)</p>`));
    }
    return;
  }

  if (S.stage === 'ending' && S.ending) {
    const names = Object.fromEntries(S.charList.map((c) => [c.id, c.name]));
    add(el(`<div class="card"><h3>투표 결과</h3>${Object.entries(S.votes).map(([v, t]) =>
      `<div class="answerline"><b>${esc(names[v])}</b><span>→ ${v === t ? '자기 자신' : esc(names[t])}</span></div>`).join('')}</div>`));
    add(el(`<div class="card"><h3>${esc(S.ending.title)}</h3><p>${S.ending.body.map(esc).join('\n\n')}</p></div>`));
    add(el(`<div class="card"><h3>지금까지의 이야기</h3><p class="dim">${S.ending.epilogue.map(esc).join('\n\n')}</p></div>`));
    add(el(`<div class="card"><h3>실제 타임라인</h3><p class="dim">${S.ending.timeline.map(esc).join('\n')}</p></div>`));
    add(el(`<div class="card"><p>엔딩을 확인한 뒤, 각자 자신의 인물과 미션을 공개하고 소감을 나눠 보세요. 미션의 성패는 승부가 아니라, 각 인물의 이야기를 완성하기 위한 나침반입니다.</p></div>`));
    return;
  }
}

function renderSheet() {
  const T = $('tab-sheet');
  if (!P || !P.sheet) { T.innerHTML = '<p class="dim">인물을 선택하면 설정서가 표시됩니다.</p>'; return; }
  const s = P.sheet;
  T.innerHTML = `
    <h1>${esc(s.label)}</h1><p class="sub">${esc(s.quote)}</p>
    ${P.missionSwitch ? `<div class="card" style="border-color:var(--blood)"><h3 style="color:var(--blood)">✦ 미션 전환 카드 (4페이즈 개봉)</h3><p>${esc(P.missionSwitch)}</p></div>` : ''}
    <div class="card"><h3>외양 및 성격</h3><p>${esc(s.appearance)}</p></div>
    <div class="card"><h3>공개된 모습</h3><p>${esc(s.publicFace)}</p></div>
    <div class="card"><h3>마지막 기억</h3><p>${esc(s.lastMemory)}</p></div>
    <h2>✦ 당신의 비밀 (본인만 보세요)</h2>
    ${s.secrets.map((x) => `<div class="card"><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p></div>`).join('')}
    <h2>✦ 연기 팁</h2>
    <div class="card"><p>${s.tips.map(esc).join('\n')}</p></div>
    <h2>✦ 미션</h2>
    <div class="card"><p>${esc(s.mission)}</p></div>`;
}

function renderClues() {
  const T = $('tab-clues');
  if (!S.clueLog.length && !S.npcLog.length) { T.innerHTML = '<p class="dim">아직 공개된 단서가 없습니다.</p>'; return; }
  let html = '<h1>공개된 단서</h1><p class="sub">모든 단서는 공개 정보입니다.</p>';
  for (let ph = 1; ph <= 5; ph++) {
    const clues = S.clueLog.filter((c) => c.phase === ph);
    if (!clues.length) continue;
    html += `<h2>${ph}페이즈</h2>` + clues.map((c) =>
      `<div class="clueitem ${c.title.includes('기억 조각') ? 'mem' : ''}"><b>${esc(c.title)}</b><p>${esc(c.body)}</p></div>`).join('');
  }
  if (S.npcLog.length) html += '<h2>NPC 강지석의 진술</h2>' + S.npcLog.map((c) => `<div class="clueitem"><b>${esc(c.title)}</b><p>${esc(c.body)}</p></div>`).join('');
  if (S.revelation) html += `<h2>연못의 계시</h2><div class="clueitem" style="border-color:var(--dawn)"><p>${esc(S.revelation)}</p></div>`;
  const stoodTruths = S.pondStood.map((x) => x.name).join(', ');
  if (stoodTruths) html += `<p class="dim">연못 앞에 선 사람: ${esc(stoodTruths)}</p>`;
  T.innerHTML = html;
}

function renderRecord() {
  const T = $('tab-record');
  if (!S.records.length) { T.innerHTML = '<p class="dim">아직 기록이 없습니다. 매 페이즈가 끝나면 형사가 잠정 결론을 기록합니다.</p>'; return; }
  T.innerHTML = '<h1>추리 기록지</h1><p class="sub">형사가 페이즈마다 남긴 잠정 결론</p>' +
    S.records.map((r) => `<div class="card"><h3>${r.phase}페이즈 — "${esc(r.question)}"</h3><p>${esc(r.text)}</p></div>`).join('');
}
