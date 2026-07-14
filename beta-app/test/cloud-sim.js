// 클라우드(WebSocket/DO) 배포판 E2E 시뮬레이션
// 사용: node test/cloud-sim.js wss://<host> [ROOMCODE]
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
  };
  ws.on('message', (raw) => {
    try { const m = JSON.parse(raw); if (m.t === 'state') lastState = m.d; } catch {}
  });
  ws.on('error', (e) => console.log(`[${role}] ws error:`, e.message));
  return api;
}

async function waitFor(desc, fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (lastState && fn(lastState)) return true; await sleep(200); }
  console.log('TIMEOUT: ' + desc); return false;
}

(async () => {
  console.log('room:', room);
  const host = mk('host');
  await host.open;
  const chars = ['haewol', 'detective', 'seorin', 'songi'];
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
  check('오프닝+NPC 모드', await waitFor('opening', (s) => s.stage === 'opening' && s.npcMode));
  host.send('host:beginPhase1');
  check('1페이즈', await waitFor('p1', (s) => s.stage === 'phase' && s.phase === 1));

  const det = players.detective;
  async function phase(n, stands = []) {
    const total = lastState.totalClues;
    for (let i = 0; i < total; i++) { det.send('clue:reveal'); await sleep(120); }
    check(`${n}P 단서 ${total}장`, await waitFor('clues', (s) => s.cluesRevealed === total));
    for (const c of stands) { players[c].send('pond:stand'); await sleep(300); }
    host.send('host:earlyEnd');
    check(`${n}P 마무리`, await waitFor('wrap', (s) => s.stage === 'wrapup'));
    for (const c of chars) { players[c].send('wrapup:answer', `${c} ${n}P 답`); await sleep(80); }
    await waitFor('revealed', (s) => s.wrapup && s.wrapup.revealed);
    det.send('record:submit', `${n}P 잠정 결론`);
    await sleep(400);
  }

  await phase(1); check('2페이즈', await waitFor('p2', (s) => s.phase === 2));
  await phase(2); check('3페이즈', await waitFor('p3', (s) => s.phase === 3));
  await phase(3); check('4페이즈+연못 개방', await waitFor('p4', (s) => s.phase === 4 && s.pondOpen));

  // 4P: 서린·송이 → NPC 자동 → 계시
  const total4 = lastState.totalClues;
  for (let i = 0; i < total4; i++) { det.send('clue:reveal'); await sleep(100); }
  players.seorin.send('pond:stand');
  check('달조각 1', await waitFor('m1', (s) => s.moonTokens === 1));
  players.songi.send('pond:stand');
  check('달조각 2→NPC→3 + 계시', await waitFor('m3', (s) => s.moonTokens === 3 && !!s.revelation));
  det.send('pond:stand'); await sleep(400);
  check('형사 4P 차단', lastState.moonTokens === 3);
  host.send('host:earlyEnd');
  await waitFor('wrap4', (s) => s.stage === 'wrapup');
  for (const c of chars) { players[c].send('wrapup:answer', c + ' 4P 답'); await sleep(70); }
  await waitFor('rev4', (s) => s.wrapup && s.wrapup.revealed);
  det.send('record:submit', '4P 잠정 결론');

  check('5페이즈', await waitFor('p5', (s) => s.phase === 5));
  const total5 = lastState.totalClues;
  for (let i = 0; i < total5; i++) { det.send('clue:reveal'); await sleep(100); }
  players.haewol.send('pond:stand'); await sleep(300);
  det.send('pond:stand');
  check('달조각 5개', await waitFor('m5', (s) => s.moonTokens === 5));
  host.send('host:earlyEnd');
  await waitFor('wrap5', (s) => s.stage === 'wrapup');
  for (const c of chars) { players[c].send('wrapup:answer', c + ' 5P 답'); await sleep(70); }
  await waitFor('rev5', (s) => s.wrapup && s.wrapup.revealed);
  det.send('record:submit', '5P 잠정 결론');

  check('NPC 카드5', await waitFor('npcFinal', (s) => s.stage === 'npcFinal'));
  host.send('host:toRecon');
  check('재구성+기록 5줄', await waitFor('recon', (s) => s.stage === 'recon' && s.records.length === 5));
  host.send('host:beginSpeeches');
  check('최후의 발언', await waitFor('speeches', (s) => s.stage === 'speeches'));
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
