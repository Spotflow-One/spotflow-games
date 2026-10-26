import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://spotflow:spotflow@localhost:5432/spotflow_games_test",
    },
    fileParallelism: false,
  },
});
