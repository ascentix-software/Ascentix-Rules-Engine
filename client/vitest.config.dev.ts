import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export class LifecycleFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const ordered = await super.sort(files);
    const lifecycle = (file: TestSpecification) => file.moduleId.replace(/\\/g, "/").endsWith("/ruleRevisions.dev.test.ts");
    return [...ordered.filter(lifecycle), ...ordered.filter(file => !lifecycle(file))];
  }
}

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
    sequence: { sequencer: LifecycleFirstSequencer },
    reporters: ["default", "./test-dev/failFastReporter.ts"],
    bail: process.env.CI ? 1 : 0, // stop CI when the deployed lifecycle or another contract is broken
  },
});
