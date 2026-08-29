import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    include: ["tests/web-host-*.integration.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
