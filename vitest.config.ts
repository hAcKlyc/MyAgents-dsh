import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    include: ["packages/**/*.unit.test.ts", "apps/**/*.unit.test.ts", "tests/**/*.unit.test.ts"],
  },
});
