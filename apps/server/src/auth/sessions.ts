import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authSessions, users } from "../db/schema.js";

export const SESSION_COOKIE = "sg_session";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type SessionUser = typeof users.$inferSelect;

export async function createAuthSession(db: Db, userId: string, ttlDays: number, userAgent?: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values({ tokenHash: hash(token), userId, expiresAt, userAgent });
  return { token, expiresAt };
}

/** Returns the active user for a session token, or null if expired, unknown or deactivated. */
export async function findSessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(eq(authSessions.tokenHash, hash(token)), gt(authSessions.expiresAt, new Date()), isNull(users.deactivatedAt)),
    )
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function deleteAuthSession(db: Db, token: string) {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hash(token)));
}

/** Used when offboarding: ends every session the user has. */
export async function deleteAllUserSessions(db: Db, userId: string) {
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}
