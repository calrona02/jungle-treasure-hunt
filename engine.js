'use strict';
/* =====================================================================
   JUNGLE TREASURE HUNT — rules engine (UI-independent, "server-shaped")
   The engine owns every secret (treasure route, RNG) in private fields.
   Clients may only call select() / track() and read snapshots, exactly
   as they would over a socket to an authoritative server.
   ===================================================================== */
const CONFIG = Object.freeze({
  MAX_TRIALS: 5,                // trials per expedition; routes = players x trials
  DAILY_TRIALS: 10,             // the solo daily challenge keeps 10 attempts (10 routes)               // a trial = one full cycle in which EVERY player gets one attempt
  MAX_TREASURE_DISCOVERIES: 3,  // 2 discoverable in trials 1-9, the 3rd reserved for the final trial
  POINTS_PER_DISCOVERY: 5,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 10,
  ROUTE_COUNT: 24,
  ROUTE_COUNT_RANGE: [20, 30],
  END_WHEN_TREASURES_EXHAUSTED: false, // spec: play all 10 trials even after the last discovery
  XP: Object.freeze({ TREASURE: 50, COMPLETE: 20, WIN: 100, DAILY: 100 }),
  TRACK_MS: 1700,
  TRACK_MS_FAST: 1050,
  SPEED_TURN_SECONDS: 20,
  DAILY_GOAL: 4,
  // More treasures than the original three, so expeditions are decided by skill and luck instead of ending level.
  // total = players + BASE, at least MIN, at most MAX_SHARE of the routes. Half are live from trial 1, the rest appear
  // one by one through trials 2-9, and FINAL (1-2) stay locked until the final trial.
  TREASURE_PLAN: Object.freeze({ BASE: 5, MIN: 6, MAX_SHARE: .5 }),
  ROUTES_PER_PLAYER_TRIAL: 1,   // number of routes = players x trials (every attempt uses its own number)
  VIEW_KEEP_EXTRA: 2,           // a played route stays on screen for (players + this) attempts before it may be swapped out
  CLUE: Object.freeze({ AFTER_DISCOVERIES: 1, CHANCE: .4, HONEST: .7, BIRD_SET: 8, PRINT_SET: 3, BIRD_SHARE: .6 }),
  SPONSORS: [] // { campaignId, brandName, treasureImage, startDate, endDate, mapId, reward }
});

/** minTrial for every treasure of an expedition. Pure function of (players, routes, trials): same on server and device. */
function treasurePlan(players, routes, maxTrials, plan) {
  plan = plan || CONFIG.TREASURE_PLAN;
  const total = Math.max(2, Math.min(Math.floor(routes * plan.MAX_SHARE), Math.max(plan.MIN, players + plan.BASE)));
  const finalN = total >= 12 ? 2 : 1, early = total - finalN, live0 = Math.ceil(early / 2), rest = early - live0, sched = [];
  for (let i = 0; i < live0; i++) sched.push(1);
  for (let j = 0; j < rest; j++) sched.push(2 + Math.floor(j * (maxTrials - 2) / Math.max(1, rest)));
  for (let i = 0; i < finalN; i++) sched.push(maxTrials);
  return sched;
}
const TREASURES = Object.freeze([
  { id: 'crystal',  emoji: '💎', name: 'Crystal' },
  { id: 'coins',    emoji: '🪙', name: 'Ancient Coins' },
  { id: 'crown',    emoji: '👑', name: 'Lost Crown' },
  { id: 'artifact', emoji: '🏺', name: 'Ancient Artifact' },
  { id: 'jewel',    emoji: '💍', name: 'Jewel' },
  { id: 'map',      emoji: '📜', name: 'Ancient Map' },
  { id: 'relic',    emoji: '🗿', name: 'Stone Relic' },
  { id: 'mystery',  emoji: '🔮', name: 'Mystery Orb' }
]);

/* ---------- randomness ---------- */
const secureRng = {
  int(n) {
    if (n <= 1) return 0;
    const g = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (!g) return Math.floor(Math.random() * n);
    const lim = Math.floor(0x100000000 / n) * n; // rejection sampling: no modulo bias
    const a = new Uint32Array(1);
    let x;
    do { g.getRandomValues(a); x = a[0]; } while (x >= lim);
    return x % n;
  }
};
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededRng(seedStr) {
  const f = mulberry32(hashSeed(seedStr));
  return { int: n => (n <= 1 ? 0 : Math.floor(f() * n)), float: f };
}

/* ---------- the expedition ---------- */
/** Silent route display. Every route keeps its true state in the game; this only decides which routes occupy the
 *  on-screen SLOTS. A slot (a fixed trail position) never moves: a swap just changes the number shown in it.
 *  Decided in ONE place (server / the local engine) and sent to every device. */
class RouteView {
  constructor({ routeCount, capacity, rng, players }) {
    this.N = routeCount; this.P = players || 2; this.C = Math.max(1, Math.min(capacity || routeCount, routeCount)); this.rng = rng; this.keep = Math.max(3, Math.min(this.P, 6));   // a played route stays on screen for a few turns before it may be swapped out
    const ids = [...Array(routeCount).keys()]; for (let i = ids.length - 1; i > 0; i--) { const j = rng.int(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    this.slots = ids.slice(0, this.C); this.shown = new Set(this.slots); this.playedAt = new Map();
  }
  get complete() { return this.N <= this.C; }
  visible() { return new Set(this.slots); }
  /** Called after each attempt. Returns the swaps made (0-2). Never touches a route played in the last few attempts. */
  update(route, attempt, played) {
    this.playedAt.set(route, attempt);
    if (this.complete) return [];
    const vis = this.visible(), hiddenActive = []; for (let r = 0; r < this.N; r++) if (!vis.has(r) && !played.has(r)) hiddenActive.push(r);
    if (!hiddenActive.length) return [];                                   // every active route is already on screen: stop swapping
    const unseen = hiddenActive.filter(r => !this.shown.has(r)), remaining = Math.max(1, this.N - attempt);
    const visibleActive = this.slots.filter(r => !played.has(r)).length;
    const slack = Math.max(1, (this.N - this.P) - attempt), finalTrial = attempt >= this.N - this.P;   // by the final trial every route that can still be chosen must be on screen
    let want = finalTrial ? hiddenActive.length : Math.min(2, Math.max(1, Math.ceil(hiddenActive.length / slack)));
    const old = this.slots.map((r, s) => ({ r, s })).filter(x => played.has(x.r)).sort((a, b) => (this.playedAt.get(a.r) || 0) - (this.playedAt.get(b.r) || 0));
    const eligible = finalTrial ? old : old.filter(x => attempt - (this.playedAt.get(x.r) || 0) >= this.keep);
    let slotsToUse = eligible.slice(0, want);
    if (!slotsToUse.length && visibleActive === 0 && old.length) slotsToUse = [old[0]];   // never leave a turn without a pickable route
    const swaps = [], pool = unseen.length ? unseen.slice() : hiddenActive.slice();
    for (const x of slotsToUse) {
      if (!pool.length) break; const i = this.rng.int(pool.length), to = pool.splice(i, 1)[0];
      swaps.push({ slot: x.s, from: x.r, to }); this.slots[x.s] = to; this.shown.add(to);
    }
    return swaps;
  }
}

class Expedition {
  #treasures = [];   // secret: [{ route, minTrial, found }]
  #rng;
  #selected = -1;
  #seenRequests = new Set();
  #played = new Set();
  #cfg;

  constructor({ players, routeCount, capacity, rng = secureRng, cfg = CONFIG, id = null }) {
    this.#cfg = cfg;
    this.#rng = rng;
    if (!Array.isArray(players) || players.length < 1 || players.length > cfg.MAX_PLAYERS) throw new Error('BAD_PLAYER_COUNT');
    if (routeCount == null) routeCount = players.length * cfg.MAX_TRIALS;   // routes = players x trials: every attempt uses its own number
    if (routeCount < 2) throw new Error('BAD_ROUTE_COUNT');
    this.id = id || ('G' + Date.now().toString(36) + rng.int(1679616).toString(36));
    this.routeCount = routeCount;
    this.players = players.map((p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar || 0, color: p.color || 0, isAI: !!p.isAI, ai: p.ai || null,
      score: 0, attempts: 0, discoveries: 0, lastFind: 0, order: i
    }));
    this.trial = 1;          // current trial (round) 1..MAX_TRIALS
    this.turnIndex = 0;      // fixed order: player 1 -> player N, every trial
    this.attempt = 0;        // attempts made so far (max players x MAX_TRIALS)
    this.status = 'ACTIVE';
    this.log = [];
    this.searched = [];      // public: routes already played (inactive, marked X, cannot be chosen again)
    this.clue = null;        // public, same for every player; honest-or-false is secret
    this.view = new RouteView({ routeCount, capacity, rng, players: players.length });
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    // Treasures sit on distinct routes. Some are live from trial 1, others unlock in later trials, the last ones only in the
    // final trial (the engine refuses to award a treasure before its minTrial).
    const sched = treasurePlan(this.players.length, routeCount, cfg.MAX_TRIALS, cfg.TREASURE_PLAN), spots = this.#distinct(sched.length);
    this.#treasures = sched.map((mt, i) => ({ route: spots[i], minTrial: mt, found: false }));
  }

  #distinct(n) {
    const out = [];
    while (out.length < n) { const r = this.#rng.int(this.routeCount); if (!out.includes(r)) out.push(r); }
    return out;
  }

  /** Clue event for the turn that is about to start. Never emitted before the first discovery, never when
   *  nothing is left to find, and never about a treasure that is still gated. Honest and false clues have identical
   *  shape, so players must judge them. A false trail only ever covers routes with no unfound treasure. */
  #makeClue() {
    const C = this.#cfg.CLUE; if (!C) return null;
    const found = this.#treasures.filter(x => x.found).length; if (found < C.AFTER_DISCOVERIES) return null;
    const pickable = new Set(this.view.slots.filter(r => !this.#played.has(r)));                 // clues only ever point at routes a player can still choose
    const live = this.#treasures.filter(x => !x.found && !this.#played.has(x.route)); if (!live.length) return null;
    const eligible = live.filter(x => this.trial >= x.minTrial && pickable.has(x.route)); if (!eligible.length) return null;
    if (this.#rng.int(1000) >= C.CHANCE * 1000) return null;
    const bird = this.#rng.int(1000) < C.BIRD_SHARE * 1000, size = bird ? C.BIRD_SET : C.PRINT_SET, honest = this.#rng.int(1000) < C.HONEST * 1000;
    const liveRoutes = new Set(live.map(x => x.route)), free = [...pickable].filter(r => !liveRoutes.has(r)), set = [];
    if (honest) set.push(eligible[this.#rng.int(eligible.length)].route);
    while (set.length < size && free.length) { const i = this.#rng.int(free.length); set.push(free.splice(i, 1)[0]); }
    if (!set.length) return null;
    for (let i = set.length - 1; i > 0; i--) { const j = this.#rng.int(i + 1); [set[i], set[j]] = [set[j], set[i]]; }
    this._lastClueHonest = this.#cfg.DEBUG_PEEK ? honest : undefined;
    return { id: this.attempt + 1, kind: bird ? 'bird' : 'prints', routes: set };
  }
  _debug() { if (!this.#cfg.DEBUG_PEEK) throw new Error('nope'); return { treasures: this.#treasures.map(x => ({ ...x })), honest: this._lastClueHonest }; }

  get currentPlayer() { return this.players[this.turnIndex]; }
  get slots() { return this.view.slots.slice(); }
  /** Routes a player can pick right now (visible and not yet played). */
  pickable() { return this.view.slots.filter(r => !this.#played.has(r)); }
  get selected() { return this.#selected; }
  get maxTrials() { return this.#cfg.MAX_TRIALS; }
  get totalAttempts() { return this.players.length * this.#cfg.MAX_TRIALS; }
  get isFinal() { return this.status === 'ACTIVE' && this.trial === this.#cfg.MAX_TRIALS; }

  select(playerId, route) {
    if (this.status !== 'ACTIVE') return { ok: false, error: 'NOT_ACTIVE' };
    if (this.currentPlayer.id !== playerId) return { ok: false, error: 'NOT_YOUR_TURN' };
    if (!Number.isInteger(route) || route < 0 || route >= this.routeCount) return { ok: false, error: 'INVALID_ROUTE' };
    if (this.#played.has(route)) return { ok: false, error: 'ROUTE_PLAYED' };       // every number can be used once
    if (!this.view.slots.includes(route)) return { ok: false, error: 'ROUTE_HIDDEN' };
    this.#selected = route;
    return { ok: true, route };
  }

  /** Executes the attempt. Secrets are never returned — only this attempt's outcome. */
  track(playerId, requestId) {
    if (this.status !== 'ACTIVE') return { ok: false, error: 'NOT_ACTIVE' };
    if (requestId != null && this.#seenRequests.has(requestId)) return { ok: false, error: 'DUPLICATE_REQUEST' };
    const p = this.currentPlayer;
    if (p.id !== playerId) return { ok: false, error: 'NOT_YOUR_TURN' };
    if (this.#selected < 0) return { ok: false, error: 'NO_ROUTE_SELECTED' };
    if (requestId != null) this.#seenRequests.add(requestId);

    const route = this.#selected, trial = this.trial;
    // A treasure is awardable only if it is unclaimed, on this route, and its gate (minTrial) has opened.
    const t = this.#treasures.find(x => !x.found && x.route === route && trial >= x.minTrial);
    const found = !!t;
    let points = 0, treasure = null;
    if (found) {
      t.found = true;                       // permanently removed from this game
      points = this.#cfg.POINTS_PER_DISCOVERY;
      p.score += points; p.discoveries += 1; p.lastFind = this.attempt + 1;
      treasure = TREASURES[this.#rng.int(TREASURES.length)];
    }
    this.#played.add(route); this.searched.push(route);

    p.attempts += 1; this.attempt += 1;
    this.log.push({ eventId: this.log.length + 1, gameId: this.id, trial, attempt: this.attempt, playerId, route, found, points, ts: Date.now() });
    this.#selected = -1;
    this.updatedAt = Date.now();

    let newTrial = false, finalTrialStarted = false;
    this.turnIndex += 1;
    if (this.turnIndex >= this.players.length) {
      this.turnIndex = 0; this.trial += 1; newTrial = true;
      if (this.trial === this.#cfg.MAX_TRIALS) finalTrialStarted = true;

    }
    const allFound = this.#treasures.every(x => x.found);
    let finished = false;
    if (this.trial > this.#cfg.MAX_TRIALS || (this.#cfg.END_WHEN_TREASURES_EXHAUSTED && allFound)) { this.status = 'COMPLETE'; finished = true; }

    const swaps = finished ? [] : this.view.update(route, this.attempt, this.#played);       // the display changes here, between turns, never during a selection
    this.clue = finished ? null : this.#makeClue();
    return {
      ok: true, requestId, trial, attempt: this.attempt, playerId, route, found, points, treasure,
      finished, newTrial, finalTrialStarted, nextPlayerId: finished ? null : this.currentPlayer.id, clue: this.clue, slots: this.slots, swaps
    };
  }

  /** Standings. Tie-break chain: score -> discoveries -> success rate -> fewest attempts -> who reached the score FIRST
   *  (earlier last discovery) -> joint. Two players can never reach a score on the same attempt, so a tie that survives
   *  to the last step only happens when nobody found anything. */
  standings() {
    const rows = this.players.map(p => ({ ...p, rate: p.attempts ? p.discoveries / p.attempts : 0, reached: p.discoveries ? p.lastFind : Infinity }));
    rows.sort((a, b) => b.score - a.score || b.discoveries - a.discoveries || b.rate - a.rate || a.attempts - b.attempts || a.reached - b.reached || a.order - b.order);
    const base = (a, b) => a.score === b.score && a.discoveries === b.discoveries && a.rate === b.rate && a.attempts === b.attempts;
    const same = (a, b) => base(a, b) && a.reached === b.reached;
    rows.forEach((r, i) => { r.rank = (i > 0 && same(rows[i - 1], r)) ? rows[i - 1].rank : i + 1; });
    const winners = rows.filter(r => r.rank === 1), byFirst = rows.length > 1 && winners.length === 1 && base(rows[0], rows[1]) && rows[0].score > 0;
    return { rows, winners, decidedBy: byFirst ? 'first' : null, note: byFirst ? `Level on ${rows[0].score} points. ${rows[0].name} got there first.` : '' };
  }

  /** Safe, client-visible state: contains no secret fields and no treasure counters. */
  snapshot() {
    return JSON.parse(JSON.stringify({
      gameId: this.id, trial: this.trial, maxTrials: this.#cfg.MAX_TRIALS, attempt: this.attempt, totalAttempts: this.totalAttempts,
      status: this.status, currentPlayer: this.currentPlayer.id, turnIndex: this.turnIndex, routeCount: this.routeCount, slots: this.slots,
      players: this.players, searched: this.searched, clue: this.clue, createdAt: this.createdAt, updatedAt: this.updatedAt
    }));
  }
}


/* =====================================================================
   SERIES — a game of up to ten expeditions. Shared by the server (online)
   and the device (local), so the overall winner is decided in ONE place.
   Overall winner = most expedition wins; tie → higher total score; else joint.
   ===================================================================== */
class Series {
  constructor({ format = 'full', players, maxExp = 10 }) {
    if (!['full', 'flexible'].includes(format)) throw new Error('BAD_FORMAT');
    this.format = format; this.maxExp = maxExp;
    this.players = players.map((p, i) => ({ id: p.id, name: p.name, isAI: !!p.isAI, order: i }));
    this.wins = {}; this.totals = {}; this.history = []; this.ended = false; this.endedBy = null; this.votes = null; this.trophy = { revealed: false, by: null };
    this.players.forEach(p => { this.wins[p.id] = 0; this.totals[p.id] = 0; });
  }
  get full() { return this.format === 'full'; }
  get expPlayed() { return this.history.length; }
  /** standings = Expedition.standings(). An expedition with no treasure found has no winner. Tied winners each get a win. */
  record(st) {
    if (this.ended || this.history.length >= this.maxExp) return null;
    st.rows.forEach(r => { this.totals[r.id] = (this.totals[r.id] || 0) + r.score; });
    const winners = st.winners.length && st.winners[0].score > 0 ? st.winners.map(w => w.id) : [];
    winners.forEach(id => { this.wins[id] += 1; });
    const entry = { exp: this.history.length + 1, winners, scores: Object.fromEntries(st.rows.map(r => [r.id, r.score])) };
    this.history.push(entry);
    if (this.history.length >= this.maxExp) { this.ended = true; this.endedBy = 'complete'; }
    return entry;
  }
  get needsVote() { return !this.full && !this.ended; }
  openVote(humanIds) { this.votes = { ids: [...humanIds], cast: {} }; }
  castVote(id, choice) { if (!this.votes || !this.votes.ids.includes(id) || !['continue', 'end'].includes(choice)) return false; this.votes.cast[id] = choice; return true; }
  voteComplete(onlineIds) { if (!this.votes) return false; const need = onlineIds ? this.votes.ids.filter(i => onlineIds.includes(i)) : this.votes.ids; return need.every(i => this.votes.cast[i]); }
  /** The game ends only if MORE than half of the human players vote to end. Missing votes count as "continue". */
  closeVote() {
    const v = this.votes; if (!v) return null; const n = v.ids.length, endVotes = Object.values(v.cast).filter(c => c === 'end').length, end = n > 0 && endVotes * 2 > n;
    this.votes = null; if (end) { this.ended = true; this.endedBy = 'vote'; } return { end, endVotes, total: n };
  }
  finalize() {
    const rows = this.players.map(p => ({ id: p.id, name: p.name, isAI: p.isAI, order: p.order, wins: this.wins[p.id], total: this.totals[p.id] }));
    rows.sort((a, b) => b.wins - a.wins || b.total - a.total || a.order - b.order);
    rows.forEach((r, i) => { r.rank = (i > 0 && rows[i - 1].wins === r.wins && rows[i - 1].total === r.total) ? rows[i - 1].rank : i + 1; });
    const none = rows.every(r => r.wins === 0 && r.total === 0), maxWins = rows[0].wins; let top = rows.filter(r => r.wins === maxWins), tie = 'none', note = '';
    if (!none && top.length > 1) {
      const best = Math.max(...top.map(r => r.total)), byScore = top.filter(r => r.total === best), s = maxWins === 1 ? '' : 's';
      if (byScore.length < top.length) { tie = 'score'; note = `Tied on ${maxWins} win${s}. Decided by total score.`; } else { tie = 'joint'; note = `Tied on ${maxWins} win${s} and ${best} points. Joint winners.`; }
      top = byScore;
    }
    const winners = none ? [] : top.map(r => r.id); rows.forEach(r => { r.isWinner = winners.includes(r.id); });
    const nameOf = id => (this.players.find(p => p.id === id) || {}).name || '?', completed = this.full && this.expPlayed === this.maxExp;
    return {
      format: this.format, maxExp: this.maxExp, expPlayed: this.expPlayed, endedBy: this.endedBy, completed,
      rule: 'The winner is the player who won the most expeditions.',
      line: this.full ? `Full Game: ${this.maxExp} expeditions` : `Game ended after expedition ${this.expPlayed} of ${this.maxExp}`,
      ranking: rows, winners, winnerNames: winners.map(nameOf), tie, note,
      table: this.history.map(h => ({ exp: h.exp, winners: h.winners, names: h.winners.map(nameOf) })),
      trophy: completed && winners.length > 0
    };
  }
  /** Idempotent: only the first call counts. */
  revealTrophy(by) { if (this.trophy.revealed) return false; this.trophy.revealed = true; this.trophy.by = by; return true; }
  publicState() { return { format: this.format, maxExp: this.maxExp, expPlayed: this.expPlayed, wins: { ...this.wins }, totals: { ...this.totals }, history: this.history.map(h => ({ ...h })), ended: this.ended, endedBy: this.endedBy }; }
}

if (typeof module !== 'undefined') module.exports = { CONFIG, TREASURES, treasurePlan, RouteView, Expedition, Series, secureRng, seededRng, mulberry32, hashSeed };
