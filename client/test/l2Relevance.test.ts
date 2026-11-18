import { describe, it, expect } from "vitest";
import { l2Inputs, l2RelevantFiles } from "../scripts/l2-relevance.mjs";

// client/scripts/l2-relevance.mjs: Client CI queues live L2 only when a merge changes a file L2 loads.

describe("l2RelevantFiles", () => {
  const inputs = new Set(["client/src/editor/load/odata.ts", "client/src/editor/webapi.ts"]);

  it("keeps changed files the L2 bundle reads", () => {
    expect(l2RelevantFiles(["client/src/editor/load/odata.ts", "client/src/editor/ui/Hub.tsx"], inputs))
      .toEqual(["client/src/editor/load/odata.ts"]);
  });

  it("treats the suite, its config, dependencies and the L2 pipeline files as relevant", () => {
    const always = [
      "client/test-dev/ruleRuns.dev.test.ts",
      "client/vitest.config.dev.ts",
      "client/package-lock.json",
      "client/scripts/seed-dev-fixtures.mjs",
      "pipelines/templates/live-l2-job.yml",
      "pipelines/Wait-DevDeploys.ps1",
    ];
    expect(l2RelevantFiles(always, new Set())).toEqual(always);
  });

  it("finds nothing relevant in a UI, docs or web-resource change", () => {
    expect(l2RelevantFiles([
      "client/src/editor/ui/Hub.tsx",
      "docs/guide/images/hub.png",
      "pipelines/webresources.json",
      "client/test/hub.dom.test.tsx",
    ], inputs)).toEqual([]);
  });
});

describe("l2Inputs", () => {
  it("includes the client modules the L2 suite loads, transitive ones too, and not the editor screens", async () => {
    const inputs = await l2Inputs();
    expect(inputs).toContain("client/src/editor/load/odata.ts");
    expect(inputs).toContain("client/src/editor/runs/runDriver.ts");
    expect(inputs).toContain("client/src/editor/ui/errors.tsx"); // through runDriver
    expect(inputs).toContain("client/test-dev/ruleRuns.dev.test.ts");
    expect(inputs).not.toContain("client/src/editor/webapi.ts"); // type-only imports
    expect(inputs).not.toContain("client/src/editor/ui/HubApp.tsx");
    expect(inputs).not.toContain("client/src/editor/ui/RuleEditorApp.tsx");
  }, 20000);
});
