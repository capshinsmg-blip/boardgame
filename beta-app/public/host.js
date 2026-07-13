// 호스트(진행) 화면 — 플레이어로 등록하지 않는 관전/제어 소켓
const socket = io();
let S = null; let clockOffset = 0;
const $ = (id) => document.getElementById(id);
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

fetch('/api/joininfo').then((r) => r.json()).then((j) => {
  $('qrimg').src = j.qr;
  $('joinUrl').textContent = j.url;
});

socket.on('state', (s) => { clockOffset = s.serverNow - Date.now(); S = s; render(); });
socket.on('errorMsg', (m) => notice(m));
socket.on('reset', () => {});
socket.on('overlay', (o) => {
  const kindClass = { clue: '', npc: 'npc', pond: 'pond', revelation: 'revelation', moon: '' }[o.kind] || '';
  const node = el(`<div class="overlay ${kindClass}"><div class="inner"><h3>${esc(o.title)}</h3><p>${esc(o.body)}</p><button class="close primary">확인</button></div></div>`);
  node.querySelector('.close').onclick = () => node.remove();
  $('overlayRoot').appendChild(node);
});
function notice(msg) {
  const n = el(`<div class="notice">${esc(msg)}</div>`);
  $('noticeRoot').appendChild(n); setTimeout(() => n.remove(), 3500);
}

setInterval(() => {
  if (!S) return;
  let ends = null;
  if (S.stage === 'phase') ends = S.phaseEndsAt;
  else if (S.stage === 'wrapup' && S.wrapup && !S.wrapup.revealed) ends = S.wrapup.endsAt;
  else if (S.stage === 'speeches' && S.speech) ends = S.speech.endsAt;
  const t = $('timer');
  if (!ends) { t.textContent = ''; return; }
  const remain = Math.max(0, ends - (Date.now() + clockOffset));
  const m = Math.floor(remain / 60000), s = Math.floor((remain % 60000) / 1000);
  t.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  t.classList.toggle('warn', remain < 60000);
}, 250);

function render() {
  if (!S) return;
  const names = Object.fromEntries(S.charList.map((c) => [c.id, c.name]));
  // 플레이어 목록
  $('playerList').innerHTML = S.players.map((p) =>
    `<li>${esc(p.name)} ${p.charId ? '— <b>' + esc(names[p.charId]) + '</b>' : '<span class="dim">(선택 중)</span>'} ${p.connected ? '' : '<span class="off">● 연결 끊김</span>'}</li>`).join('') || '<li class="dim">아직 아무도 입장하지 않았습니다.</li>';

  // 상단 상태
  $('hPhaseMoon').textContent = S.phase >= 1 && S.phaseInfo ? `${S.phase}페이즈 · ${S.phaseInfo.moon}` : ({ lobby: '로비', opening: '오프닝' }[S.stage] || '');
  $('hQuestion').textContent = S.phase >= 1 && S.phaseInfo ? `"${S.phaseInfo.question}"` : '';
  const moons = $('moons'); moons.innerHTML = '';
  for (let i = 0; i < 5; i++) moons.appendChild(el(`<i class="${i < S.moonTokens ? 'on' : ''}"></i>`));
  $('hStatus').textContent = statusLine();

  // 제어
  const CB = $('controlBox'); CB.innerHTML = '<h3>진행 제어</h3>';
  const btn = (label, ev, cls = '') => { const b = el(`<button class="${cls}">${esc(label)}</button>`); b.onclick = () => socket.emit(ev); CB.appendChild(b); };
  if (S.stage === 'lobby') {
    const sel = el(`<div>${Object.entries(S.presets).map(([k, v]) =>
      `<button class="small ${S.preset === k ? 'primary' : ''}" data-k="${k}">${esc(v)}</button>`).join('')}</div>`);
    sel.querySelectorAll('button').forEach((b) => b.onclick = () => socket.emit('host:preset', b.dataset.k));
    CB.appendChild(el('<p class="dim">시간 모드</p>')); CB.appendChild(sel);
    btn('게임 시작 (전원 인물 선택 후)', 'host:start', 'primary');
  }
  if (S.stage === 'opening') btn('1페이즈 시작', 'host:beginPhase1', 'primary');
  if (S.stage === 'phase') {
    btn('다음 단서 공개 (형사 대행)', 'clue:reveal');
    btn('페이즈 조기 종료 — "달이 기울었습니다"', 'host:earlyEnd', 'primary');
  }
  if (S.stage === 'wrapup' && S.wrapup && !S.wrapup.revealed) btn('문답 강제 공개 (미제출자 침묵 처리)', 'host:forceWrapReveal');
  if (S.stage === 'wrapup' && S.wrapup && S.wrapup.revealed) CB.appendChild(el('<p class="dim">형사가 기록을 제출하면 자동으로 진행됩니다.</p>'));
  if (S.stage === 'npcFinal') btn('형사의 재구성으로', 'host:toRecon', 'primary');
  if (S.stage === 'recon') btn('최후의 발언 시작', 'host:beginSpeeches', 'primary');
  if (S.stage === 'speeches') btn('다음 발언자로', 'host:nextSpeech', 'primary');
  if (S.stage === 'vote') CB.appendChild(el(`<p class="dim">투표 진행 중… (${S.votesIn.length}명 완료)</p>`));
  if (S.stage === 'ending') CB.appendChild(el(`<p><b>${esc(S.ending.title)}</b></p>`));
  btn('⟲ 새 게임 (전체 초기화)', 'host:newGame');

  // 로그/단서/기록
  $('logList').innerHTML = S.log.slice().reverse().map((l) => `<div>${new Date(l.t).toLocaleTimeString('ko-KR')} — ${esc(l.msg)}</div>`).join('');
  $('hClues').innerHTML = S.clueLog.slice().reverse().map((c) => `<div><b>[${c.phase}P] ${esc(c.title)}</b></div>`).join('') || '<div class="dim">없음</div>';
  $('hRecords').innerHTML = S.records.map((r) => `<div class="answerline"><b>${r.phase}P</b><span>${esc(r.text)}</span></div>`).join('') || '<p class="dim">없음</p>';
}

function statusLine() {
  switch (S.stage) {
    case 'lobby': return '플레이어 입장 및 인물 선택 대기 중';
    case 'opening': return '오프닝 — 설정서 숙지 및 자기소개';
    case 'phase': return `단서 ${S.cluesRevealed}/${S.totalClues} 공개됨 · 달조각 ${S.moonTokens}개`;
    case 'wrapup': return S.wrapup.revealed ? '한 줄 문답 공개 — 형사의 기록 대기' : `한 줄 문답 작성 중 (${S.wrapup.submitted.length}명 제출)`;
    case 'npcFinal': return 'NPC 강지석의 마지막 말 공개됨';
    case 'recon': return '형사의 재구성 — 기록지 낭독';
    case 'speeches': return '최후의 발언 진행 중';
    case 'vote': return `투표 진행 중 (${S.votesIn.length}명 완료)`;
    case 'ending': return '엔딩 — ' + (S.ending ? S.ending.title : '');
    default: return '';
  }
}
