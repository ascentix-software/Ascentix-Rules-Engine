import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// LOCAL-ONLY editor e2e (Layer 3). Never wired into CI. Requires a one-time
// interactive login (npm run test:e2e:auth) that writes e2e/.auth/state.json.
// (import.meta.url form: the client package is ESM, "type": "module", so
// CJS __dirname does not exist in config scope.)
const STORAGE_STATE = resolve(dirname(fileURLToPath(import.meta.url)), "e2e/.auth/state.json");

// ---- Execution order is declared here, not left to filename order ----
//
// These specs assert that a rule published moments ago actually enforces, which depends on its
// plugin step registration having propagated. Propagation degrades as the suite accumulates
// publish/delete churn against the same table, so the most exposed specs run first, against an
// unchurned org. That churn rate is a property of the suite, not a product risk.
//
// ruleLifecycleUnpublish goes first because it needs three registration transitions
// (publish -> Draft -> publish). The other enforcement specs follow, then everything else.
//
// Playwright orders files alphabetically, so a rename would silently reintroduce the failure.
// The projects below make the order explicit. `--project=editor` still runs the whole suite,
// because Playwright runs a project's dependencies first. Put any new propagation-sensitive
// spec in one of these lists rather than relying on its filename.

const LIFECYCLE_SPEC = ["**/ruleLifecycleUnpublish.e2e.spec.ts"];
const ENFORCEMENT_SPECS = [
  "**/authorToEnforce.e2e.spec.ts",
  "**/channelFormSave.e2e.spec.ts",
  "**/conditionNodeBinding.e2e.spec.ts",
];

const CHROME = { ...devices["Desktop Chrome"], storageState: STORAGE_STATE };

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.spec.ts",
  fullyParallel: false,          // one shared DEV org + one session
  workers: 1,
  retries: 0,                    // a real failure is a real signal
  timeout: 90_000,               // model-driven shell + web-resource load is slow
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  projects: [
    // The manual login step (run via `npm run test:e2e:auth`).
    { name: "auth", testMatch: "auth.setup.ts" },
    // Most propagation-sensitive spec first, on a completely unchurned table.
    { name: "lifecycle", testMatch: LIFECYCLE_SPEC, use: CHROME },
    // Then the rest of the enforcement-sensitive specs.
    { name: "enforcement", testMatch: ENFORCEMENT_SPECS, dependencies: ["lifecycle"], use: CHROME },
    // Everything else. `dependencies` makes Playwright run `enforcement` to completion first,
    // and testIgnore keeps these specs from running twice.
    {
      name: "editor",
      testMatch: "**/*.e2e.spec.ts",
      testIgnore: ["auth.setup.ts", ...LIFECYCLE_SPEC, ...ENFORCEMENT_SPECS],
      dependencies: ["enforcement"],
      use: CHROME,
    },
  ],
});
