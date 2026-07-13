// <달 아래 비밀 없는 정원> 베타플레이 서버
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const C = require('./content');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// ───────────────────────── 게임 상태 ─────────────────────────
const PRESETS = {
  standard: { label: '표준 (약 140분)', phase: [15, 20, 25, 20, 20], wrapup: 180, speech: 60 },
  short: { label: '베타 단축 (약 70분)', phase: [8, 10, 12, 10, 10], wrapup: 120, speech: 45 },
  test: { label: '기능 테스트 (초고속)', phase: [1, 1, 1, 1, 1], wrapup: 45, speech: 15 },
};

function freshGame() {
  return {
    stage: 'lobby',            // lobby → opening → phase → wrapup → npcFinal → recon → speeches → vote → ending
    preset: 'standard',
    players: {},               // token → {token, name, charId, connected}
    npcMode: false,            // 4인 플레이: 강지석 NPC
    phase: 0,                  // 1~5
    phaseEndsAt: null,
    cluesRevealed: 0,          // 현재 페이즈에서 공개된 단서 수
    clueLog: [],               // {phase, title, body}
    npcLog: [],                // 공개된 NPC 카드
    pondStood: [],             // charId[] (선 순서)
    pondOpen: false,
    revelationShown: false,
    wrapup: null,              // {answers: {charId: text}, revealed, endsAt}
    records: [],               // {phase, question, text}
    speechIdx: -1,
    speechEndsAt: null,
    votes: {},                 // voterCharId → targetCharId ('self' 처리 후 charId 저장)
    ending: null,              // {key, title, body}
    log: [],                   // 진행 로그 (호스트 화면)
  };
}
let G = freshGame();
let phaseTimer = null, wrapupTimer = null, speechTimer = null;

const activeChars = () => C.CHAR_ORDER.filter((c) => !(G.npcMode && c === 'jiseok'));
const playerByChar = (charId) => Object.values(G.players).find((p) => p.charId === charId);
const now = () => Date.now();

function log(msg) {
  G.log.push({ t: now(), msg });
  if (G.log.length > 200) G.log.shift();
}

// ───────────────────────── 브로드캐스트 ─────────────────────────
function publicState() {
  return {
    stage: G.stage, preset: G.preset, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.label])),
    npcMode: G.npcMode, phase: G.phase,
    phaseInfo: G.phase >= 1 ? C.PHASES[G.phase - 1] : null,
    phaseEndsAt: G.phaseEndsAt,
    serverNow: now(),
    players: Object.values(G.players).map((p) => ({ name: p.name, charId: p.charId, connected: p.connected })),
    charList: C.CHAR_ORDER.map((id) => ({ id, name: C.CHARACTERS[id].name, label: C.CHARACTERS[id].label, publicIntro: C.CHARACTERS[id].publicIntro, taken: !!playerByChar(id), npc: G.npcMode && id === 'jiseok' })),
    totalClues: G.phase >= 1 ? C.CLUES[G.phase].length : 0,
    cluesRevealed: G.cluesRevealed,
    clueLog: G.clueLog,
    npcLog: G.npcLog,
    pondStood: G.pondStood.map((c) => ({ charId: c, name: c === 'jiseok' && G.npcMode ? '강지석 (NPC)' : C.CHARACTERS[c].name })),
    pondOpen: G.pondOpen,
    moonTokens: G.pondStood.length,
    revelation: G.revelationShown ? C.REVELATION : null,
    wrapup: G.wrapup ? { revealed: G.wrapup.revealed, endsAt: G.wrapup.endsAt, submitted: Object.keys(G.wrapup.answers), answers: G.wrapup.revealed ? G.wrapup.answers : null, question: C.PHASES[G.phase - 1].question } : null,
    records: G.records,
    speech: G.stage === 'speeches' ? { order: speechOrder(), idx: G.speechIdx, endsAt: G.speechEndsAt } : null,
    votesIn: Object.keys(G.votes),
    votesRevealed: G.stage === 'ending',
    votes: G.stage === 'ending' ? G.votes : null,
    ending: G.ending,
    intro: C.INTRO,
    log: G.log.slice(-30),
  };
}
function pushState() { io.emit('state', publicState()); }

function privatePayload(p) {
  if (!p.charId) return null;
  const ch = C.CHARACTERS[p.charId];
  return {
    charId: p.charId,
    sheet: { label: ch.label, quote: ch.quote, appearance: ch.appearance, publicFace: ch.publicFace, lastMemory: ch.lastMemory, secrets: ch.secrets, tips: ch.tips, mission: ch.mission },
    missionSwitch: G.phase >= 4 ? C.MISSION_SWITCH[p.charId] : null,
    canStandPond: canStand(p.charId),
    hasStood: G.pondStood.includes(p.charId),
    isDetective: p.charId === 'detective',
  };
}
function pushPrivate() {
  for (const [sid, s] of io.of('/').sockets) {
    const p = s.data.token && G.players[s.data.token];
    if (p) s.emit('private', privatePayload(p));
  }
}
function sync() { pushState(); pushPrivate(); }

function canStand(charId) {
  if (!G.pondOpen || G.stage !== 'phase') return false;
  if (G.pondStood.includes(charId)) return false;
  if (charId === 'detective') return G.phase >= 5;
  return G.phase >= 4;
}

// ───────────────────────── 진행 로직 ─────────────────────────
function startPhase(n) {
  clearTimeout(phaseTimer);
  G.stage = 'phase';
  G.phase = n;
  G.cluesRevealed = 0;
  G.wrapup = null;
  G.pondOpen = n >= 4;
  const mins = PRESETS[G.preset].phase[n - 1];
  G.phaseEndsAt = now() + mins * 60 * 1000;
  phaseTimer = setTimeout(endPhase, mins * 60 * 1000);
  log(`${n}페이즈 시작 — "${C.PHASES[n - 1].question}" (${mins}분)`);
  if (G.npcMode) {
    const card = C.NPC_CARDS.find((c) => c.phase === n);
    if (card) { G.npcLog.push(card); io.emit('overlay', { kind: 'npc', title: card.title, body: card.body }); }
  }
  if (n === 4) io.emit('notice', '미션 전환 카드가 도착했습니다. 내 화면의 [미션] 탭을 확인하세요.');
  sync();
}

function endPhase() {
  if (G.stage !== 'phase') return;
  clearTimeout(phaseTimer);
  G.stage = 'wrapup';
  G.phaseEndsAt = null;
  const secs = PRESETS[G.preset].wrapup;
  G.wrapup = { answers: {}, revealed: false, endsAt: now() + secs * 1000 };
  wrapupTimer = setTimeout(revealWrapup, secs * 1000);
  io.emit('overlay', { kind: 'moon', title: '"달이 기울었습니다"', body: `이번 장의 질문에 대해, 각자 한 문장으로 답을 남기세요.\n"${C.PHASES[G.phase - 1].question}"` });
  log(`${G.phase}페이즈 종료 — 한 줄 문답 시작`);
  sync();
}

function revealWrapup() {
  if (!G.wrapup || G.wrapup.revealed) return;
  clearTimeout(wrapupTimer);
  // 미제출자는 침묵 처리
  for (const c of activeChars()) if (!(c in G.wrapup.answers)) G.wrapup.answers[c] = '(침묵)';
  G.wrapup.revealed = true;
  G.wrapup.endsAt = null;
  log('한 줄 문답 공개 — 형사의 기록 대기');
  sync();
}

function afterRecord() {
  if (G.phase < 5) { startPhase(G.phase + 1); return; }
  // 5페이즈 종료 후
  if (G.npcMode) {
    G.stage = 'npcFinal';
    const card = C.NPC_CARDS.find((c) => c.phase === 'final');
    G.npcLog.push(card);
    io.emit('overlay', { kind: 'npc', title: card.title, body: card.body });
    log('NPC 강지석 [카드 5] 공개');
  } else {
    G.stage = 'recon';
    log('형사의 재구성 시작');
  }
  sync();
}

function speechOrder() {
  return C.SPEECH_ORDER.filter((c) => !(G.npcMode && c === 'jiseok'));
}

function startSpeech(idx) {
  clearTimeout(speechTimer);
  const order = speechOrder();
  if (idx >= order.length) {
    G.stage = 'vote'; G.speechIdx = -1; G.speechEndsAt = null;
    log('투표 페이즈 — 셋을 센 뒤, 이 비극의 죄인이라 생각하는 이를 가리켜 주세요.');
    sync(); return;
  }
  G.stage = 'speeches';
  G.speechIdx = idx;
  const secs = PRESETS[G.preset].speech;
  G.speechEndsAt = now() + secs * 1000;
  speechTimer = setTimeout(() => startSpeech(idx + 1), secs * 1000);
  log(`최후의 발언 — ${C.CHARACTERS[order[idx]].name}`);
  sync();
}

function computeEnding() {
  const voters = activeChars();
  const allSelf = voters.every((c) => G.votes[c] === c);
  const noneSelf = voters.every((c) => G.votes[c] && G.votes[c] !== c);
  const tokens = G.pondStood.length;
  let key;
  if (allSelf && tokens === 5) key = 'hiddenGood';
  else if (allSelf) key = 'e2';
  else if (noneSelf && tokens === 0) key = 'hiddenBad';
  else key = 'e1';
  G.ending = { key, title: C.ENDINGS[key].title, body: C.ENDINGS[key].body, epilogue: C.EPILOGUE, timeline: C.TIMELINE };
  G.stage = 'ending';
  log(`엔딩 확정: ${C.ENDINGS[key].title}`);
  sync();
}

function standPond(charId, isNpc) {
  if (!isNpc && !canStand(charId)) return false;
  if (G.pondStood.includes(charId)) return false;
  G.pondStood.push(charId);
  const name = isNpc ? '강지석 (NPC)' : C.CHARACTERS[charId].name;
  io.emit('overlay', { kind: 'pond', title: `${name} — 연못 앞에 서다`, body: C.POND_TRUTHS[charId] });
  log(`연못의 진실 공개: ${name} (달조각 ${G.pondStood.length}개)`);
  // 4인: 두 번째 달조각 → NPC 지석도 연못 앞에 선다
  if (G.npcMode && !G.pondStood.includes('jiseok') && G.pondStood.length === 2) {
    setTimeout(() => { standPond('jiseok', true); sync(); }, 4000);
  }
  // 세 번째 달조각 → 연못의 계시
  if (G.pondStood.length === 3 && !G.revelationShown) {
    G.revelationShown = true;
    setTimeout(() => { io.emit('overlay', { kind: 'revelation', title: '[연못의 계시]', body: C.REVELATION }); sync(); }, 4500);
  }
  return true;
}

// ───────────────────────── 소켓 ─────────────────────────
io.on('connection', (socket) => {
  socket.emit('state', publicState());

  socket.on('register', ({ token, name }) => {
    if (!token) return;
    socket.data.token = token;
    if (!G.players[token]) {
      if (G.stage !== 'lobby') { socket.emit('errorMsg', '이미 게임이 시작되어 참가할 수 없습니다.'); return; }
      G.players[token] = { token, name: String(name || '플레이어').slice(0, 12), charId: null, connected: true };
      log(`${G.players[token].name} 입장`);
    } else {
      G.players[token].connected = true;
      if (name) G.players[token].name = String(name).slice(0, 12);
    }
    sync();
  });

  socket.on('pickChar', (charId) => {
    const p = socket.data.token && G.players[socket.data.token];
    if (!p || G.stage !== 'lobby') return;
    if (!C.CHAR_ORDER.includes(charId) || playerByChar(charId)) return;
    p.charId = charId;
    log(`${p.name} → ${C.CHARACTERS[charId].name} 선택`);
    sync();
  });
  socket.on('unpickChar', () => {
    const p = socket.data.token && G.players[socket.data.token];
    if (p && G.stage === 'lobby') { p.charId = null; sync(); }
  });

  // 호스트 제어
  socket.on('host:preset', (k) => { if (PRESETS[k] && G.stage === 'lobby') { G.preset = k; sync(); } });
  socket.on('host:start', () => {
    if (G.stage !== 'lobby') return;
    const seated = Object.values(G.players).filter((p) => p.charId);
    if (seated.length < 4) { socket.emit('errorMsg', '최소 4명이 인물을 선택해야 합니다.'); return; }
    G.npcMode = !playerByChar('jiseok');
    if (G.npcMode && seated.length !== 4) { socket.emit('errorMsg', '5인 플레이는 강지석까지 전원 선택해야 합니다.'); return; }
    const need = C.CHAR_ORDER.filter((c) => !(G.npcMode && c === 'jiseok'));
    if (!need.every((c) => playerByChar(c))) { socket.emit('errorMsg', '아직 선택되지 않은 인물이 있습니다.'); return; }
    G.stage = 'opening';
    log(`게임 시작 (${G.npcMode ? '4인 + NPC 강지석' : '5인'}) — 오프닝: 각자 설정서를 숙지하고 자기소개를 하세요.`);
    sync();
  });
  socket.on('host:beginPhase1', () => { if (G.stage === 'opening') startPhase(1); });
  socket.on('host:earlyEnd', () => { if (G.stage === 'phase') endPhase(); });
  socket.on('host:forceWrapReveal', () => { if (G.stage === 'wrapup') revealWrapup(); });
  socket.on('host:toRecon', () => { if (G.stage === 'npcFinal') { G.stage = 'recon'; log('형사의 재구성 시작'); sync(); } });
  socket.on('host:beginSpeeches', () => { if (G.stage === 'recon') startSpeech(0); });
  socket.on('host:nextSpeech', () => { if (G.stage === 'speeches') startSpeech(G.speechIdx + 1); });
  socket.on('host:newGame', () => {
    clearTimeout(phaseTimer); clearTimeout(wrapupTimer); clearTimeout(speechTimer);
    G = freshGame(); log('새 게임 준비');
    io.emit('reset'); sync();
  });

  // 단서 공개 (형사 또는 호스트)
  socket.on('clue:reveal', () => {
    if (G.stage !== 'phase') return;
    const p = socket.data.token && G.players[socket.data.token];
    const isDetective = p && p.charId === 'detective';
    const isHost = !p; // 플레이어 등록 없는 소켓(호스트 화면)
    if (!isDetective && !isHost) return;
    const list = C.CLUES[G.phase];
    if (G.cluesRevealed >= list.length) return;
    const clue = list[G.cluesRevealed];
    G.cluesRevealed += 1;
    G.clueLog.push({ phase: G.phase, title: clue.title, body: clue.body });
    io.emit('overlay', { kind: 'clue', title: `[단서 ${G.cluesRevealed}/${list.length}] ${clue.title}`, body: clue.body });
    log(`단서 공개: ${clue.title}`);
    sync();
  });

  // 연못 앞에 서기
  socket.on('pond:stand', () => {
    const p = socket.data.token && G.players[socket.data.token];
    if (!p || !p.charId) return;
    if (standPond(p.charId, false)) sync();
  });

  // 한 줄 문답
  socket.on('wrapup:answer', (text) => {
    const p = socket.data.token && G.players[socket.data.token];
    if (!p || !p.charId || G.stage !== 'wrapup' || !G.wrapup || G.wrapup.revealed) return;
    G.wrapup.answers[p.charId] = String(text || '').slice(0, 80) || '(침묵)';
    const done = activeChars().every((c) => c in G.wrapup.answers);
    if (done) revealWrapup(); else sync();
  });

  // 형사의 기록
  socket.on('record:submit', (text) => {
    const p = socket.data.token && G.players[socket.data.token];
    if (!p || p.charId !== 'detective' || G.stage !== 'wrapup' || !G.wrapup || !G.wrapup.revealed) return;
    G.records.push({ phase: G.phase, question: C.PHASES[G.phase - 1].question, text: String(text || '').slice(0, 120) });
    log(`형사의 기록 (${G.phase}페이즈): ${G.records[G.records.length - 1].text}`);
    afterRecord();
  });

  // 투표
  socket.on('vote:cast', (targetCharId) => {
    const p = socket.data.token && G.players[socket.data.token];
    if (!p || !p.charId || G.stage !== 'vote') return;
    const valid = C.CHAR_ORDER.includes(targetCharId);
    if (!valid) return;
    G.votes[p.charId] = targetCharId;
    log(`${C.CHARACTERS[p.charId].name} 투표 완료 (${Object.keys(G.votes).length}/${activeChars().length})`);
    if (activeChars().every((c) => c in G.votes)) computeEnding(); else sync();
  });

  socket.on('disconnect', () => {
    const p = socket.data.token && G.players[socket.data.token];
    if (p) { p.connected = false; pushState(); }
  });
});

// ───────────────────────── 기동 ─────────────────────────
function lanIps() {
  const out = [];
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

app.get('/api/joininfo', async (_, res) => {
  const ip = lanIps()[0] || 'localhost';
  const url = `http://${ip}:${PORT}/`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 360 });
  res.json({ url, qr });
});

server.listen(PORT, () => {
  const ip = lanIps()[0] || 'localhost';
  console.log('');
  console.log('  <달 아래 비밀 없는 정원> 베타플레이 서버 가동');
  console.log(`  호스트(진행) 화면:  http://localhost:${PORT}/host`);
  console.log(`  플레이어 접속(QR):  http://${ip}:${PORT}/`);
  console.log('  * 플레이어 기기는 이 PC와 같은 와이파이에 있어야 합니다.');
  console.log('');
});
