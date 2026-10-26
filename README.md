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

Game screens, leaderboards, achievements, Slack and reminders come in later milestones.

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
