'use strict';
/* =====================================================================
   JUNGLE TREASURE HUNT — rules engine (UI-independent, "server-shaped")
   The engine owns every secret (treasure route, RNG) in private fields.
   Clients may only call select() / track() and read snapshots, exactly
   as they would over a socket to an authoritative server.
   ===================================================================== */
const CONFIG = Object.freeze({
  MAX_TRIALS: 10,               // a trial = one full cycle in which EVERY player gets one attempt
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
  DAILY_GOAL: 1,
  CLUE: Object.freeze({ AFTER_DISCOVERIES: 1, CHANCE: .4, HONEST: .7, BIRD_SET: 8, PRINT_SET: 3, BIRD_SHARE: .6 }),
  SPONSORS: [] // { campaignId, brandName, treasureImage, startDate, endDate, mapId, reward }
});

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
class Expedition {
  #treasures = [];   // secret: [{ route, minTrial, found }]
  #rng;
  #selected = -1;
  #seenRequests = new Set();
  #knownEmpty = [];  // routes whose treasure was found (public knowledge: permanently empty)
  #cfg;

  constructor({ players, routeCount = CONFIG.ROUTE_COUNT, rng = secureRng, cfg = CONFIG, id = null }) {
    this.#cfg = cfg;
    this.#rng = rng;
    if (!Array.isArray(players) || players.length < 1 || players.length > cfg.MAX_PLAYERS) throw new Error('BAD_PLAYER_COUNT');
    if (routeCount < 3) throw new Error('BAD_ROUTE_COUNT');
    this.id = id || ('G' + Date.now().toString(36) + rng.int(1679616).toString(36));
    this.routeCount = routeCount;
    this.players = players.map((p, i) => ({
      id: p.id, name: p.name, avatar: p.avatar || 0, color: p.color || 0, isAI: !!p.isAI, ai: p.ai || null,
      score: 0, attempts: 0, discoveries: 0, order: i
    }));
    this.trial = 1;          // current trial (round) 1..MAX_TRIALS
    this.turnIndex = 0;      // fixed order: player 1 -> player N, every trial
    this.attempt = 0;        // attempts made so far (max players x MAX_TRIALS)
    this.status = 'ACTIVE';
    this.log = [];
    this.searched = [];      // public: routes currently known NOT to hold a treasure
    this.clue = null;        // public, same for every player; honest-or-false is secret
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    // Three treasures on three distinct routes. Two are live from trial 1. The third is
    // gated: the engine refuses to award it before the final trial.
    const routes = this.#distinct(3);
    this.#treasures = [
      { route: routes[0], minTrial: 1, found: false },
      { route: routes[1], minTrial: 1, found: false },
      { route: routes[2], minTrial: cfg.MAX_TRIALS, found: false }
    ];
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
    const live = this.#treasures.filter(x => !x.found); if (!live.length) return null;
    const eligible = live.filter(x => this.trial >= x.minTrial); if (!eligible.length) return null;
    if (this.#rng.int(1000) >= C.CHANCE * 1000) return null;
    const bird = this.#rng.int(1000) < C.BIRD_SHARE * 1000, size = bird ? C.BIRD_SET : C.PRINT_SET, honest = this.#rng.int(1000) < C.HONEST * 1000;
    const liveRoutes = new Set(live.map(x => x.route)); const set = [];
    if (honest) set.push(eligible[this.#rng.int(eligible.length)].route);
    let guard = 0; while (set.length < size && guard++ < 500) { const r = this.#rng.int(this.routeCount); if (set.includes(r) || liveRoutes.has(r)) continue; set.push(r); }
    for (let i = set.length - 1; i > 0; i--) { const j = this.#rng.int(i + 1); [set[i], set[j]] = [set[j], set[i]]; }
    this._lastClueHonest = this.#cfg.DEBUG_PEEK ? honest : undefined;
    return { id: this.attempt + 1, kind: bird ? 'bird' : 'prints', routes: set };
  }
  _debug() { if (!this.#cfg.DEBUG_PEEK) throw new Error('nope'); return { treasures: this.#treasures.map(x => ({ ...x })), honest: this._lastClueHonest }; }

  get currentPlayer() { return this.players[this.turnIndex]; }
  get selected() { return this.#selected; }
  get maxTrials() { return this.#cfg.MAX_TRIALS; }
  get totalAttempts() { return this.players.length * this.#cfg.MAX_TRIALS; }
  get isFinal() { return this.status === 'ACTIVE' && this.trial === this.#cfg.MAX_TRIALS; }

  select(playerId, route) {
    if (this.status !== 'ACTIVE') return { ok: false, error: 'NOT_ACTIVE' };
    if (this.currentPlayer.id !== playerId) return { ok: false, error: 'NOT_YOUR_TURN' };
    if (!Number.isInteger(route) || route < 0 || route >= this.routeCount) return { ok: false, error: 'INVALID_ROUTE' };
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
      p.score += points; p.discoveries += 1;
      treasure = TREASURES[this.#rng.int(TREASURES.length)];
      if (!this.#knownEmpty.includes(route)) this.#knownEmpty.push(route);
    }
    if (!this.searched.includes(route)) this.searched.push(route);

    p.attempts += 1; this.attempt += 1;
    this.log.push({ eventId: this.log.length + 1, gameId: this.id, trial, attempt: this.attempt, playerId, route, found, points, ts: Date.now() });
    this.#selected = -1;
    this.updatedAt = Date.now();

    let newTrial = false, finalTrialStarted = false;
    this.turnIndex += 1;
    if (this.turnIndex >= this.players.length) {
      this.turnIndex = 0; this.trial += 1; newTrial = true;
      if (this.trial === this.#cfg.MAX_TRIALS) {
        finalTrialStarted = true;
        // The final treasure becomes eligible now, so earlier "searched" marks are no longer proof.
        // Only routes whose treasure was actually found remain known-empty.
        this.searched = [...this.#knownEmpty];
      }
    }
    const allFound = this.#treasures.every(x => x.found);
    let finished = false;
    if (this.trial > this.#cfg.MAX_TRIALS || (this.#cfg.END_WHEN_TREASURES_EXHAUSTED && allFound)) { this.status = 'COMPLETE'; finished = true; }

    this.clue = finished ? null : this.#makeClue();
    return {
      ok: true, requestId, trial, attempt: this.attempt, playerId, route, found, points, treasure,
      finished, newTrial, finalTrialStarted, nextPlayerId: finished ? null : this.currentPlayer.id, clue: this.clue
    };
  }

  /** Standings with the specified tie-break chain: score → discoveries → success rate → fewest attempts → joint. */
  standings() {
    const rows = this.players.map(p => ({ ...p, rate: p.attempts ? p.discoveries / p.attempts : 0 }));
    rows.sort((a, b) => b.score - a.score || b.discoveries - a.discoveries || b.rate - a.rate || a.attempts - b.attempts || a.order - b.order);
    const same = (a, b) => a.score === b.score && a.discoveries === b.discoveries && a.rate === b.rate && a.attempts === b.attempts;
    rows.forEach((r, i) => { r.rank = (i > 0 && same(rows[i - 1], r)) ? rows[i - 1].rank : i + 1; });
    return { rows, winners: rows.filter(r => r.rank === 1) };
  }

  /** Safe, client-visible state: contains no secret fields and no treasure counters. */
  snapshot() {
    return JSON.parse(JSON.stringify({
      gameId: this.id, trial: this.trial, maxTrials: this.#cfg.MAX_TRIALS, attempt: this.attempt, totalAttempts: this.totalAttempts,
      status: this.status, currentPlayer: this.currentPlayer.id, turnIndex: this.turnIndex, routeCount: this.routeCount,
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

if (typeof module !== 'undefined') module.exports = { CONFIG, TREASURES, Expedition, Series, secureRng, seededRng, mulberry32, hashSeed };
