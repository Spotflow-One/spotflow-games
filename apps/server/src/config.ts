import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  /** Public URL users reach the app on, e.g. https://games.spotflow.one */
  APP_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().default("postgres://spotflow:spotflow@localhost:5432/spotflow_games"),
  /** Secret used to sign the OAuth state cookie. */
  COOKIE_SECRET: z.string().min(32).default("dev-only-cookie-secret-change-me-please-000"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  ALLOWED_EMAIL_DOMAIN: z.string().default("spotflow.one"),
  /** Comma-separated emails that get platform admin rights. */
  ADMIN_EMAILS: z.string().default(""),
  /** Enables /api/auth/dev-login for local work without Google. Never on in production. */
  DEV_LOGIN: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  LOBBY_EXPIRY_MINUTES: z.coerce.number().default(60),
  /**
   * Redis for live sessions. When set, sessions are shared by every server instance (needed on
   * hosts like Vercel that run several). When unset, they are kept in this process.
   */
  REDIS_URL: z.string().optional(),
  /** Directory with the built web app, served in production. */
  WEB_DIST: z.string().optional(),
});

export type Config = z.infer<typeof envSchema> & { adminEmails: Set<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === "production") {
    if (parsed.DEV_LOGIN) throw new Error("DEV_LOGIN must not be enabled in production");
    if (!parsed.GOOGLE_CLIENT_ID || !parsed.GOOGLE_CLIENT_SECRET) {
      throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production");
    }
    if (parsed.COOKIE_SECRET.startsWith("dev-only")) throw new Error("COOKIE_SECRET must be set in production");
  }
  const adminEmails = new Set(
    parsed.ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  return { ...parsed, adminEmails };
}
