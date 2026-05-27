import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    sequence: {
      concurrent: false,
    },
  },
});
