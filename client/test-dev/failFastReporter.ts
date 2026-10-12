import type { Reporter, TestModule, Vitest } from "vitest/node";

// Vitest's bail counts failed test cases; setup/collection failures also need to stop shared-org CI.
export default class FailFastReporter implements Reporter {
  private context?: Vitest;

  onInit(context: Vitest) { this.context = context; }

  onTestModuleEnd(module: TestModule) {
    // Cancellation waits for this reporter callback to finish, so do not await it here.
    if (process.env.CI && module.state() === "failed")
      void this.context?.cancelCurrentRun("test-failure");
  }
}
