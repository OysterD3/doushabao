import { defineConfig } from "vitest/config";

// e2e boots the real daemon against the fake dws/pi binaries: slow by design,
// and the scenarios share one temp root, so they must not run in parallel.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
