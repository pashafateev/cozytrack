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
    // Integration files share one bucket and one database; parallel workers
    // race in beforeAll (concurrent CreateBucket → MinIO 409).
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
