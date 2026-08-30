import { defineConfig } from "vitest/config";

const TEST_TIMEOUT_MS = 20_000;

export default defineConfig({
  test: {
    // The heavy Fluent-Dialog editor DOM tests are timing-sensitive under full-suite parallel
    // load: with the default ~11-way fork parallelism (12 cores), concurrent jsdom+Fluent renders
    // starve each other's CPU and a render can exceed even a generous findBy window; they pass
    // reliably in isolation. Cap fork concurrency so every heavy test gets real CPU headroom (the
    // root cause), with a small retry budget as a backstop. Neither masks a genuine failure (a
    // broken test still fails every attempt); both are no-ops for the deterministic logic tests.
    // Paired with the raised asyncUtilTimeout in test/setup.dom.ts.
    maxWorkers: 4,
    retry: 2,
    // The heavy Fluent-Dialog DOM tests (e.g. open→edit→cancel→reopen cycles) can take longer than
    // vitest's default 5s per-test timeout under jsdom, especially as suite size grows, and the
    // per-test timeout must be >= the asyncUtilTimeout above, or a findBy still polling when the
    // test clock hits 5s is killed mid-wait. Raise both in lockstep.
    testTimeout: TEST_TIMEOUT_MS,
    // Hooks need the same headroom: hookTimeout is a SEPARATE knob that stayed at vitest's 10s
    // default and killed boot.dom's beforeAll (which imports the whole editor graph) under
    // full-suite CPU contention on CI. Keep it in lockstep with testTimeout.
    hookTimeout: TEST_TIMEOUT_MS,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
          exclude: ["test/**/*.dom.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["test/**/*.dom.test.tsx"],
          setupFiles: ["./test/setup.dom.ts"],
        },
      },
    ],
  },
});
