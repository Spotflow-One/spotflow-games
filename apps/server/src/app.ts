import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { createDb } from "./db/client.js";
import { GoogleAuth } from "./auth/google.js";
import { registerAuth } from "./auth/plugin.js";
import { GameRegistry } from "./games/registry.js";
import { createGateway } from "./realtime/gateway.js";
import { authRoutes } from "./routes/auth.js";
import { sessionRoutes } from "./routes/sessions.js";
import { userRoutes } from "./routes/users.js";
import { SessionManager } from "./sessions/manager.js";

export async function buildApp(config: Config, opts: { registry?: GameRegistry; logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.NODE_ENV === "test" ? "warn" : "info" },
    trustProxy: true,
  });
  const { db, pool } = createDb(config.DATABASE_URL);
  const registry = opts.registry ?? new GameRegistry();
  const google = new GoogleAuth(config);
  const manager = new SessionManager(db, registry, {
    lobbyExpiryMs: config.LOBBY_EXPIRY_MINUTES * 60_000,
    log: { info: (m) => app.log.info(m), error: (m, e) => app.log.error({ err: e }, m) },
  });

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  registerAuth(app, db);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.user?.id ?? req.ip,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong" : (err as Error).message });
  });

  app.get("/healthz", async () => ({ ok: true }));
  authRoutes(app, { db, config, google });
  userRoutes(app, { db, config });
  sessionRoutes(app, { manager, registry });

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
  });

  app.addHook("onClose", async () => {
    await manager.stop();
    io.close();
    await pool.end();
  });

  return { app, db, manager, registry, io };
}
