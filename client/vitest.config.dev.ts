import { defineConfig } from "vitest/config";

// Separate project: LOCAL-ONLY tests that hit real DEV. Excluded from `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-dev/**/*.dev.test.ts"],
    testTimeout: 60000,   // real network round-trips
    hookTimeout: 120000,  // seed/cleanup hooks
    // Local: a DEV failure is a real signal, never masked. CI (pipeline runs): one retry, because
    // the org is non-hermetic, and a retried-pass is still visible in JUnit; a case that
    // retry-passes in 2 of its last 5 pipeline runs moves to quarantine (see the live-L2 spec).
    retry: process.env.CI ? 1 : 0,
    fileParallelism: false, // serialize: shared DEV org, avoid write races
  },
});
