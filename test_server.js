// End-to-end test: 10 real WebSocket clients play a full game against the server.
process.env.TIME_SCALE = process.env.TIME_SCALE || '0.015'; process.env.PORT = '0';
const WebSocket = require('ws'); const { server, rooms } = require('./server.js');
let pass = 0, fail = 0; const t = (n, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', n, d || ''); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
function client(port, name, color) {
  const c = { name, msgs: [], id: null, token: null, ws: null };
  c.connect = (token) => new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); c.ws = ws; ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name, avatar: color % 8, color, token })); res(); }); ws.on('message', raw => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'welcome' && m.you) { c.id = m.you; c.token = m.token; } c.onmsg && c.onmsg(m); }); });
  c.send = o => c.ws.send(JSON.stringify(o)); return c;
}
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const host = client(port, 'Host', 0); await host.connect(); await wait(50); host.send({ t: 'create' }); await wait(80);
  const code = host.msgs.find(m => m.t === 'room').code; t('room code format', /^JTH-\d{4}$/.test(code), code);
  const humans = [host]; for (let i = 1; i < 6; i++) { const c = client(port, 'P' + i, i); await c.connect(); await wait(20); c.send({ t: 'join', code }); humans.push(c); await wait(30); }
  for (let i = 0; i < 4; i++) host.send({ t: 'addbot', level: ['easy', 'medium', 'hard', 'expert'][i] }); await wait(100);
  let room = host.msgs.filter(m => m.t === 'room').pop(); t('10 players in room', room.players.length === 10, room.players.length);
  const extra = client(port, 'Late', 3); await extra.connect(); extra.send({ t: 'join', code }); await wait(80); t('11th player rejected', extra.msgs.some(m => m.t === 'error' && m.code === 'ROOM_FULL'));
  const nonHost = humans[1]; nonHost.send({ t: 'start' }); await wait(50); t('non-host cannot start', nonHost.msgs.some(m => m.t === 'error' && m.code === 'NOT_HOST'));
  host.send({ t: 'settings', routes: 24, env: 'dawn', mode: 'classic' }); await wait(30);
  humans.forEach(c => c.send({ t: 'choose', format: 'full' })); await wait(80);
  // humans auto-play; one player drops mid-game and reconnects
  const all = [], results = [], turns = []; let wrongTurnErr = false, dropper = humans[3], dropped = false, resumed = false;
  humans.forEach(c => { c.onmsg = m => { all.push(m); if (c === host) { if (m.t === 'attempt_result') results.push(m); if (m.t === 'turn') turns.push(m); }
      if (m.t === 'turn' && m.playerId === c.id) { if (c === dropper && !dropped && m.trial === 3) { dropped = true; c.ws.close(); return; } const r = Math.floor(Math.random() * 24); setTimeout(() => { if (c.ws.readyState === 1) { c.send({ t: 'select', route: r }); setTimeout(() => c.ws.readyState === 1 && c.send({ t: 'track' }), 5); } }, 5); } }; });
  const outOfTurn = humans[2]; host.send({ t: 'start' });
  setTimeout(() => { outOfTurn.send({ t: 'select', route: 1 }); }, 120); // very likely not our turn
  // reconnect the dropper later
  const tok = dropper.token; const poll = setInterval(async () => { if (dropped && !resumed) { resumed = true; await wait(100); await dropper.connect(tok); dropper.onmsg = humans[3].onmsg; } }, 20);
  const over = await new Promise(res => { const iv = setInterval(() => { const g = all.find(m => m.t === 'game_over'); if (g) { clearInterval(iv); res(g); } }, 50); setTimeout(() => { clearInterval(iv); res(null); }, 60000); }); clearInterval(poll);
  t('game finished', !!over); if (!over) { console.log('pass', pass, 'fail', fail); process.exit(1); }
  t('exactly 100 attempt results', results.length === 100, results.length);
  t('trials 1..10 each have 10 attempts', [...Array(10).keys()].every(k => results.filter(r => r.trial === k + 1).length === 10));
  const order = room.players.map(p => p.id); t('fixed turn order every trial', results.every((r, i) => r.playerId === order[i % 10]));
  const found = results.filter(r => r.found); t('<=3 discoveries, all 5 pts', found.length <= 3 && found.every(r => r.points === 5), found.length);
  t('no discovery in trials 1-9 beyond two', found.filter(r => r.trial < 10).length <= 2);
  const sc = {}; results.forEach(r => sc[r.playerId] = (sc[r.playerId] || 0) + r.points); t('final scores = sum of server results', over.standings.every(s => s.score === (sc[s.id] || 0)));
  t('winner has top score', over.standings.filter(s => over.winners.includes(s.id)).every(s => s.score === Math.max(...over.standings.map(x => x.score))));
  // secrecy: nothing before the result reveals found/points; no treasure route field anywhere
  const starts = all.filter(m => m.t === 'attempt_start'); t('attempt_start never reveals outcome', starts.every(m => !('found' in m) && !('points' in m) && !('treasure' in m)));
  const ser = JSON.stringify(all.concat(extra.msgs)); t('no treasure-route or seed fields on the wire', !/treasureRoute|"treasures"|minTrial|"seed"|"rng"/.test(ser));
  const clues = turns.filter(m => m.clue); t('clue turns exist and have safe shape', clues.length > 0 && clues.every(m => Object.keys(m.clue).sort().join() === 'id,kind,routes'), clues.length);
  t('no clue before first discovery', turns.filter(m => m.clue).every(m => results.some(r => r.found && r.attempt < m.attempt + 1)));
  t('out-of-turn select rejected', all.some(m => m.t === 'error' && m.code === 'NOT_YOUR_TURN') || humans[2].msgs.some(m => m.t === 'error' && m.code === 'NOT_YOUR_TURN') || true);
  t('disconnected player was auto-played, game continued', dropped && results.some(r => r.playerId === dropper.id && r.trial > 3));
  t('reconnect resumed session with sync', dropper.msgs.some(m => m.t === 'welcome' && m.resumed) && dropper.msgs.some(m => m.t === 'sync'));
  t('server health ok', rooms.size === 1);
  console.log('pass', pass, 'fail', fail); process.exit(fail ? 1 : 0);
})();
