import { defineConfig } from "vitest/config";

// Unit tests live next to the module they cover (src/**/*.test.ts).
// e2e is a separate config because it boots the real daemon and needs a
// much longer timeout — see vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
