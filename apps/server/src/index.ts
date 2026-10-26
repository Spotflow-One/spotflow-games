import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { app, manager } = await buildApp(config);
await manager.recoverOnBoot();
manager.startSweeper();
await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
