import "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "spotflow-games";

/** Loads the signed-in user on every request and guards state-changing requests against CSRF. */
export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req, reply) => {
    req.user = await findSessionUser(db, req.cookies[SESSION_COOKIE]);
    const mutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    // A custom header cannot be sent cross-site without a CORS preflight, which we never allow.
    if (mutating && req.url.startsWith("/api/") && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      return reply.code(403).send({ error: "Missing CSRF header" });
    }
  });
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  if (!req.user) {
    reply.code(401).send({ error: "Sign in required" });
    return null;
  }
  return req.user;
}
