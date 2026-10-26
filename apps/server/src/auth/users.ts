import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";

/** Find or create the profile for a verified Google identity. */
export async function upsertGoogleUser(db: Db, identity: { sub: string; email: string; name: string }) {
  const [row] = await db
    .insert(users)
    .values({ googleSub: identity.sub, email: identity.email, displayName: identity.name })
    .onConflictDoUpdate({
      target: users.googleSub,
      // Keep the employee's chosen display name; only identity fields follow Google.
      set: { email: identity.email, lastSeenAt: sql`now()`, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function getUser(db: Db, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}
