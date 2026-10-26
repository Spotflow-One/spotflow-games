import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { GAME_TYPES, SESSION_STATUSES, THEME_PREFERENCES } from "@spotflow-games/shared";

export const gameTypeEnum = pgEnum("game_type", GAME_TYPES);
export const sessionStatusEnum = pgEnum("session_status", SESSION_STATUSES);
export const themeEnum = pgEnum("theme_preference", THEME_PREFERENCES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Google account subject. Stable even if the email changes. */
    googleSub: text("google_sub").notNull().unique(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    /** Validated AvatarConfig, or null for the initials fallback. */
    avatar: jsonb("avatar"),
    themePreference: themeEnum("theme_preference").notNull().default("system"),
    soundEnabled: boolean("sound_enabled").notNull().default(false),
    /** Set when an employee leaves. Deactivated users cannot sign in. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    /** sha256 of the cookie token, so a database leak does not leak live sessions. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const gameSessions = pgTable(
  "game_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    gameType: gameTypeEnum("game_type").notNull(),
    status: sessionStatusEnum("status").notNull().default("lobby"),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id),
    /** Settings plus a snapshot of the content used, frozen at start. */
    config: jsonb("config").notNull().default({}),
    allowLateJoin: boolean("allow_late_join").notNull().default(false),
    hostPlays: boolean("host_plays").notNull().default(true),
    rulesVersion: integer("rules_version").notNull().default(1),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // Codes are only unique among live sessions, so they can be reused later.
    uniqueIndex("game_sessions_live_code_idx")
      .on(t.code)
      .where(sql`${t.status} in ('lobby', 'ready', 'in_progress', 'results')`),
    index("game_sessions_host_idx").on(t.hostId),
  ],
);

export const sessionParticipants = pgTable(
  "session_participants",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // One row per account per session prevents duplicate participation.
    status: text("status", { enum: ["active", "left", "kicked"] })
      .notNull()
      .default("active"),
    finalScore: integer("final_score"),
    finalRank: integer("final_rank"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] }), index("session_participants_user_idx").on(t.userId)],
);

/** Auditable, idempotent score changes. Leaderboards are aggregated from these. */
export const scoreEvents = pgTable(
  "score_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => gameSessions.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    gameType: gameTypeEnum("game_type").notNull(),
    points: integer("points").notNull(),
    reason: text("reason").notNull(),
    /** Unique per scoring action, so retries and reconnects can never award twice. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("score_events_user_game_idx").on(t.userId, t.gameType, t.createdAt),
    index("score_events_session_idx").on(t.sessionId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_created_idx").on(t.createdAt)],
);
