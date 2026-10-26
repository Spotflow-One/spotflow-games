import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

// apps/server/drizzle, reached from src/db/ in development and from dist/ when bundled.
export const migrationsFolder =
  process.env.MIGRATIONS_DIR ??
  ["../../drizzle", "../drizzle"]
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((dir) => existsSync(`${dir}/meta/_journal.json`))!;

export async function runMigrations(databaseUrl: string, folder = migrationsFolder) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}
