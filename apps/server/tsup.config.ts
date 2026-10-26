import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // The shared package ships as TypeScript source, so bundle it in.
  noExternal: ["@spotflow-games/shared"],
  clean: true,
});
