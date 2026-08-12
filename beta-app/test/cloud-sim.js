// 클라우드(WebSocket/DO) 배포판 E2E 시뮬레이션 — 비공개 단서 배분제·취조·NPC 정해월
// 사용: node test/cloud-sim.js wss://<host> [ROOMCODE]
//   (로컬 서버로도 실행 가능: node test/cloud-sim.js ws://localhost:3000)
const WebSocket = require('ws');

const base = process.argv[2];
if (!base) { console.log('usage: node cloud-sim.js wss://host [room]'); process.exit(1); }
const room = process.argv[3] || 'SIM' + Math.random().toString(36).slice(2, 6).toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastState = null;
const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); console.log((cond ? 'OK   ' : 'FAIL ') + name); };

function mk(role) {
  const ws = new WebSocket(`${base}/ws?room=${room}&role=${role}`);
  const api = {
    ws, open: new Promise((res) => ws.on('open', res)),
    send: (t, d) => ws.send(JSON.stringify({ t, d })),
    private: null,
  };
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.t === 'state') lastState = m.d;
      else if (m.t === 'private') api.private = m.d;
    } catch {}
  });
  ws.on('error', (e) => console.log(`[${role}] ws error:`, e.message));
  return api;
}

async function waitFor(desc, fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (lastState && fn(lastState)) return true; await sleep(200); }
  console.log('TIMEOUT: ' + desc); return false;
}
async function waitPriv(desc, api, fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (api.private && fn(api.private)) return true; await sleep(200); }
  console.log('TIMEOUT(priv): ' + desc); return false;
}

// 페이즈별 일반 단서 수(기억 조각 제외) — content.js 기준
const REGULAR = { 1: 5, 2: 5, 3: 5, 4: 6, 5: 5 };
const chars = ['detective', 'seorin', 'songi', 'jiseok']; // NPC = haewol

(async () => {
  console.log('room:', room);
  const host = mk('host');
  await host.open;
  const players = {};
  for (const c of chars) {
    players[c] = mk('player');
    await players[c].open;
  }
  host.send('host:newGame');
  await sleep(400);

  for (const c of chars) {
    players[c].send('register', { token: 'tok-' + c, name: 'T-' + c });
    await sleep(150);
    players[c].send('pickChar', c);
    await sleep(150);
  }
  check('4인 입장/선택', await waitFor('picked', (s) => s.charList.filter((x) => x.taken).length === 4));
  host.send('host:preset', 'test'); await sleep(200);
  host.send('host:start');
  check('오프닝+NPC 모드(해월)', await waitFor('opening', (s) => s.stage === 'opening' && s.npcMode && s.charList.find((x) => x.id === 'haewol').npc));

  // 페이즈 공통 헬퍼: 손패 전부 clue:show 공개
  async function revealAll() {
    for (const c of chars) {
      for (;;) {
        const hand = (players[c].private && players[c].private.hand) || [];
        if (!hand.length) break;
        const h = hand[0];
        const before = lastState.clueLog.length;
        players[c].send('clue:show', { phase: h.phase, idx: h.idx });
        await waitFor(`${c} show`, (s) => s.clueLog.length === before + 1);
        await waitPriv(`${c} hand sync`, players[c], (p) => !p.hand.some((x) => x.phase === h.phase && x.idx === h.idx));
      }
    }
  }
  // 페이즈 마무리: 조기 종료 → 한 줄 문답 → 형사의 기록
  async function wrapAndRecord(n) {
    host.send('host:earlyEnd');
    check(`${n}P 마무리`, await waitFor(`wrap${n}`, (s) => s.stage === 'wrapup'));
    for (const c of chars) { players[c].send('wrapup:answer', `${c} ${n}P 답`); await sleep(80); }
    await waitFor(`rev${n}`, (s) => s.wrapup && s.wrapup.revealed);
    players.detective.send('record:submit', `${n}P 잠정 결론`);
    await sleep(400);
  }

  // ── 1페이즈: 배분·공개·취조 ──
  host.send('host:beginPhase1');
  check('1페이즈 시작', await waitFor('p1', (s) => s.stage === 'phase' && s.phase === 1));
  check('1P NPC 해월 카드1', await waitFor('npc1', (s) => s.npcLog.length === 1 && s.npcLog[0].title.includes('정해월')));
  let hands1 = true;
  for (const c of chars) hands1 = (await waitPriv(`${c} hand1`, players[c], (p) => (p.hand || []).filter((h) => h.phase === 1).length === 1)) && hands1;
  check('1P 배분: 각자 hand 1장', hands1);
  check('1P 잔여 단서 연못 공개', await waitFor('pond1', (s) => s.clueLog.length === REGULAR[1] - 4 && s.clueLog.every((c) => !c.by)));
  check('기억 조각 clueLog 미포함', !lastState.clueLog.some((c) => c.title.includes('기억 조각')));
  check('형사 memories 1개', await waitPriv('mem1', players.detective, (p) => (p.memories || []).length === 1));
  check('handCounts 공개 정보', chars.every((c) => lastState.handCounts[c] === 1));

  for (const c of ['detective', 'seorin']) {
    const h = players[c].private.hand[0];
    const before = lastState.clueLog.length;
    players[c].send('clue:show', { phase: h.phase, idx: h.idx });
    await waitFor(`${c} show`, (s) => s.clueLog.length === before + 1);
  }
  check('1P clue:show 2장 공개', lastState.clueLog.length === 3 && lastState.clueLog.filter((c) => c.by).length === 2);
  check('clue:show hand 감소', await waitPriv('det hand 0', players.detective, (p) => p.hand.length === 0));

  players.detective.send('interrogate', 'songi');
  check('취조 강제 공개', await waitFor('forced', (s) => s.clueLog.length === 4 && s.clueLog.some((c) => c.by === 'songi' && c.forced)));
  check('interrogateUsed=true', await waitFor('used', (s) => s.interrogateUsed === true));
  check('songi hand 0', await waitPriv('songi hand 0', players.songi, (p) => p.hand.length === 0));

  players.detective.send('interrogate', 'jiseok');
  await sleep(600);
  check('취조 재사용 거부', lastState.clueLog.length === 4 && players.jiseok.private.hand.length === 1);

  {
    const h = players.jiseok.private.hand[0];
    players.jiseok.send('clue:show', { phase: h.phase, idx: h.idx });
    check('1P 지석 공개(전 장 공개)', await waitFor('jshow', (s) => s.clueLog.length === 5));
  }
  await wrapAndRecord(1);
  let clueTotal = 5;

  // ── 2~3페이즈 순회 ──
  for (const n of [2, 3]) {
    check(`${n}페이즈`, await waitFor(`p${n}`, (s) => s.stage === 'phase' && s.phase === n));
    check(`${n}P NPC 카드`, await waitFor(`npc${n}`, (s) => s.npcLog.length === n));
    if (n === 2) check('취조 페이즈 리셋', lastState.interrogateUsed === false);
    let ok = true;
    for (const c of chars) ok = (await waitPriv(`${c} hand${n}`, players[c], (p) => p.hand.some((h) => h.phase === n))) && ok;
    check(`${n}P 배분`, ok);
    clueTotal += REGULAR[n] - 4;
    check(`${n}P 잔여 연못 공개`, await waitFor(`pond${n}`, (s) => s.clueLog.length === clueTotal));
    await revealAll();
    clueTotal += 4;
    check(`${n}P 전 장 공개`, lastState.clueLog.length === clueTotal);
    await wrapAndRecord(n);
  }

  // ── 4페이즈: 연못 ──
  check('4페이즈+연못 개방', await waitFor('p4', (s) => s.stage === 'phase' && s.phase === 4 && s.pondOpen));
  check('4P NPC 카드', await waitFor('npc4', (s) => s.npcLog.length === 4));
  let ok4 = true;
  for (const c of chars) ok4 = (await waitPriv(`${c} hand4`, players[c], (p) => p.hand.some((h) => h.phase === 4))) && ok4;
  check('4P 배분', ok4);
  clueTotal += REGULAR[4] - 4;
  check('4P 잔여 연못 공개 2장', await waitFor('pond4', (s) => s.clueLog.length === clueTotal));
  await revealAll();
  clueTotal += 4;

  players.seorin.send('pond:stand');
  check('달조각 1', await waitFor('m1', (s) => s.moonTokens === 1));
  players.songi.send('pond:stand');
  check('달조각 2→NPC 해월 자동 3 + 계시', await waitFor('m3', (s) => s.moonTokens === 3 && s.pondStood.some((x) => x.charId === 'haewol') && !!s.revelation));
  players.detective.send('pond:stand');
  await sleep(500);
  check('형사 4P 차단', lastState.moonTokens === 3);
  await wrapAndRecord(4);

  // ── 5페이즈 ──
  check('5페이즈', await waitFor('p5', (s) => s.stage === 'phase' && s.phase === 5));
  check('5P NPC 카드 없음(카드4까지)', lastState.npcLog.length === 4);
  let ok5 = true;
  for (const c of chars) ok5 = (await waitPriv(`${c} hand5`, players[c], (p) => p.hand.some((h) => h.phase === 5))) && ok5;
  check('5P 배분', ok5);
  clueTotal += REGULAR[5] - 4;
  check('5P 잔여 연못 공개', await waitFor('pond5', (s) => s.clueLog.length === clueTotal));
  await revealAll();
  clueTotal += 4;

  players.jiseok.send('pond:stand');
  check('달조각 4', await waitFor('m4', (s) => s.moonTokens === 4));
  players.detective.send('pond:stand');
  check('달조각 5개', await waitFor('m5', (s) => s.moonTokens === 5));
  await wrapAndRecord(5);

  // ── 종반 ──
  check('NPC 해월 카드5(마지막 말)', await waitFor('npcFinal', (s) => s.stage === 'npcFinal' && s.npcLog.length === 5 && s.npcLog[4].title.includes('카드 5')));
  host.send('host:toRecon');
  check('재구성+기록 5줄', await waitFor('recon', (s) => s.stage === 'recon' && s.records.length === 5));
  host.send('host:beginSpeeches');
  check('최후의 발언(해월 제외 4인)', await waitFor('speeches', (s) => s.stage === 'speeches' && s.speech && s.speech.order.length === 4 && !s.speech.order.includes('haewol')));
  for (let i = 0; i < 4; i++) { host.send('host:nextSpeech'); await sleep(200); }
  check('투표', await waitFor('vote', (s) => s.stage === 'vote'));
  for (const c of chars) { players[c].send('vote:cast', c); await sleep(120); }
  check('엔딩', await waitFor('end', (s) => s.stage === 'ending'));
  check('히든 굿 [수면 아래의 아이]', lastState.ending && lastState.ending.key === 'hiddenGood');

  host.send('host:newGame');
  check('초기화', await waitFor('reset', (s) => s.stage === 'lobby' && s.players.length === 0));

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n결과: ${results.length - fails}/${results.length} 통과`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
