# HUNTARA — game server

One Node process that (1) serves the game at `/` and (2) runs the authoritative multiplayer rooms at `/ws`.
The server owns the treasure routes, clues, turn order, scores and results. Clients only send "select" and "track".

## Run locally
```
npm install
npm start          # http://localhost:8080
npm test           # 10 real WebSocket clients play a full 100-attempt game
```
Open http://localhost:8080 on two browsers/phones on the same Wi-Fi (use your computer's LAN IP), Private room → Create a room → friends join with the code.

## Deploy on Render (free, supports WebSockets)
1. Put this folder in a GitHub repo.
2. render.com → New → Web Service → pick the repo. Build `npm install`, start `npm start` (or use render.yaml → "Blueprint").
3. Open the URL Render gives you. That single URL is both the game and the server. Share it, create a room, play.
Free instances sleep after ~15 min idle; the first open then takes ~30 s. A paid instance stays awake.

## If you keep the game on Netlify
Deploy the server (above), then in the game: Private room → "Game server" → paste `your-app.onrender.com`. Optionally set the env var
`ALLOWED_ORIGINS=https://your-site.netlify.app` on the server so only your site can connect.

## Environment variables
`PORT` (set by host) · `ALLOWED_ORIGINS` (comma list) · `TURN_MS` (default 30000) · `POST_FOUND` / `POST_MISS` (pause after results) · `START_MS`.

## Protocol (JSON over WebSocket)
Client → server: `hello, create, join, leave, settings, choose, addbot, rmbot, start, next, vote, reveal, newgame, select, track, sync, ping`
Server → client: `welcome, room, game_start, turn, selected, attempt_start, attempt_result, game_over, next_prompt, vote_open, vote_result, final, reveal_unlocked, trophy_reveal, sync, error, pong`
`attempt_start` carries only the route; the outcome is withheld until the tracker has arrived (`attempt_result`).

## Why a shared room link can "time out" (and how to stop it)
The free Render plan **puts your server to sleep after about 15 minutes with no web traffic**, and waking it takes 30-60 seconds. While it sleeps nobody can join. The game now keeps retrying and says "Waking the game server…", but the best fix is to stop it sleeping:
1. Make a free account at **uptimerobot.com** (or cron-job.org).
2. Add a monitor: type **HTTP(s)**, URL `https://YOUR-APP.onrender.com/healthz`, interval **5 minutes**.
3. That's it. The server stays awake, so rooms are still there when people come back.
Rooms are kept in memory: they survive idle time (default 12 hours, `ROOM_IDLE_HOURS`) and people who disconnect keep their seat in a lobby for 45 minutes (`LOBBY_GRACE_MIN`). A **restart or redeploy clears all rooms**. For rooms that survive restarts you would need a database (Redis/Postgres), which is the next step if you want it.

## Route rules (server-side)
Routes per expedition = players x 10 (2 players = 20 numbers, 10 players = 100). Every number is played once. The server decides which routes are on screen (the smallest connected screen sets the capacity) and sends the same set to everyone.

## Limits of this version
In-memory, single instance: a restart ends running games. No accounts or database yet (see ARCHITECTURE.md for Redis/Postgres/auth steps).

## Series (ten expeditions), agreement, final result and trophy
- Before the host can start, **every human** must send `choose {format: full|flexible}` and all choices must match. The format is locked at start.
- `game_over` is the normal per-expedition result (unchanged). After it: Full Game -> `next_prompt` (host, everyone ready, or 25 s); Flexible Game -> `vote_open` (the game ends only if MORE than half of the humans vote to end; missing votes count as continue, 30 s).
- After expedition 10 (or an "end" vote) the server sends `final` once: ranking by expedition wins, ties by total score, joint winners if still level, plus the ten-expedition table.
- Trophy: only a Full Game completed to expedition 10. Human winner presses `reveal`; AI-only winners reveal automatically after 5 s; after 60 s (or if every human winner is offline) anyone may reveal. The first reveal wins, repeats are ignored, and `trophy_reveal` goes to every phone at once.
- Test-only env var: `MAX_EXP` shortens the series (default 10).
