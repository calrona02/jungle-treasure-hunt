// End-to-end tests for: format agreement, ten-expedition series, flexible votes, final results, trophy reveal.
process.env.TIME_SCALE = process.env.TIME_SCALE || '0.004'; process.env.PORT = '0';
const WebSocket = require('ws'); const { server } = require('./server.js');
let pass = 0, fail = 0; const t = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d === undefined ? '' : d); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
let port;
function client(name, color, opts = {}) {
  const c = { name, msgs: [], id: null, token: null, auto: opts.auto !== false, voter: opts.voter || (() => 'continue') };
  c.connect = () => new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws = ws; ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name, avatar: color % 8, color })); res(); });
    ws.on('message', raw => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'welcome' && m.you) { c.id = m.you; c.token = m.token; } c.handle(m); }); });
  c.send = o => c.ws.readyState === 1 && c.ws.send(JSON.stringify(o));
  c.handle = m => { if (!c.auto) return;
    if (m.t === 'turn' && m.playerId === c.id) setTimeout(() => { c.send({ t: 'select', route: Math.floor(Math.random() * 24) }); setTimeout(() => c.send({ t: 'track' }), 3); }, 3);
    if (m.t === 'vote_open' && m.humans.includes(c.id)) setTimeout(() => c.send({ t: 'vote', choice: c.voter(m.expedition) }), 5);
    if (m.t === 'next_prompt') setTimeout(() => c.send({ t: 'next' }), 5); };
  c.last = type => c.msgs.filter(m => m.t === type).pop(); c.all = type => c.msgs.filter(m => m.t === type);
  return c;
}
async function room(humans, bots, { choose = 'full', host = 0 } = {}) {
  const cs = humans.map((h, i) => client(h.name, i, h)); await cs[0].connect(); cs[0].send({ t: 'create' }); await wait(60); const code = cs[0].last('room').code;
  for (let i = 1; i < cs.length; i++) { await cs[i].connect(); await wait(15); cs[i].send({ t: 'join', code }); await wait(25); }
  for (let i = 0; i < bots; i++) { cs[0].send({ t: 'addbot', level: ['easy', 'medium', 'hard', 'expert'][i % 4] }); await wait(25); }
  if (choose) cs.forEach(c => c.send({ t: 'choose', format: typeof choose === 'function' ? choose(c) : choose })); await wait(80); return cs;
}
const until = (fn, ms = 120000) => new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (fn()) { clearInterval(iv); res(true); } else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); } }, 25); });
function replayWins(msgs, ids) { const wins = {}, tot = {}; ids.forEach(i => { wins[i] = 0; tot[i] = 0; }); msgs.filter(m => m.t === 'game_over').forEach(g => { g.standings.forEach(s => tot[s.id] += s.score); g.expWinners.forEach(i => wins[i]++); }); return { wins, tot }; }

(async () => {
  await new Promise(r => server.listen(0, r)); port = server.address().port;

  /* A. agreement */
  { const cs = await room([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 1, { choose: null }); const host = cs[0];
    host.send({ t: 'start' }); await wait(60); t('cannot start before anyone has chosen', host.msgs.some(m => m.t === 'error' && m.code === 'FORMAT_PENDING'));
    cs[0].send({ t: 'choose', format: 'full' }); cs[1].send({ t: 'choose', format: 'full' }); await wait(60);
    let r = host.last('room'); t('room shows who agreed and who is waiting', r.agree.waiting.length === 1 && !r.agree.ok);
    host.msgs.length = 0; host.send({ t: 'start' }); await wait(60); t('cannot start while one human is still waiting', host.msgs.some(m => m.code === 'FORMAT_PENDING') && !host.msgs.some(m => m.t === 'game_start'));
    cs[2].send({ t: 'choose', format: 'flexible' }); await wait(60); r = host.last('room'); t('mismatch is reported', r.agree.mismatch === true);
    host.msgs.length = 0; host.send({ t: 'start' }); await wait(60); t('cannot start on different formats', host.msgs.some(m => m.code === 'FORMAT_MISMATCH'));
    cs[2].send({ t: 'choose', format: 'full' }); await wait(60); r = host.last('room'); t('all agree → startable', r.agree.ok && r.agree.format === 'full');
    host.send({ t: 'start' }); await wait(150); const gs = host.last('game_start'); t('game starts and announces the locked format', gs && gs.format === 'full' && gs.maxExp === 10);
    cs[1].msgs.length = 0; cs[1].send({ t: 'choose', format: 'flexible' }); await wait(60); t('format is locked once the game starts', cs[1].msgs.some(m => m.code === 'FORMAT_LOCKED'));
    cs.forEach(c => c.ws.close()); await wait(50); }

  /* B. full game, 4 players (2 humans + 2 AI): ten expeditions, final only once, trophy reveal */
  { const cs = await room([{ name: 'Ana' }, { name: 'Ben' }], 2, { choose: 'full' }); const [a, b] = cs; a.send({ t: 'start' });
    const ok = await until(() => a.last('final'), 180000); t('full game reaches the final screen', ok); if (!ok) { console.log('pass', pass, 'fail', fail); process.exit(1); }
    const overs = a.all('game_over'); t('exactly ten per-expedition results, in order', overs.length === 10 && overs.every((g, i) => g.series.expPlayed === i + 1 && g.expedition === i + 1));
    t('every device got the same ten results', JSON.stringify(a.all('game_over').map(g => g.winners)) === JSON.stringify(b.all('game_over').map(g => g.winners)));
    const fa = a.all('final'), fb = b.all('final'); t('final results sent once, never earlier', fa.length === 1 && fb.length === 1 && a.msgs.indexOf(fa[0]) > a.msgs.indexOf(overs[9]) && !a.msgs.slice(0, a.msgs.indexOf(overs[9])).some(m => m.t === 'final'));
    const F = fa[0].final, ids = F.ranking.map(r => r.id), { wins, tot } = replayWins(a.msgs, ids);
    t('final wins/totals equal an independent replay of the ten results', F.ranking.every(r => r.wins === wins[r.id] && r.total === tot[r.id]), JSON.stringify([wins, tot]));
    const maxW = Math.max(...Object.values(wins)); const cand = ids.filter(i => wins[i] === maxW), best = Math.max(...cand.map(i => tot[i])); const exp = cand.filter(i => tot[i] === best);
    t('overall winner = most expedition wins, ties by total score', JSON.stringify(F.winners.sort()) === JSON.stringify(exp.sort()), JSON.stringify({ wins, tot, w: F.winners }));
    t('ranking sorted by wins then total', F.ranking.every((r, i) => !i || F.ranking[i - 1].wins > r.wins || (F.ranking[i - 1].wins === r.wins && F.ranking[i - 1].total >= r.total)));
    t('rule text + table of ten expedition winners present', F.rule === 'The winner is the player who won the most expeditions.' && F.table.length === 10);
    t('full game = trophy eligible (or nobody scored)', fa[0].trophy.eligible === (F.winners.length > 0));
    if (fa[0].trophy.eligible) {
      const wid = F.winners, humanWinners = [a, b].filter(c => wid.includes(c.id)), nonWinnerHuman = [a, b].find(c => !wid.includes(c.id)), aiOnly = fa[0].trophy.aiOnly;
      if (aiOnly) { const ok2 = await until(() => a.last('trophy_reveal') && b.last('trophy_reveal'), 20000); t('AI winner: trophy reveals automatically on every device', ok2 && a.all('trophy_reveal').length === 1); }
      else {
        if (nonWinnerHuman) { nonWinnerHuman.send({ t: 'reveal' }); await wait(40); t('a non-winner cannot reveal before the unlock', !nonWinnerHuman.last('trophy_reveal') && nonWinnerHuman.msgs.some(m => m.code === 'ONLY_WINNER')); }
        const w = humanWinners[0]; for (let i = 0; i < 5; i++) w.send({ t: 'reveal' }); await wait(200);
        t('reveal press counted once even when pressed 5 times', a.all('trophy_reveal').length === 1 && b.all('trophy_reveal').length === 1, a.all('trophy_reveal').length);
        const ra = a.last('trophy_reveal'), rb = b.last('trophy_reveal'); t('both screens receive the same trophy payload (names + wins)', JSON.stringify(ra) === JSON.stringify(rb) && ra.winners.every(x => x.wins === maxW));
      } }
    cs.forEach(c => c.ws.close()); await wait(50); }

  /* C. unlock path: winner never presses → anyone can trigger the reveal after the timeout */
  { const cs = await room([{ name: 'Una' }, { name: 'Vik' }], 2, { choose: 'full' }); const [a, b] = cs; a.send({ t: 'start' }); await until(() => a.last('final'), 180000);
    const fin = a.last('final');
    if (fin.trophy.eligible && !fin.trophy.aiOnly) { const winnerIds = fin.final.winners, other = [a, b].find(c => !winnerIds.includes(c.id)) || a;
      const ok = await until(() => a.last('reveal_unlocked'), 20000); t('after the timeout the reveal is unlocked for everyone', ok);
      other.send({ t: 'reveal' }); other.send({ t: 'reveal' }); await wait(200); t('anyone can reveal after the timeout, still only once', a.all('trophy_reveal').length === 1 && b.all('trophy_reveal').length === 1); }
    else t('(skipped: AI or no winner this run)', true);
    cs.forEach(c => c.ws.close()); await wait(50); }

  /* D. flexible: vote after every expedition; majority "end" at expedition 3; no trophy */
  { const voter = e => 'end'; const cs = await room([{ name: 'P1', voter: e => (e >= 3 ? 'end' : 'continue') }, { name: 'P2', voter: e => (e >= 3 ? 'end' : 'continue') }, { name: 'P3', voter: e => 'continue' }, { name: 'P4', voter: e => (e >= 3 ? 'end' : 'continue') }], 1, { choose: 'flexible' });
    cs[0].send({ t: 'start' }); const ok = await until(() => cs[0].last('final'), 180000); t('flexible game ends early by vote', ok);
    const opens = cs[0].all('vote_open'); t('the vote appears after every expedition until the end', opens.length === 3 && opens.map(o => o.expedition).join() === '1,2,3');
    const res = cs[0].all('vote_result'); t('exp 1-2: continue; exp 3: 3 of 4 humans voted end → ends', res.length === 3 && !res[0].end && !res[1].end && res[2].end && res[2].endVotes === 3, JSON.stringify(res.map(r => r.end)));
    const F = cs[0].last('final'); t('flexible final: after expedition 3 of 10, no trophy', F.final.line === 'Game ended after expedition 3 of 10' && F.trophy.eligible === false && !cs[0].last('trophy_reveal'));
    t('final results still show ranking and the ten-slot table (3 played)', F.final.ranking.length === 5 && F.final.table.length === 3);
    cs[0].send({ t: 'newgame' }); await wait(100); const r = cs[1].last('room'); t('Play Again returns to the lobby with the format agreement reset', r.status === 'lobby' && r.players.filter(p => !p.bot).every(p => p.choice === null) && r.format === null);
    cs.forEach(c => c.ws.close()); await wait(50); }

  /* E. solo: 1 human + AI, full game */
  { const cs = await room([{ name: 'Solo' }], 1, { choose: 'full' }); cs[0].send({ t: 'start' }); const ok = await until(() => cs[0].last('final'), 180000); t('solo (1 human + AI) plays all ten expeditions', ok && cs[0].all('game_over').length === 10);
    const F = cs[0].last('final'); t('AI appears in results/final as a named player', F.final.ranking.some(r => r.isAI) && F.final.ranking.length === 2);
    if (F.trophy.eligible) { if (F.trophy.aiOnly) { const ok2 = await until(() => cs[0].last('trophy_reveal'), 20000); t('solo, AI wins: automatic reveal with the AI named', ok2 && cs[0].last('trophy_reveal').winners.every(w => w.isAI)); } else { cs[0].send({ t: 'reveal' }); await wait(120); t('solo, human wins: reveal works', !!cs[0].last('trophy_reveal')); } }
    cs.forEach(c => c.ws.close()); await wait(50); }

  /* F. ten humans, flexible, one expedition then everyone votes end → final */
  { const humans = Array.from({ length: 10 }, (_, i) => ({ name: 'H' + i, voter: e => 'end' })); const cs = await room(humans, 0, { choose: 'flexible' }); cs[0].send({ t: 'start' }); const ok = await until(() => cs[0].last('final'), 200000);
    t('10 humans: format agreed, one expedition (100 attempts) and vote → final', ok && cs[0].all('game_over').length === 1 && cs[0].last('final').final.ranking.length === 10);
    const o = cs[0].last('game_over'); t('100 attempts happened in the single expedition', o.standings.reduce((s, x) => s + x.attempts, 0) === 100);
    cs.forEach(c => c.ws.close()); }
  console.log('pass', pass, 'fail', fail); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('TEST EXC', e); process.exit(1); });
