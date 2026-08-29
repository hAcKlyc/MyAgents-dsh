import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    setupFiles: ["./tests/setup/default-isolation.ts"],
    testTimeout: 10_000,
    include: [
      "packages/**/*.unit.test.{ts,tsx}",
      "apps/**/*.unit.test.{ts,tsx}",
      "tests/**/*.unit.test.{ts,tsx}",
    ],
  },
});
