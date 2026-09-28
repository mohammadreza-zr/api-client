import { defineConfig } from "tsup";

export default defineConfig({
  // Plugins are separate entry points, so an app that doesn't import one pays nothing for it.
  entry: { index: "src/index.ts", services: "src/plugins/services.ts" },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  target: "es2020",
  platform: "neutral",
  splitting: false,
});
