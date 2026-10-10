# Jungle Treasure Hunt — game server

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
Client → server: `hello, create, join, leave, settings, addbot, rmbot, start, rematch, select, track, sync, ping`
Server → client: `welcome, room, game_start, turn, selected, attempt_start, attempt_result, game_over, sync, error, pong`
`attempt_start` carries only the route; the outcome is withheld until the tracker has arrived (`attempt_result`).

## Limits of this version
In-memory, single instance: a restart ends running games. No accounts or database yet (see ARCHITECTURE.md for Redis/Postgres/auth steps).
