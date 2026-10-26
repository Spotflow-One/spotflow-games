import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { createDb } from "./db/client.js";
import { GoogleAuth } from "./auth/google.js";
import { registerAuth } from "./auth/plugin.js";
import { GameError } from "./games/contract.js";
import { createClashEngine } from "./games/clash/engine.js";
import { createDrawEngine } from "./games/draw/engine.js";
import { curatedWordSource, type WordSource } from "./games/draw/words.js";
import { createQuizEngine } from "./games/quiz/engine.js";
import { createTruthsEngine } from "./games/truths/engine.js";
import { curatedQuizSource, type QuizSource } from "./games/quiz/library.js";
import { GameRegistry } from "./games/registry.js";
import { createGateway } from "./realtime/gateway.js";
import { authRoutes } from "./routes/auth.js";
import { contentRoutes } from "./routes/content.js";
import { sessionRoutes } from "./routes/sessions.js";
import { userRoutes } from "./routes/users.js";
import { SessionManager } from "./sessions/manager.js";
import { RedisRoomStore, redisBus } from "./sessions/redisStore.js";

export async function buildApp(
  config: Config,
  opts: { registry?: GameRegistry; quizSource?: QuizSource; wordSource?: WordSource; logger?: boolean } = {},
) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.NODE_ENV === "test" ? "warn" : "info" },
    trustProxy: true,
  });
  const { db, pool } = createDb(config.DATABASE_URL);
  const quizSource = opts.quizSource ?? curatedQuizSource;
  const wordSource = opts.wordSource ?? curatedWordSource;
  const registry =
    opts.registry ??
    new GameRegistry()
      .register(createQuizEngine(quizSource))
      .register(createDrawEngine(wordSource))
      .register(createTruthsEngine())
      .register(createClashEngine());
  const google = new GoogleAuth(config);
  const log = { info: (m: string) => app.log.info(m), error: (m: string, e?: unknown) => app.log.error({ err: e }, m) };
  // With Redis, live sessions are shared by every server instance; without it they stay in this process.
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 }) : null;
  const redisSub = redis?.duplicate() ?? null;
  const manager = new SessionManager(
    db,
    registry,
    { lobbyExpiryMs: config.LOBBY_EXPIRY_MINUTES * 60_000, log },
    redis ? (builder, transport) => new RedisRoomStore(redis, builder, transport, { log }) : undefined,
  );

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  registerAuth(app, db);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    if (err instanceof GameError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong" : (err as Error).message });
  });

  app.get("/healthz", async () => ({ ok: true }));
  authRoutes(app, { db, config, google });
  userRoutes(app, { db, config });
  sessionRoutes(app, { manager, registry });
  contentRoutes(app, { quizSource, wordSource });

  // In production the server also serves the built web app, so one container runs everything.
  if (config.WEB_DIST && existsSync(config.WEB_DIST)) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  const io = createGateway(app.server, {
    db,
    manager,
    appOrigin: new URL(config.APP_URL).origin,
    parseCookie: (header) => app.parseCookie(header),
    log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m, e) => app.log.error({ err: e }, m) },
    bus: redis && redisSub ? (local) => redisBus(redis, redisSub, local, log) : undefined,
  });

  app.addHook("onClose", async () => {
    // Close sockets first so players are marked disconnected before the store goes away.
    io.close();
    await manager.stop();
    await Promise.all([redis?.quit(), redisSub?.quit()]);
    await pool.end();
  });

  return { app, db, manager, registry, io };
}
