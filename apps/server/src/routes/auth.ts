import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { checkIdentity } from "../auth/domain.js";
import type { GoogleAuth } from "../auth/google.js";
import { SESSION_COOKIE, createAuthSession, deleteAuthSession } from "../auth/sessions.js";
import { upsertGoogleUser } from "../auth/users.js";

const OAUTH_COOKIE = "sg_oauth";

/** Only allow same-site relative paths as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

export function authRoutes(app: FastifyInstance, deps: { db: Db; config: Config; google: GoogleAuth }) {
  const { db, config, google } = deps;
  const secure = config.NODE_ENV === "production";
  const devLogin = config.DEV_LOGIN && config.NODE_ENV !== "production";

  const signIn = async (
    reply: import("fastify").FastifyReply,
    identity: { sub: string; email: string; name: string },
    userAgent?: string,
  ) => {
    const user = await upsertGoogleUser(db, identity);
    if (user.deactivatedAt) return null;
    const { token, expiresAt } = await createAuthSession(db, user.id, config.SESSION_TTL_DAYS, userAgent);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure, expires: expiresAt });
    return user;
  };

  app.get("/api/auth/config", async () => ({ google: google.enabled, devLogin, domain: config.ALLOWED_EMAIL_DOMAIN }));

  app.get("/api/auth/google", async (req, reply) => {
    if (!google.enabled) return reply.code(503).send({ error: "Google sign-in is not configured" });
    const state = randomBytes(16).toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    const { url, codeVerifier } = await google.authUrl(state, nonce);
    const returnTo = safeReturnTo((req.query as Record<string, unknown>).returnTo);
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, nonce, codeVerifier, returnTo }), {
      path: "/api/auth",
      httpOnly: true,
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const fail = (error: string) => reply.redirect(`/signin?error=${encodeURIComponent(error)}`);
    const raw = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: "/api/auth" });
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) return fail("expired");
    let saved: { state: string; nonce: string; codeVerifier: string; returnTo: string };
    try {
      saved = JSON.parse(unsigned.value);
    } catch {
      return fail("expired");
    }
    if (query.error) return fail("cancelled");
    if (!query.code || query.state !== saved.state) return fail("expired");

    let identity;
    try {
      identity = await google.exchange(query.code, saved.codeVerifier, saved.nonce);
    } catch (err) {
      req.log.warn({ err }, "google sign-in failed");
      return fail("google");
    }
    if (!identity.ok) {
      req.log.warn({ reason: identity.reason }, "google sign-in rejected");
      return fail(identity.reason);
    }
    const user = await signIn(reply, identity, req.headers["user-agent"]);
    if (!user) return fail("deactivated");
    return reply.redirect(safeReturnTo(saved.returnTo));
  });

  if (devLogin) {
    const devSchema = z.object({ email: z.string().email(), name: z.string().min(1).max(40).optional() });
    app.post("/api/auth/dev-login", async (req, reply) => {
      const body = devSchema.parse(req.body);
      const identity = checkIdentity(
        {
          sub: `dev:${body.email.toLowerCase()}`,
          email: body.email,
          email_verified: true,
          hd: body.email.split("@")[1],
          name: body.name,
        },
        config.ALLOWED_EMAIL_DOMAIN,
      );
      if (!identity.ok)
        return reply.code(403).send({ error: `Only ${config.ALLOWED_EMAIL_DOMAIN} accounts can sign in` });
      const user = await signIn(reply, identity, req.headers["user-agent"]);
      if (!user) return reply.code(403).send({ error: "This account is deactivated" });
      return { ok: true };
    });
  }

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteAuthSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
