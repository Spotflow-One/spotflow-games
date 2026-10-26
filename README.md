# Spotflow Games

Internal multiplayer games for the Spotflow team: Quiz Arena, Draw & Guess, and Two Truths and a Lie. Sign-in is limited to verified `spotflow.one` Google accounts.

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

Draw & Guess, Two Truths and a Lie, custom quizzes, leaderboards, achievements, Slack and reminders come next.

## Layout

```
apps/server       Fastify API, Socket.IO gateway, session manager, Drizzle + Postgres
apps/web          React (Vite) app, styled with the design system
packages/shared   Types, validation schemas and socket event contracts used by both
design-system     Tokens and component CSS exported from the design system
```

## Running locally

You need Node 22+ and Postgres 16. `docker compose up -d` starts a local Postgres.

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

Server tests run against the `spotflow_games_test` database (override with `TEST_DATABASE_URL`). The schema is reset on each run.

## Database changes

Edit `apps/server/src/db/schema.ts`, then run `npm run db:generate` and commit the new migration in `apps/server/drizzle`. Migrations also run automatically when the server starts.

## Design system

`design-system/` holds `tokens.json` and the `sg-` component CSS. After pulling a new export, run `npm run tokens` to regenerate `apps/web/src/styles/tokens.css`.

## Deploying

The `Dockerfile` builds one image that serves the API, WebSockets and the web app on `PORT` (8080 by default). Required in production: `DATABASE_URL`, `APP_URL`, `COOKIE_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Live sessions are kept in memory on one instance, so run a single replica, or use sticky sessions, until the sessions get a shared store. One instance handles the launch target of 100 concurrent players. If the process restarts, games in progress are cancelled, and completed results are already saved.
