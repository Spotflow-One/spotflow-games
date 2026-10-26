import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  GAME_TYPES,
  avatarConfigSchema,
  parseAvatar,
  updateMeSchema,
  type Me,
  type PublicProfile,
} from "@spotflow-games/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { auditEvents, gameSessions, sessionParticipants, users } from "../db/schema.js";
import { requireUser } from "../auth/plugin.js";
import { deleteAllUserSessions, type SessionUser } from "../auth/sessions.js";
import { getUser } from "../auth/users.js";

export const toPublicProfile = (u: SessionUser): PublicProfile => ({
  id: u.id,
  displayName: u.displayName,
  avatar: parseAvatar(u.avatar),
  createdAt: u.createdAt.toISOString(),
});

export function userRoutes(app: FastifyInstance, deps: { db: Db; config: Config }) {
  const { db, config } = deps;
  const isAdmin = (u: SessionUser) => config.adminEmails.has(u.email.toLowerCase());
  const toMe = (u: SessionUser): Me => ({
    ...toPublicProfile(u),
    email: u.email,
    isAdmin: isAdmin(u),
    themePreference: u.themePreference,
    soundEnabled: u.soundEnabled,
  });

  app.get("/api/me", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return toMe(user);
  });

  app.patch("/api/me", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const body = updateMeSchema.parse(req.body);
    const [row] = await db
      .update(users)
      .set({ ...body, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning();
    return toMe(row!);
  });

  app.put("/api/me/avatar", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const avatar = avatarConfigSchema.parse(req.body);
    const [row] = await db
      .update(users)
      .set({ avatar, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning();
    return toMe(row!);
  });

  app.delete("/api/me/avatar", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const [row] = await db
      .update(users)
      .set({ avatar: null, updatedAt: sql`now()` })
      .where(eq(users.id, user.id))
      .returning();
    return toMe(row!);
  });

  /** Company-visible profile with participation history. */
  app.get("/api/profiles/:id", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: "Not found" });
    const profile = await getUser(db, id);
    if (!profile) return reply.code(404).send({ error: "Not found" });

    const completed = and(eq(sessionParticipants.userId, id), eq(gameSessions.status, "completed"));
    const perGame = await db
      .select({
        gameType: gameSessions.gameType,
        played: count(),
        wins: sql<number>`count(*) filter (where ${sessionParticipants.finalRank} = 1)`.mapWith(Number),
        points: sql<number>`coalesce(sum(${sessionParticipants.finalScore}), 0)`.mapWith(Number),
      })
      .from(sessionParticipants)
      .innerJoin(gameSessions, eq(gameSessions.id, sessionParticipants.sessionId))
      .where(completed)
      .groupBy(gameSessions.gameType);
    const recent = await db
      .select({
        sessionId: gameSessions.id,
        gameType: gameSessions.gameType,
        endedAt: gameSessions.endedAt,
        score: sessionParticipants.finalScore,
        rank: sessionParticipants.finalRank,
      })
      .from(sessionParticipants)
      .innerJoin(gameSessions, eq(gameSessions.id, sessionParticipants.sessionId))
      .where(and(completed, isNotNull(gameSessions.endedAt)))
      .orderBy(desc(gameSessions.endedAt))
      .limit(20);

    return {
      profile: { ...toPublicProfile(profile), deactivated: Boolean(profile.deactivatedAt) },
      stats: GAME_TYPES.map((gameType) => {
        const row = perGame.find((r) => r.gameType === gameType);
        return { gameType, played: row?.played ?? 0, wins: row?.wins ?? 0, points: row?.points ?? 0 };
      }),
      recent: recent.map((r) => ({ ...r, endedAt: r.endedAt?.toISOString() ?? null })),
    };
  });

  /** Offboarding: blocks sign-in and ends sessions. Gameplay history is kept. */
  app.post("/api/admin/users/:id/deactivate", async (req, reply) => {
    const actor = requireUser(req, reply);
    if (!actor) return;
    if (!isAdmin(actor)) return reply.code(403).send({ error: "Admins only" });
    const { id } = req.params as { id: string };
    const [row] = await db
      .update(users)
      .set({ deactivatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(users.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "Not found" });
    await deleteAllUserSessions(db, id);
    await db
      .insert(auditEvents)
      .values({ actorId: actor.id, action: "user.deactivate", targetType: "user", targetId: id });
    return { ok: true };
  });
}
