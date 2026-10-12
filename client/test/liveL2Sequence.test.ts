import { expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import { LifecycleFirstSequencer } from "../vitest.config.dev";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

it.each(["/repo/test-dev/", "C:\\repo\\test-dev\\"])("runs lifecycle first without losing any suite under %s", async prefix => {
  const project = { name: "dev", config: { sequence: { groupOrder: 0 }, isolate: true } };
  const files = ["long.dev.test.ts", "ruleRevisions.dev.test.ts", "failed.dev.test.ts"]
    .map(name => ({ moduleId: prefix + name, project }) as TestSpecification);
  const context = {
    config: { root: "/repo" },
    cache: {
      getFileTestResults: (key: string) => ({ failed: key.includes("failed"), duration: key.includes("long") ? 100 : 1 }),
      getFileStats: () => ({ size: 1 }),
    },
  } as unknown as Vitest;
  const ordered = await new LifecycleFirstSequencer(context).sort(files);
  expect(ordered).toEqual([files[1], files[2], files[0]]);
  expect(new Set(ordered)).toEqual(new Set(files));
});

it.each(["assertion", "setup", "collection", "success"])("handles %s without starting later setup after a failure", failure => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cache = resolve(root, "outputs");
  mkdirSync(cache, { recursive: true });
  const temporary = mkdtempSync(join(cache, "l2-gate-"));
  const marker = join(temporary, "later-setup.txt");
  const output = join(temporary, "results.json");
  try {
    const config = pathToFileURL(join(root, "vitest.config.dev.ts")).href;
    const reporter = join(root, "test-dev/failFastReporter.ts").replace(/\\/g, "/");
    writeFileSync(join(temporary, "vitest.config.mts"), `import config from ${JSON.stringify(config)};
export default { ...config, test: { ...config.test,
  include: [${JSON.stringify(temporary.replace(/\\/g, "/") + "/*.dev.test.ts")}],
  reporters: ["json", ${JSON.stringify(reporter)}], outputFile: ${JSON.stringify(output)}
} };`);
    const before = failure === "setup" ? 'beforeAll(() => { throw new Error("fixture setup failure"); });'
      : failure === "collection" ? 'throw new Error("fixture collection failure");' : "";
    writeFileSync(join(temporary, "ruleRevisions.dev.test.ts"), `import { beforeAll, it, expect } from "vitest";
${before}
it("lifecycle", () => expect(true).toBe(${failure !== "assertion"}));`);
    writeFileSync(join(temporary, "other.dev.test.ts"), `import { beforeAll, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
beforeAll(() => writeFileSync(${JSON.stringify(marker)}, "ran"));
it("remaining suite", () => expect(true).toBe(true));`);
    const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", join(temporary, "vitest.config.mts")], {
      cwd: root, env: { ...process.env, CI: "true" }, encoding: "utf8", timeout: 15000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(failure === "success" ? 0 : 1);
    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(existsSync(marker)).toBe(failure === "success");
    if (failure === "success") expect(report.numPassedTests).toBe(2);
    else expect(report.testResults.some((file: { status: string }) => file.status === "failed")).toBe(true);
  } finally {
    if (dirname(temporary) !== cache) throw new Error("Unexpected test temporary directory");
    rmSync(temporary, { recursive: true, force: true });
  }
});
