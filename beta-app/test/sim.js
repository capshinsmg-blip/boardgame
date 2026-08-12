// E2E 시뮬레이션: 4인(형사·서린·송이·지석) + NPC 정해월
// 비공개 단서 배분 / clue:show / 취조 / 기억 조각 비공개 포함 전체 플로우 → 히든 굿엔딩 검증
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
    detective: { sock: mkSocket('det'), token: 'tok-det', name: '테스터A', private: null },
    seorin: { sock: mkSocket('seorin'), token: 'tok-seorin', name: '테스터B', private: null },
    songi: { sock: mkSocket('songi'), token: 'tok-songi', name: '테스터C', private: null },
    jiseok: { sock: mkSocket('jiseok'), token: 'tok-jiseok', name: '테스터D', private: null },
  };
  for (const p of Object.values(players)) p.sock.on('private', (pv) => { p.private = pv; });

  async function waitPriv(desc, charId, fn, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const pv = players[charId].private;
      if (pv && fn(pv)) return true;
      await sleep(150);
    }
    console.log('TIMEOUT waiting(priv): ' + desc);
    return false;
  }

  await sleep(400);
  host.emit('host:newGame');
  await sleep(300);

  // 1. 입장 + 인물 선택 (4인 — haewol은 NPC)
  for (const [charId, p] of Object.entries(players)) {
    p.sock.emit('register', { token: p.token, name: p.name });
    await sleep(120);
    p.sock.emit('pickChar', charId);
    await sleep(120);
  }
  check('4인 입장/선택 (해월 미선택)', await waitFor('4 picked', (s) => s.charList.filter((c) => c.taken).length === 4 && !s.charList.find((c) => c.id === 'haewol').taken));

  host.emit('host:preset', 'test');
  await sleep(150);
  host.emit('host:start');
  check('오프닝 진입 + NPC 모드(정해월)', await waitFor('opening', (s) => s.stage === 'opening' && s.npcMode === true && s.charList.find((c) => c.id === 'haewol').npc === true));
  host.emit('host:beginPhase1');
  check('1페이즈 시작', await waitFor('phase1', (s) => s.stage === 'phase' && s.phase === 1));

  // 2. 1페이즈: NPC 카드 + 비공개 배분 검증
  check('1P NPC 해월 카드1 공개', await waitFor('npc1', (s) => s.npcLog.length === 1 && s.npcLog[0].phase === 1 && s.npcLog[0].title.includes('정해월')));
  let handOk = true;
  for (const charId of Object.keys(players)) handOk = handOk && await waitPriv(`${charId} hand 1장`, charId, (pv) => pv.hand && pv.hand.length === 1 && pv.hand[0].phase === 1);
  check('1P 각자 hand 1장 배분 (private)', handOk);
  check('1P 잔여 단서 자동 공개 (clueLog 1장, by 없음)', await waitFor('auto clue', (s) => s.clueLog.length === 1 && !s.clueLog[0].by));
  check('1P 기억 조각이 clueLog에 없음', lastState.clueLog.every((c) => !c.title.includes('기억 조각')));
  check('1P 형사 기억 조각 1개 해금 (비공개)', await waitPriv('memories 1', 'detective', (pv) => pv.memories && pv.memories.length === 1));
  check('1P handCounts 공개 정보 (합 4)', Object.values(lastState.handCounts).reduce((a, b) => a + b, 0) === 4);

  // 3. clue:show 자유 공개 → clueLog 증가, hand 감소
  for (const p of Object.values(players)) {
    const h = p.private.hand[0];
    p.sock.emit('clue:show', { phase: h.phase, idx: h.idx });
    await sleep(120);
  }
  check('1P clue:show 전원 공개 → clueLog 5장', await waitFor('clueLog 5', (s) => s.clueLog.length === 5));
  check('1P 공개자(by) 표기 4건', lastState.clueLog.filter((c) => c.by && !c.forced).length === 4);
  check('1P hand 소진', await waitPriv('songi hand 0', 'songi', (pv) => pv.hand.length === 0) && Object.values(lastState.handCounts).every((n) => n === 0));

  // 페이즈 마무리 공통 루틴 (조기 종료 → 한 줄 문답 → 형사의 기록)
  async function wrapPhase(n) {
    host.emit('host:earlyEnd');
    if (!await waitFor(`wrapup${n}`, (s) => s.stage === 'wrapup')) return false;
    for (const [charId, p] of Object.entries(players)) { p.sock.emit('wrapup:answer', `${charId}의 ${n}P 답변`); await sleep(80); }
    if (!await waitFor(`revealed${n}`, (s) => s.wrapup && s.wrapup.revealed)) return false;
    players.detective.sock.emit('record:submit', `${n}페이즈 잠정 결론`);
    await sleep(300);
    return true;
  }

  check('1P 마무리(문답+기록)', await wrapPhase(1));
  check('2페이즈 진입 + NPC 카드2 + 재배분', await waitFor('p2', (s) => s.stage === 'phase' && s.phase === 2 && s.npcLog.length === 2)
    && await waitPriv('songi hand p2', 'songi', (pv) => pv.hand.length === 1 && pv.hand[0].phase === 2));
  check('2P 취조 사용 여부 초기화', lastState.interrogateUsed === false);
  check('2P 형사 기억 조각 2개', await waitPriv('mem2', 'detective', (pv) => pv.memories.length === 2));

  // 4. 취조: 송이가 1장 숨긴 상태 → 강제 공개, 재사용 거부
  players.detective.sock.emit('interrogate', 'songi');
  check('취조 → 송이 단서 강제 공개(forced)', await waitFor('forced', (s) => s.clueLog.some((c) => c.by === 'songi' && c.forced) && s.handCounts.songi === 0));
  check('취조 사용됨(interrogateUsed)', await waitFor('used', (s) => s.interrogateUsed === true));
  const logAfterForced = lastState.clueLog.length;
  players.detective.sock.emit('interrogate', 'seorin');
  await sleep(500);
  check('취조 재사용 거부', lastState.clueLog.length === logAfterForced && lastState.handCounts.seorin === 1);

  // 남은 손패 공개 후 2P 마무리
  for (const charId of ['detective', 'seorin', 'jiseok']) {
    const p = players[charId];
    const h = p.private.hand[0];
    p.sock.emit('clue:show', { phase: h.phase, idx: h.idx });
    await sleep(120);
  }
  await waitFor('hands clear p2', (s) => Object.values(s.handCounts).every((n) => n === 0));
  check('2P 마무리', await wrapPhase(2));

  // 5. 3페이즈 순회
  check('3페이즈 진입 + NPC 카드3 + 재배분', await waitFor('p3', (s) => s.stage === 'phase' && s.phase === 3 && s.npcLog.length === 3)
    && await waitPriv('jiseok hand p3', 'jiseok', (pv) => pv.hand.length === 1 && pv.hand[0].phase === 3));
  for (const p of Object.values(players)) {
    const h = p.private.hand[0];
    p.sock.emit('clue:show', { phase: h.phase, idx: h.idx });
    await sleep(120);
  }
  check('3P 마무리', await wrapPhase(3));

  // 6. 4페이즈: 연못 — 서린·송이 → NPC 해월 자동(3토큰) + 계시, 형사 차단
  check('4페이즈 진입 + NPC 카드4 + 연못 개방', await waitFor('p4', (s) => s.stage === 'phase' && s.phase === 4 && s.npcLog.length === 4 && s.pondOpen));
  check('4P 잔여 단서 2장 자동 공개 (6장 중 4장 배분)', lastState.clueLog.filter((c) => c.phase === 4 && !c.by).length === 2);
  players.seorin.sock.emit('pond:stand'); await sleep(300);
  check('연못 1: 서린', lastState.moonTokens === 1);
  players.songi.sock.emit('pond:stand');
  check('연못 2 → NPC 해월 자동 참여(3토큰)', await waitFor('npc stand', (s) => s.moonTokens === 3 && s.pondStood.some((x) => x.charId === 'haewol'), 10000));
  check('세 번째 달조각 → 계시 공개', await waitFor('revelation', (s) => !!s.revelation, 10000));
  players.detective.sock.emit('pond:stand'); await sleep(300);
  check('형사 4P 연못 차단', lastState.moonTokens === 3);
  check('4P 마무리', await wrapPhase(4));

  // 7. 5페이즈: 지석 + 형사 연못 → 5토큰
  check('5페이즈 진입 + NPC 카드 유지 + 재배분', await waitFor('p5', (s) => s.stage === 'phase' && s.phase === 5)
    && await waitPriv('det hand p5', 'detective', (pv) => pv.hand.some((h) => h.phase === 5)));
  check('5P 형사 기억 조각 5개', await waitPriv('mem5', 'detective', (pv) => pv.memories.length === 5));
  players.jiseok.sock.emit('pond:stand'); await sleep(300);
  players.detective.sock.emit('pond:stand'); await sleep(300);
  check('달조각 5개 완성', await waitFor('tokens5', (s) => s.moonTokens === 5));
  check('5P 마무리', await wrapPhase(5));

  // 8. npcFinal → recon → speeches → vote → 히든 굿엔딩
  check('NPC 카드5 (해월의 마지막 말)', await waitFor('npcFinal', (s) => s.stage === 'npcFinal' && s.npcLog.length === 5));
  host.emit('host:toRecon');
  check('형사의 재구성 + 기록 5줄', await waitFor('recon', (s) => s.stage === 'recon' && s.records.length === 5));
  host.emit('host:beginSpeeches');
  check('최후의 발언 (4인, 해월 제외)', await waitFor('speeches', (s) => s.stage === 'speeches' && s.speech.order.length === 4 && !s.speech.order.includes('haewol')));
  for (let i = 0; i < 4; i++) { host.emit('host:nextSpeech'); await sleep(150); }
  check('투표 진입', await waitFor('vote', (s) => s.stage === 'vote'));
  for (const [charId, p] of Object.entries(players)) { p.sock.emit('vote:cast', charId); await sleep(100); }
  check('엔딩 도달', await waitFor('ending', (s) => s.stage === 'ending'));
  check('히든 굿엔딩 [수면 아래의 아이]', lastState.ending && lastState.ending.key === 'hiddenGood');
  check('에필로그/타임라인 포함', lastState.ending && lastState.ending.epilogue.length > 0 && lastState.ending.timeline.length > 0);
  check('기억 조각 비공개 유지 (최종 clueLog)', lastState.clueLog.every((c) => !c.title.includes('기억 조각')));

  // 9. 초기화
  host.emit('host:newGame');
  check('새 게임 초기화', await waitFor('reset', (s) => s.stage === 'lobby' && s.players.length === 0));

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n결과: ${results.length - fails}/${results.length} 통과`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
