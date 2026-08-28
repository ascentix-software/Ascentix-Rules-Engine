import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environmentMatchGlobs: [["**/*.dom.test.tsx", "jsdom"]],
    setupFiles: ["./test/setup.dom.ts"],
    // The heavy Fluent-Dialog editor DOM tests are timing-sensitive under full-suite parallel
    // load: with the default ~11-way fork parallelism (12 cores), concurrent jsdom+Fluent renders
    // starve each other's CPU and a render can exceed even a generous findBy window; they pass
    // reliably in isolation. Cap fork concurrency so every heavy test gets real CPU headroom (the
    // root cause), with a small retry budget as a backstop. Neither masks a genuine failure (a
    // broken test still fails every attempt); both are no-ops for the deterministic logic tests.
    // Paired with the raised asyncUtilTimeout in test/setup.dom.ts.
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    retry: 2,
    // The heavy Fluent-Dialog DOM tests (e.g. open→edit→cancel→reopen cycles) can take longer than
    // vitest's default 5s per-test timeout under jsdom, especially as suite size grows, and the
    // per-test timeout must be >= the asyncUtilTimeout above, or a findBy still polling when the
    // test clock hits 5s is killed mid-wait. Raise both in lockstep.
    testTimeout: 20000,
    // Hooks need the same headroom: hookTimeout is a SEPARATE knob that stayed at vitest's 10s
    // default and killed boot.dom's beforeAll (which imports the whole editor graph) under
    // full-suite CPU contention on CI. Keep it in lockstep with testTimeout.
    hookTimeout: 20000,
  },
});
