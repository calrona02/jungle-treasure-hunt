'use strict';
/* =====================================================================
   Jungle Treasure Hunt — authoritative game server
   - Owns the treasure routes, clues, scores, turn order and results.
   - Clients only ever send intents (select / track); they never receive
     treasure data except the outcome of an attempt, after the tracker arrives.
   - One process, in-memory rooms (see README for Redis/Postgres scale-out).
   ===================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { CONFIG, Expedition, Series, secureRng } = require('./engine.js');

const PORT = +process.env.PORT || 8080;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TS = +process.env.TIME_SCALE || 1; // tests run the clock faster
const T = {
  TURN_MS: (+process.env.TURN_MS || 30000) * TS, GRACE_MS: 4000 * TS, TRACK_MS: 1700 * TS, TRACK_MS_FAST: 1050 * TS, SUSPENSE_MS: 800 * TS, BOT_BASE: 3200 * TS, BOT_PICK: 700 * TS, BANNER_MS: 3500 * TS,
  RESULT_VIEW_MS: (+process.env.RESULT_VIEW_MS || 9000) * TS, NEXT_MS: (+process.env.NEXT_MS || 25000) * TS, VOTE_MS: (+process.env.VOTE_MS || 30000) * TS, FINAL_DELAY_MS: (+process.env.FINAL_DELAY_MS || 12000) * TS, REVEAL_UNLOCK_MS: (+process.env.REVEAL_UNLOCK_MS || 60000) * TS, AI_REVEAL_MS: (+process.env.AI_REVEAL_MS || 5000) * TS,
  POST_FOUND: (+process.env.POST_FOUND || 6500) * TS, POST_MISS: (+process.env.POST_MISS || 2600) * TS, START_MS: (+process.env.START_MS || 7000) * TS, ROOM_IDLE_MS: 30 * 60 * 1000
};
const LIMITS = { rooms: 300, conns: 3000, msgBytes: 2048, rate: 25 };
const ENVS = ['dawn', 'deep', 'waterfall', 'ruins', 'night', 'storm'];
const BOT_NAMES = ['Zara', 'Kofi', 'Mina', 'Leo', 'Tomas', 'Ife', 'Yuki', 'Sol', 'Nia'];
const BOT_MEMORY = { easy: .25, medium: .65, hard: 1, expert: 1 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = n => crypto.randomBytes(n).toString('hex');
const clean = (s, d) => (String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14)) || d;
const rooms = new Map(), tokens = new Map(); let connCount = 0;

/* ---------- http (static client + health) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, conns: connCount })); }
  let f = path.join(__dirname, 'public', u === '/' ? 'index.html' : path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': u === '/' ? 'no-cache' : 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(buf);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.msgBytes, verifyClient: ({ origin }) => !ALLOWED.length || !origin || ALLOWED.includes(origin) });

/* ---------- rooms ---------- */
function newCode() { for (let i = 0; i < 50; i++) { const c = 'JTH-' + (1000 + secureRng.int(9000)); if (!rooms.has(c)) return c; } return null; }
function pubPlayers(room) { return room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color, bot: !!p.bot, level: p.level || null, online: p.bot ? true : !!p.ws, choice: p.bot ? null : (p.choice || null) })); }
function agreement(room) { const humans = room.players.filter(p => !p.bot); const chosen = humans.map(p => p.choice); const all = humans.length > 0 && chosen.every(Boolean); const same = all && chosen.every(c => c === chosen[0]); return { ok: same, format: same ? chosen[0] : null, waiting: humans.filter(p => !p.choice).map(p => p.id), mismatch: all && !same }; }
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg) { const s = JSON.stringify(msg); room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(s); }); }
function roomState(room) { return { t: 'room', code: room.code, host: room.host, status: room.status, players: pubPlayers(room), settings: room.settings, max: CONFIG.MAX_PLAYERS, agree: agreement(room), format: room.series ? room.series.format : null }; }
function nextColor(room) { const used = new Set(room.players.map(p => p.color)); for (let i = 0; i < 10; i++) if (!used.has(i)) return i; return 0; }
function touch(room) { room.last = Date.now(); }

function gameSnapshot(room) {
  const e = room.eng; if (!e) return null;
  return { t: 'sync', state: e.snapshot(), phase: room.phase, current: e.status === 'ACTIVE' ? e.currentPlayer.id : null, deadlineIn: Math.max(0, room.deadline - Date.now()), selected: room.selPreview, pending: room.pending ? { playerId: room.pending.playerId, route: room.pending.route, durMs: room.pending.durMs, elapsed: Date.now() - room.pending.t0 } : null, settings: room.settings, mapSeed: room.mapSeed, env: room.env, series: room.series ? room.series.publicState() : null, final: room.final || null, trophy: room.trophy ? { revealed: room.trophy.revealed, unlocked: trophyUnlocked(room), winners: room.trophy.winners, reveal: room.trophy.payload || null } : null, vote: room.series && room.series.votes ? { ids: room.series.votes.ids, cast: Object.keys(room.series.votes.cast) } : null, log: e.log.map(l => ({ trial: l.trial, attempt: l.attempt, playerId: l.playerId, route: l.route, found: l.found, points: l.points })) };
}

/* ---------- game loop (one async loop per room) ---------- */
async function runExpedition(room) {
  const settings = room.settings;
  room.expNo = (room.expNo || 0) + 1; room.mapSeed = secureRng.int(0x7fffffff);
  room.env = settings.mode === 'night' ? 'night' : (settings.env && settings.env !== 'auto') ? settings.env : ENVS[secureRng.int(ENVS.length)];
  room.eng = new Expedition({ players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color, isAI: !!p.bot, ai: p.level })), routeCount: settings.routes, rng: secureRng });
  room.pending = null; room.selPreview = null;
  const e = room.eng;
  room.phase = 'start'; broadcast(room, { t: 'game_start', players: pubPlayers(room), routeCount: e.routeCount, env: room.env, mapSeed: room.mapSeed, maxTrials: e.maxTrials, mode: room.settings.mode, startsIn: T.START_MS, expedition: room.expNo, format: room.series.format, maxExp: room.series.maxExp });
  await sleep(T.START_MS);
  while (e.status === 'ACTIVE' && room.alive) {
    const p = e.currentPlayer, rp = room.players.find(x => x.id === p.id);
    room.phase = 'turn'; room.selPreview = null; room.act = null;
    const turnMs = room.settings.mode === 'speed' ? 20000 * TS : T.TURN_MS;
    room.deadline = Date.now() + turnMs + T.BANNER_MS; // + banner / clue animation time on clients
    broadcast(room, { t: 'turn', playerId: p.id, trial: e.trial, attempt: e.attempt, turnIndex: e.turnIndex, clue: e.clue, deadlineIn: turnMs + T.BANNER_MS, final: e.isFinal, searched: e.searched });
    // wait for the active player (human intent, bot decision, timeout, or disconnect-grace auto-play)
    const action = await new Promise(resolve => {
      room.resolveTurn = resolve; const started = Date.now();
      let timer;
      const decideAuto = (reason) => { const open = [...Array(e.routeCount).keys()].filter(i => !e.searched.includes(i)); const pool = open.length ? open : [...Array(e.routeCount).keys()]; resolve({ route: pool[secureRng.int(pool.length)], reason }); };
      if (rp.bot) { const m = BOT_MEMORY[rp.level] ?? .5; const known = new Set(e.searched); let pool = []; for (let i = 0; i < e.routeCount; i++) { if (known.has(i) && Math.random() < m) continue; pool.push(i); } if (!pool.length) pool = [...Array(e.routeCount).keys()]; const route = pool[secureRng.int(pool.length)]; const base = { easy: 1800, medium: 1500, hard: 1200, expert: 900 }[rp.level] || 1400; timer = setTimeout(() => { e.select(p.id, route); room.selPreview = route; broadcast(room, { t: 'selected', playerId: p.id, route }); setTimeout(() => resolve({ route, reason: 'bot' }), T.BOT_PICK); }, T.BOT_BASE + (base + Math.random() * 600) * TS); }
      else {
        const tick = () => { if (!room.alive) return resolve(null); const now = Date.now(); if (now - started >= turnMs) return decideAuto('timeout'); if (!rp.ws && now - (rp.offlineAt || now) >= T.GRACE_MS && now - started > T.BANNER_MS) return decideAuto('offline'); timer = setTimeout(tick, 250); };
        timer = setTimeout(tick, 250);
      }
      room.cancelTurn = () => clearTimeout(timer);
    });
    if (room.cancelTurn) room.cancelTurn(); if (!action || !room.alive) break;
    e.select(p.id, action.route); room.selPreview = action.route;
    const dur = room.settings.mode === 'speed' ? T.TRACK_MS_FAST : T.TRACK_MS;
    const res = e.track(p.id, `${e.id}:${e.attempt}`);
    if (!res.ok) { console.warn('track rejected', res.error); continue; }
    room.pending = { playerId: p.id, route: res.route, durMs: dur, t0: Date.now() }; room.phase = 'tracking';
    broadcast(room, { t: 'attempt_start', playerId: p.id, route: res.route, durMs: dur, trial: res.trial, attempt: res.attempt });
    await sleep(dur + T.SUSPENSE_MS);              // outcome stays hidden until the tracker has arrived
    room.phase = 'result'; room.pending = null;
    broadcast(room, { t: 'attempt_result', playerId: p.id, route: res.route, found: res.found, points: res.points, treasure: res.treasure, trial: res.trial, attempt: res.attempt, finished: res.finished, newTrial: res.newTrial, finalTrialStarted: res.finalTrialStarted, searched: e.searched, scores: e.players.map(x => ({ id: x.id, score: x.score, discoveries: x.discoveries, attempts: x.attempts })) });
    if (res.finished) break;
    await sleep(res.found ? T.POST_FOUND : T.POST_MISS);
  }
  if (room.alive && e.status === 'COMPLETE') {
    room.phase = 'between'; const st = e.standings(), S = room.series, entry = S.record(st);
    broadcast(room, { t: 'game_over', expedition: room.expNo, standings: st.rows.map(r => ({ id: r.id, name: r.name, avatar: r.avatar, color: r.color, bot: r.isAI, score: r.score, discoveries: r.discoveries, attempts: r.attempts, rank: r.rank })), winners: st.winners.map(w => w.id), expWinners: entry ? entry.winners : [], series: S.publicState(), log: e.log.map(l => ({ trial: l.trial, attempt: l.attempt, playerId: l.playerId, route: l.route, found: l.found, points: l.points })) });
  }
}
const humanIds = room => room.players.filter(p => !p.bot).map(p => p.id);
const onlineHumanIds = room => room.players.filter(p => !p.bot && p.ws).map(p => p.id);
function waitFor(room, ms, key) { return new Promise(res => { const tm = setTimeout(() => { room[key] = null; res('timeout'); }, ms); room[key] = (why) => { clearTimeout(tm); room[key] = null; res(why || 'done'); }; }); }

/* One series = up to ten expeditions. Everything below is decided here, never on a device. */
async function runSeries(room) {
  const S = room.series;
  while (room.alive && !S.ended) {
    await runExpedition(room); if (!room.alive) return;
    if (S.ended) break;
    await sleep(T.RESULT_VIEW_MS); if (!room.alive) return;           // let everyone read the normal expedition result first
    if (S.full) {
      room.phase = 'next'; room.nextReady = new Set();
      broadcast(room, { t: 'next_prompt', expedition: room.expNo, of: S.maxExp, deadlineIn: T.NEXT_MS });
      await waitFor(room, T.NEXT_MS, 'resolveNext');
    } else {
      room.phase = 'vote'; S.openVote(humanIds(room));
      broadcast(room, { t: 'vote_open', expedition: room.expNo, of: S.maxExp, humans: S.votes.ids, deadlineIn: T.VOTE_MS });
      await waitFor(room, T.VOTE_MS, 'resolveVote');
      const res = S.closeVote(); broadcast(room, { t: 'vote_result', expedition: room.expNo, end: res.end, endVotes: res.endVotes, total: res.total });
      await sleep(Math.min(2500 * TS, T.RESULT_VIEW_MS));
    }
  }
  if (!room.alive) return;
  if (S.endedBy === 'complete') await sleep(Math.max(0, T.FINAL_DELAY_MS - T.RESULT_VIEW_MS));
  const fin = S.finalize(); room.final = fin; room.phase = 'final'; room.status = 'done';
  room.trophy = fin.trophy ? { winners: fin.winners, revealed: false, unlockAt: Date.now() + T.REVEAL_UNLOCK_MS, payload: null } : null;
  broadcast(room, { t: 'final', final: fin, trophy: room.trophy ? { eligible: true, winners: room.trophy.winners, unlockIn: T.REVEAL_UNLOCK_MS, aiOnly: fin.winners.every(id => (room.players.find(p => p.id === id) || {}).bot) } : { eligible: false } });
  broadcast(room, roomState(room));
  if (room.trophy) trophyWatch(room);
}
const trophyUnlocked = room => !!(room.trophy && !room.trophy.revealed && (Date.now() >= room.trophy.unlockAt || room.trophy.winners.every(id => { const p = room.players.find(x => x.id === id); return p && !p.bot && !p.ws; })));
function trophyWatch(room) {
  const tr = room.trophy, winners = tr.winners.map(id => room.players.find(p => p.id === id)).filter(Boolean);
  if (winners.every(p => p.bot)) { setTimeout(() => doReveal(room, 'auto'), T.AI_REVEAL_MS); return; }   // AI-only winners: no button, automatic reveal
  let announced = false; const iv = setInterval(() => { if (!room.alive || !room.trophy || room.trophy.revealed) return clearInterval(iv); if (!announced && trophyUnlocked(room)) { announced = true; broadcast(room, { t: 'reveal_unlocked' }); } }, Math.max(50, 500 * TS)); iv.unref && iv.unref();
}
function doReveal(room, by) {
  if (!room.alive || !room.trophy || !room.series.revealTrophy(by)) return false;            // counts once, however many presses arrive
  room.trophy.revealed = true; const f = room.final;
  room.trophy.payload = { winners: f.ranking.filter(r => r.isWinner).map(r => ({ id: r.id, name: r.name, wins: r.wins, isAI: r.isAI })), by, startIn: 700 };
  broadcast(room, Object.assign({ t: 'trophy_reveal' }, room.trophy.payload)); return true;
}
function startGame(room) {
  const ag = agreement(room); room.series = new Series({ maxExp: +process.env.MAX_EXP || 10, format: ag.format, players: room.players.map(p => ({ id: p.id, name: p.name, isAI: !!p.bot })) });
  room.final = null; room.trophy = null; room.expNo = 0; room.status = 'playing'; room.alive = true;
  broadcast(room, roomState(room)); runSeries(room).catch(err => console.error('series error', err));
}

/* ---------- connections ---------- */
wss.on('connection', (ws, req) => {
  if (connCount >= LIMITS.conns) { ws.close(1013); return; }
  connCount++; ws.isAlive = true; ws.rate = { n: 0, t: Date.now() }; ws.ctx = { token: null, code: null, id: null };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { connCount--; detach(ws); });
  ws.on('error', () => { });
  ws.on('message', raw => {
    const now = Date.now(); if (now - ws.rate.t > 1000) { ws.rate = { n: 0, t: now }; } if (++ws.rate.n > LIMITS.rate) return send(ws, { t: 'error', code: 'RATE_LIMIT' });
    let m; try { m = JSON.parse(raw); } catch (e) { return send(ws, { t: 'error', code: 'BAD_JSON' }); }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (err) { console.error('handler error', err); send(ws, { t: 'error', code: 'SERVER_ERROR' }); }
  });
});
function detach(ws) {
  const room = rooms.get(ws.ctx.code); if (!room) return; const p = room.players.find(x => x.id === ws.ctx.id); if (!p || p.ws !== ws) return;
  p.ws = null; p.offlineAt = Date.now();
  if (room.status === 'lobby') { room.players = room.players.filter(x => x !== p); tokens.delete(p.token); if (room.host === p.id) { const h = room.players.find(x => !x.bot); room.host = h ? h.id : null; } if (!room.players.some(x => !x.bot)) { closeRoom(room); return; } broadcast(room, roomState(room)); }
  else broadcast(room, roomState(room));
}
function closeRoom(room) { room.alive = false; room.cancelTurn && room.cancelTurn(); room.resolveTurn && room.resolveTurn(null); rooms.delete(room.code); room.players.forEach(p => tokens.delete(p.token)); }
function me(ws) { const room = rooms.get(ws.ctx.code); if (!room) return {}; return { room, p: room.players.find(x => x.id === ws.ctx.id) }; }

function handle(ws, m) {
  if (m.t === 'ping') return send(ws, { t: 'pong', ts: m.ts });
  if (m.t === 'hello') {
    const prof = { name: clean(m.name, 'Explorer'), avatar: (m.avatar | 0) & 7, color: Math.max(0, Math.min(9, m.color | 0)) };
    const rec = m.token && tokens.get(String(m.token));
    if (rec) { const room = rooms.get(rec.code), p = room && room.players.find(x => x.id === rec.id); if (p) { if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { } } p.ws = ws; p.offlineAt = 0; ws.ctx = { token: p.token, code: room.code, id: p.id }; send(ws, { t: 'welcome', token: p.token, you: p.id, resumed: true }); send(ws, roomState(room)); if (room.eng) send(ws, gameSnapshot(room)); broadcast(room, roomState(room)); return; } }
    ws.ctx.profile = prof; return send(ws, { t: 'welcome', token: null, you: null });
  }
  const prof = ws.ctx.profile; if (!prof && !ws.ctx.code) return send(ws, { t: 'error', code: 'NO_HELLO' });
  if (m.t === 'create' || m.t === 'join') {
    if (ws.ctx.code) return send(ws, { t: 'error', code: 'ALREADY_IN_ROOM' });
    let room;
    if (m.t === 'create') { if (rooms.size >= LIMITS.rooms) return send(ws, { t: 'error', code: 'SERVER_FULL' }); const code = newCode(); if (!code) return send(ws, { t: 'error', code: 'SERVER_FULL' }); room = { code, host: null, status: 'lobby', players: [], settings: { routes: 24, env: 'auto', mode: 'classic' }, last: Date.now(), alive: false, phase: 'lobby', deadline: 0 }; rooms.set(code, room); }
    else { room = rooms.get(String(m.code || '').toUpperCase().trim()); if (!room) return send(ws, { t: 'error', code: 'NO_SUCH_ROOM' }); if (room.status !== 'lobby') return send(ws, { t: 'error', code: 'GAME_IN_PROGRESS' }); if (room.players.length >= CONFIG.MAX_PLAYERS) return send(ws, { t: 'error', code: 'ROOM_FULL' }); }
    const id = 'p' + (room.players.length ? Math.max(...room.players.map(x => +x.id.slice(1))) + 1 : 1), token = rid(16);
    let name = prof.name; while (room.players.some(x => x.name.toLowerCase() === name.toLowerCase())) name = name.slice(0, 12) + ' ' + (room.players.length + 1);
    const p = { id, name, avatar: prof.avatar, color: room.players.some(x => x.color === prof.color) ? nextColor(room) : prof.color, ws, token, bot: false, choice: null };
    room.players.push(p); if (!room.host) room.host = id; tokens.set(token, { code: room.code, id }); ws.ctx = { token, code: room.code, id, profile: prof }; touch(room);
    send(ws, { t: 'welcome', token, you: id }); return broadcast(room, roomState(room));
  }
  const { room, p } = me(ws); if (!room || !p) return send(ws, { t: 'error', code: 'NOT_IN_ROOM' }); touch(room);
  switch (m.t) {
    case 'leave': { if (room.status === 'lobby') { room.players = room.players.filter(x => x !== p); tokens.delete(p.token); ws.ctx = { token: null, code: null, id: null, profile: prof }; if (room.host === p.id) { const h = room.players.find(x => !x.bot); room.host = h ? h.id : null; } send(ws, { t: 'left' }); if (!room.players.some(x => !x.bot)) closeRoom(room); else broadcast(room, roomState(room)); } else { p.ws = null; p.offlineAt = Date.now(); tokens.delete(p.token); ws.ctx = { token: null, code: null, id: null, profile: prof }; send(ws, { t: 'left' }); broadcast(room, roomState(room)); } return; }
    case 'settings': { if (room.host !== p.id || room.status !== 'lobby') return send(ws, { t: 'error', code: 'NOT_HOST' }); const s = room.settings; if ([20, 24, 30].includes(m.routes)) s.routes = m.routes; if (m.env === 'auto' || ENVS.includes(m.env)) s.env = m.env; if (['classic', 'speed', 'night'].includes(m.mode)) s.mode = m.mode; return broadcast(room, roomState(room)); }
    case 'addbot': { if (room.host !== p.id || room.status !== 'lobby') return send(ws, { t: 'error', code: 'NOT_HOST' }); if (room.players.length >= CONFIG.MAX_PLAYERS) return send(ws, { t: 'error', code: 'ROOM_FULL' }); const level = ['easy', 'medium', 'hard', 'expert'].includes(m.level) ? m.level : 'medium'; const n = room.players.filter(x => x.bot).length; const id = 'p' + (Math.max(...room.players.map(x => +x.id.slice(1))) + 1); let name = BOT_NAMES[n % BOT_NAMES.length]; while (room.players.some(x => x.name === name)) name += '2'; room.players.push({ id, name, avatar: (n + 3) & 7, color: nextColor(room), ws: null, token: null, bot: true, level }); return broadcast(room, roomState(room)); }
    case 'rmbot': { if (room.host !== p.id || room.status !== 'lobby') return; const b = room.players.find(x => x.id === m.id && x.bot); if (b) room.players = room.players.filter(x => x !== b); return broadcast(room, roomState(room)); }
    case 'choose': { if (room.status !== 'lobby') return send(ws, { t: 'error', code: 'FORMAT_LOCKED' }); if (!['full', 'flexible'].includes(m.format)) return send(ws, { t: 'error', code: 'BAD_FORMAT' }); p.choice = m.format; return broadcast(room, roomState(room)); }
    case 'start': { if (room.host !== p.id) return send(ws, { t: 'error', code: 'NOT_HOST' }); if (room.status !== 'lobby') return; room.players = room.players.filter(x => x.bot || x.ws); if (room.players.length < CONFIG.MIN_PLAYERS) return send(ws, { t: 'error', code: 'NEED_MORE_PLAYERS' }); const ag = agreement(room); if (!ag.ok) return send(ws, { t: 'error', code: ag.mismatch ? 'FORMAT_MISMATCH' : 'FORMAT_PENDING' }); return startGame(room); }
    case 'next': { if (room.phase !== 'next' || !room.nextReady) return; room.nextReady.add(p.id); broadcast(room, { t: 'next_ready', id: p.id }); if (room.host === p.id || onlineHumanIds(room).every(i => room.nextReady.has(i))) room.resolveNext && room.resolveNext('ready'); return; }
    case 'vote': { const S = room.series; if (room.phase !== 'vote' || !S || !S.castVote(p.id, m.choice)) return send(ws, { t: 'error', code: 'NO_VOTE' }); broadcast(room, { t: 'vote_cast', id: p.id }); if (S.voteComplete(onlineHumanIds(room))) room.resolveVote && room.resolveVote('all'); return; }
    case 'reveal': { if (room.phase !== 'final' || !room.trophy || room.trophy.revealed) return; const isWinner = room.trophy.winners.includes(p.id); if (!isWinner && !trophyUnlocked(room)) return send(ws, { t: 'error', code: 'ONLY_WINNER' }); doReveal(room, p.id); return; }
    case 'newgame': case 'rematch': { if (room.host !== p.id || room.status !== 'done') return; room.eng = null; room.series = null; room.final = null; room.trophy = null; room.status = 'lobby'; room.phase = 'lobby'; room.players = room.players.filter(x => x.bot || x.ws); room.players.forEach(x => { x.choice = null; }); return broadcast(room, roomState(room)); }
    case 'select': { if (room.status !== 'playing' || room.phase !== 'turn' || room.eng.currentPlayer.id !== p.id) return send(ws, { t: 'error', code: 'NOT_YOUR_TURN' }); const r = room.eng.select(p.id, m.route | 0); if (!r.ok) return send(ws, { t: 'error', code: r.error }); room.selPreview = r.route; return broadcast(room, { t: 'selected', playerId: p.id, route: r.route }); }
    case 'track': { if (room.status !== 'playing' || room.phase !== 'turn' || room.eng.currentPlayer.id !== p.id) return send(ws, { t: 'error', code: 'NOT_YOUR_TURN' }); if (room.eng.selected < 0) return send(ws, { t: 'error', code: 'NO_ROUTE_SELECTED' }); room.phase = 'locking'; return room.resolveTurn && room.resolveTurn({ route: room.eng.selected, reason: 'human' }); }
    case 'sync': return send(ws, roomState(room)), room.eng && send(ws, gameSnapshot(room));
    default: return send(ws, { t: 'error', code: 'UNKNOWN' });
  }
}

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }); const now = Date.now(); rooms.forEach(r => { if (now - r.last > T.ROOM_IDLE_MS || !r.players.some(p => p.bot || p.ws) && now - r.last > 5 * 60 * 1000) closeRoom(r); }); }, 15000).unref();
if (require.main === module) server.listen(PORT, () => console.log(`Jungle Treasure Hunt server on :${PORT}`));
module.exports = { server, wss, rooms, T };
