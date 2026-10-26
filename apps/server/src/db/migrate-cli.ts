// `npm run db:migrate`. Kept apart from migrate.ts so bundling the server never runs it on import.
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL ?? "postgres://spotflow:spotflow@localhost:5432/spotflow_games";
await runMigrations(url);
console.log("Migrations applied");
