import { defineConfig } from "vitest/config";

// Tier-C fresh-org runs. The runner that drives this config is the maintainer's, and is not
// part of this repository. It passes the files explicitly and sets DATAVERSE_URL (the trial
// org) and DATAVERSE_TOKEN (an SP token) in the child environment. See test-dev/devEnv.ts and
// test-dev/devToken.ts for those seams, which are here.
//
// Never wire this config to an npm script that chains record-live-run. That would stamp a
// Tier-C run as an L2/DEV run.
//
// Settings mirror vitest.config.dev.ts except retry, which is always 0 here. A fresh-org
// failure is a real signal, and Tier-C has no pipeline quarantine path.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-dev/**/*.dev.test.ts", "test-dev/tierc/**/*.tierc.test.ts"],
    testTimeout: 60000,   // real network round-trips
    hookTimeout: 120000,  // seed/cleanup hooks
    retry: 0,
    fileParallelism: false, // serialize: one org per run, avoid write races
  },
});
