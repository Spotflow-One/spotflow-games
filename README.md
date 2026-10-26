# Happy Hour (spotflow-games)

Internal multiplayer games for the Spotflow team: Quiz Arena, Draw & Guess, Two Truths and a Lie, Core Clash and Lagos Rush. Sign-in is limited to verified `spotflow.one` Google accounts.

## Status

Milestone 1 (foundation) is in place:

- Google sign-in (OpenID Connect with PKCE, state and nonce). The server only accepts verified emails on `spotflow.one` with a matching Workspace `hd` claim.
- Profiles with a display name, an avatar builder, theme (system, light, dark) and sound preferences.
- Company-visible profiles with per-game points, wins and recent games.
- The shared session lifecycle for every game: lobby, ready, in progress, results, completed. It covers join codes and invite links, reconnects without duplicate players, host moderation, late-join control, lobby expiry, and idempotent score events.
- A real-time gateway on Socket.IO, with cookie auth, an origin check and per-player rate limits.
- A game engine contract (`apps/server/src/games/contract.ts`) that milestone 2 games plug into.
- Admin offboarding, which deactivates an account and keeps its history.

Milestone 2 is underway. **Quiz Arena** is playable: hosts pick one of the curated quizzes, set the time per question and choose whether to shuffle questions and answers. The server runs the timers, locks answers, reveals the right one and scores it: 1000 points for an instant correct answer, falling to 500 at the buzzer. Ties go to the faster total answer time.

**Draw & Guess** is playable too. Hosts pick a word list, the time to draw and how many times everyone draws. Each drawer picks one of three words. Everyone else sees the drawing live and guesses. Letters are revealed as hints at 50% and 75% of the turn. The first correct guess earns 300 points, each later one 50 less (never under 100), and the drawer gets 50 per correct guess. Near misses show "So close" to the guesser only.

**Two Truths and a Lie** is playable too. Hosts pick how many players are featured (picked at random), the time to write and the time to vote. Featured players write three statements and mark the lie, and can edit them until writing time ends. Each featured player then gets a round: the statements are shuffled, everyone else votes, and votes stay hidden until the reveal. Spotting the lie earns 100 points, and the featured player earns 50 for each person fooled. The host can close voting early or skip a round, and a skipped round scores nothing.

**Core Clash** is a real-time, top-down team shooter. The host picks 2 to 4 teams, a Power target (60, 100 or 150) and a time limit (3, 5 or 8 minutes), and players are dealt into balanced teams. Teams fill a shared Power bar: a drone is worth 2, a player on another team 5, and the Titan boss, which wakes in the middle after 30 seconds, 25 to the team that did the most damage to it. The first team to the target wins, or the team with the most Power when time runs out. Personal points (50 a tag, 20 a drone, a share of 300 for Titan damage, and 200 each for the winning team) go to the leaderboard when the game ends. Controls are WASD or arrows, mouse aim and click to fire, and Space fires at the nearest enemy; phones play sideways with on-screen sticks.

**Lagos Rush** is a real-time 3D Grand Prix for up to 30 drivers, seen from just behind your F1 car, with red and white kerbs, grandstands, five start lights and a timing tower with lap and best times. It runs from Lekki Toll Gate through Ozumba Mbadiwe and Obalende, over Third Mainland Bridge, through Oshodi market and back by Ikoyi and the Lekki-Ikoyi Link Bridge. The host picks 1 to 5 laps (about a minute each). The road is full of trouble: danfos that flash an indicator and swing over to the kerb, okadas weaving between lanes, potholes, market stalls, parked kekes, police checkpoints with one gap in the cones, and go-slow on Third Mainland Bridge. Item boxes give nitro or an oil slick to drop behind you; drivers further back get nitro more often. Once the winner crosses the line, everyone else has 30 seconds. Points go by finishing place (100, plus 25 for each driver you beat, plus 150 for the win), with up to 50 for clean driving (5 off per crash); drivers who don't finish get up to 150 for distance. Controls are the arrow keys or WASD and Space for items; phones play sideways with auto-throttle, steering pads, a brake and an item button. A host who doesn't drive gets a follow camera and a whole-map view for the big screen.

Obstacles in Lagos Rush come from a seed and the race clock (`packages/shared/src/race.ts`), so every screen and the server agree on the traffic without sending it. The race is simulated in two dimensions; three.js only draws it (`apps/web/src/games/race3d.ts`), and is downloaded only when a race starts. Each car is simulated on its driver's device and checked against top speed and the road walls on the server, which also owns laps, finishing order, item boxes and oil slicks.

Real-time games stream held controls with `game:input`. Inputs skip the room lock: each instance batches them into one Redis command per room every 40 ms, and the game reads the latest ones on its 10-per-second tick (`ctx.inputs()`). Movement is predicted in the browser and checked against top speed and walls on the server; hits, damage and scoring happen on the server only.

Custom quizzes and word lists, leaderboards, achievements, Slack and reminders come next.

## Layout

```
apps/server       Fastify API, Socket.IO gateway, session manager, Drizzle + Postgres
apps/web          React (Vite) app, styled with the design system
packages/shared   Types, validation schemas and socket event contracts used by both
design-system     Tokens and component CSS exported from the design system
```

## Running locally

You need Node 22+ and Postgres 16. `docker compose up -d` starts a local Postgres and Redis. Redis is optional for development: without `REDIS_URL`, live sessions are kept in memory.

```sh
cp .env.example .env
npm install
npm run db:migrate
npm run dev            # API on :3001, web on http://localhost:5173
```

### Already have Postgres installed?

If Postgres from Homebrew or Postgres.app is already running on port 5432, it answers instead of the Docker one, and migrations fail with `role "spotflow" does not exist`. Either stop it (`brew services stop postgresql`) or use it and create the user and databases once:

```sh
psql postgres -c "CREATE ROLE spotflow WITH LOGIN CREATEDB PASSWORD 'spotflow';" \
  -c "CREATE DATABASE spotflow_games OWNER spotflow;" \
  -c "CREATE DATABASE spotflow_games_test OWNER spotflow;"
```

If `docker compose` fails with `docker-credential-desktop: executable file not found`, remove the `"credsStore": "desktop"` line from `~/.docker/config.json`.

With `DEV_LOGIN=true`, the sign-in page has a developer form that accepts any `@spotflow.one` email, so you can test with several players in different browser profiles without Google. Production refuses to start with it on.

## Google sign-in setup

1. In Google Cloud console, open APIs & Services, then Credentials, and create an OAuth client ID of type "Web application".
2. Add the authorized redirect URI `<APP_URL>/api/auth/google/callback`, for example `http://localhost:5173/api/auth/google/callback`.
3. Set the OAuth consent screen to Internal if the project belongs to the Spotflow Workspace.
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Tests

```sh
npm test
```

Server tests run against the `spotflow_games_test` database (override with `TEST_DATABASE_URL`). The schema is reset on each run. The shared-session tests need Redis at `redis://localhost:6379/15` (override with `TEST_REDIS_URL`); they flush that database.

## Database changes

Edit `apps/server/src/db/schema.ts`, then run `npm run db:generate` and commit the new migration in `apps/server/drizzle`. Migrations also run automatically when the server starts.

## Design system

`design-system/` holds `tokens.json` and the `sg-` component CSS. After pulling a new export, run `npm run tokens` to regenerate `apps/web/src/styles/tokens.css`.

## Deploying

The `Dockerfile` builds one image that serves the API, WebSockets and the web app on `PORT` (8080 by default). Required in production: `DATABASE_URL`, `APP_URL`, `COOKIE_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Set `REDIS_URL` whenever more than one instance may run. Live sessions are then kept in Redis: every change takes a short lock on the game, loads it, applies the change and saves it, so any instance can serve any player. Game timers are saved as due times, and if the instance that set one goes away, another fires it within a few seconds. Updates for players are relayed between instances with Redis pub/sub.

Without `REDIS_URL`, live sessions are kept in memory, so run a single instance. If that process restarts, games in progress are cancelled. Completed results are always saved to Postgres.

### Vercel

`vercel.json` deploys the same image as one Vercel service (`app`, Container runtime) that takes all public traffic. Nothing calls another service server-side, so there are no bindings. In the Vercel project:

- Set `PORT=8080` (Vercel sends traffic to port 80 unless `PORT` is set, and the image runs as a non-root user that can't bind 80).
- Set the production variables above, marking `DATABASE_URL`, `COOKIE_SECRET` and `GOOGLE_CLIENT_SECRET` as Sensitive.
- Make sure Fluid Compute is on (Settings → Functions); WebSockets need it.
- Add Redis: in the Vercel dashboard, open Storage (or the Marketplace), add Upstash for Redis, and connect it to the project. Set `REDIS_URL` to the database's TCP URL, which starts with `rediss://` (not the REST URL), and mark it Sensitive. Pick the region closest to the Vercel functions.

Vercel runs several instances and closes WebSocket connections at the function's maximum duration (300 seconds by default). Clients reconnect on their own, and with Redis it doesn't matter which instance they land on.

Upstash bills per command on its pay-as-you-go plan. A quiz or Two Truths game uses a few hundred commands, but drawing sends strokes about ten times a second while someone draws, at about ten Redis commands per batch, so a busy Draw & Guess game can use tens of thousands. If Draw & Guess gets regular use, a fixed-price Upstash plan is cheaper.
