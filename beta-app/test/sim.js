// E2E 시뮬레이션: 4인 + NPC 강지석, 전체 플로우 → 히든 굿엔딩 검증
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastState = null;
const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'OK   ' : 'FAIL ') + name);
}

function mkSocket(tag) {
  const s = io(URL, { transports: ['websocket'] });
  s.on('state', (st) => { lastState = st; });
  s.on('errorMsg', (m) => console.log(`  [${tag}] error: ${m}`));
  return s;
}

async function waitFor(desc, fn, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (lastState && fn(lastState)) return true;
    await sleep(150);
  }
  console.log('TIMEOUT waiting: ' + desc);
  return false;
}

(async () => {
  const host = mkSocket('host');
  const players = {
    haewol: { sock: mkSocket('haewol'), token: 'tok-haewol', name: '테스터A' },
    detective: { sock: mkSocket('det'), token: 'tok-det', name: '테스터B' },
    seorin: { sock: mkSocket('seorin'), token: 'tok-seorin', name: '테스터C' },
    songi: { sock: mkSocket('songi'), token: 'tok-songi', name: '테스터D' },
  };
  await sleep(400);

  host.emit('host:newGame');
  await sleep(300);

  // 입장 + 인물 선택
  for (const [charId, p] of Object.entries(players)) {
    p.sock.emit('register', { token: p.token, name: p.name });
    await sleep(120);
    p.sock.emit('pickChar', charId);
    await sleep(120);
  }
  check('4인 입장/선택', await waitFor('4 picked', (s) => s.charList.filter((c) => c.taken).length === 4));

  host.emit('host:preset', 'test');
  await sleep(150);
  host.emit('host:start');
  check('오프닝 진입 + NPC 모드', await waitFor('opening', (s) => s.stage === 'opening' && s.npcMode === true));
  host.emit('host:beginPhase1');
  check('1페이즈 시작', await waitFor('phase1', (s) => s.stage === 'phase' && s.phase === 1));

  // 페이즈 공통 루틴
  async function runPhase(n, { stands = [] } = {}) {
    // 단서 전부 공개 (형사)
    const total = lastState.totalClues;
    for (let i = 0; i < total; i++) { players.detective.sock.emit('clue:reveal'); await sleep(100); }
    check(`${n}P 단서 ${total}장 공개`, await waitFor('clues', (s) => s.cluesRevealed === total));
    // 연못 서기
    for (const c of stands) {
      players[c].sock.emit('pond:stand');
      await sleep(200);
    }
    // 조기 종료 → 한 줄 문답
    host.emit('host:earlyEnd');
    check(`${n}P 마무리 진입`, await waitFor('wrapup', (s) => s.stage === 'wrapup'));
    for (const [charId, p] of Object.entries(players)) {
      p.sock.emit('wrapup:answer', `${charId}의 ${n}페이즈 답변`);
      await sleep(80);
    }
    check(`${n}P 문답 공개`, await waitFor('revealed', (s) => s.wrapup && s.wrapup.revealed));
    players.detective.sock.emit('record:submit', `${n}페이즈 잠정 결론`);
    await sleep(300);
  }

  await runPhase(1);
  check('2페이즈 진입 + NPC 카드', await waitFor('p2', (s) => s.phase === 2 && s.npcLog.length >= 2));
  await runPhase(2);
  check('3페이즈 진입', await waitFor('p3', (s) => s.phase === 3));
  await runPhase(3);
  check('4페이즈 진입', await waitFor('p4', (s) => s.phase === 4 && s.pondOpen));

  // 4P: 서린·송이 연못 → 2번째에 NPC 자동(+4s) → 3번째 계시(+4.5s)
  await runPhaseWithPondChecks();

  async function runPhaseWithPondChecks() {
    const total = lastState.totalClues;
    for (let i = 0; i < total; i++) { players.detective.sock.emit('clue:reveal'); await sleep(80); }
    players.seorin.sock.emit('pond:stand'); await sleep(300);
    check('연못 1: 서린', lastState.moonTokens === 1);
    players.songi.sock.emit('pond:stand');
    check('연못 2 → NPC 지석 자동 참여', await waitFor('npc stand', (s) => s.moonTokens === 3, 10000));
    check('세 번째 달조각 → 계시 공개', await waitFor('revelation', (s) => !!s.revelation, 10000));
    // 형사는 4페이즈에 못 섬
    players.detective.sock.emit('pond:stand'); await sleep(300);
    check('형사 4P 연못 차단', lastState.moonTokens === 3);
    host.emit('host:earlyEnd');
    await waitFor('wrapup4', (s) => s.stage === 'wrapup');
    for (const [charId, p] of Object.entries(players)) { p.sock.emit('wrapup:answer', charId + ' 4P 답'); await sleep(60); }
    await waitFor('revealed4', (s) => s.wrapup && s.wrapup.revealed);
    players.detective.sock.emit('record:submit', '4페이즈 잠정 결론');
    await sleep(300);
  }

  check('5페이즈 진입', await waitFor('p5', (s) => s.phase === 5));
  // 5P: 해월 + 형사 연못 → 달조각 5개
  const total5 = lastState.totalClues;
  for (let i = 0; i < total5; i++) { players.detective.sock.emit('clue:reveal'); await sleep(80); }
  players.haewol.sock.emit('pond:stand'); await sleep(250);
  players.detective.sock.emit('pond:stand'); await sleep(250);
  check('달조각 5개 완성', lastState.moonTokens === 5);
  host.emit('host:earlyEnd');
  await waitFor('wrapup5', (s) => s.stage === 'wrapup');
  for (const [charId, p] of Object.entries(players)) { p.sock.emit('wrapup:answer', charId + ' 5P 답'); await sleep(60); }
  await waitFor('revealed5', (s) => s.wrapup && s.wrapup.revealed);
  players.detective.sock.emit('record:submit', '5페이즈 잠정 결론');

  check('NPC 카드5 (마지막 말)', await waitFor('npcFinal', (s) => s.stage === 'npcFinal'));
  host.emit('host:toRecon');
  check('형사의 재구성 + 기록 5줄', await waitFor('recon', (s) => s.stage === 'recon' && s.records.length === 5));
  host.emit('host:beginSpeeches');
  check('최후의 발언 시작 (4인 순서)', await waitFor('speeches', (s) => s.stage === 'speeches' && s.speech.order.length === 4));
  for (let i = 0; i < 4; i++) { host.emit('host:nextSpeech'); await sleep(150); }
  check('투표 진입', await waitFor('vote', (s) => s.stage === 'vote'));

  // 전원 자기 지목 + 달조각 5 → 히든 굿
  for (const [charId, p] of Object.entries(players)) { p.sock.emit('vote:cast', charId); await sleep(100); }
  check('엔딩 도달', await waitFor('ending', (s) => s.stage === 'ending'));
  check('히든 굿엔딩 [수면 아래의 아이]', lastState.ending && lastState.ending.key === 'hiddenGood');
  check('에필로그/타임라인 포함', lastState.ending && lastState.ending.epilogue.length > 0 && lastState.ending.timeline.length > 0);

  // 초기화 확인
  host.emit('host:newGame');
  check('새 게임 초기화', await waitFor('reset', (s) => s.stage === 'lobby' && s.players.length === 0));

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n결과: ${results.length - fails}/${results.length} 통과`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
