// Skip-lint: every `.skip` in the test suites must carry an annotation with a reason,
// a tracking issue, and an expiry date. The expiry must be in the future.
//
//   // SKIP(<reason>, <issue-or-url>, expires: YYYY-MM-DD)
//   it.skip("…", async () => { … });
//
// Rationale: a skip is designed to never fail, so an unannotated skip is invisible rot.
// The IsNull live case sat skipped through two hardening PRs and a docs commit announcing
// the fix (see COVERAGE-MATRIX.md history). Missing annotation or expired date = red build.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["test", "test-dev", "e2e"];
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const SKIP_CALL = /\b(?:it|test|describe)\.skip\s*\(/;
const ANNOTATION = /SKIP\([^)]*expires:\s*(\d{4}-\d{2}-\d{2})\s*\)/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (TEST_FILE.test(entry.name)) yield p;
  }
}

const failures = [];
const today = new Date().toISOString().slice(0, 10);

for (const root of ROOTS) {
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue; // root missing in a partial checkout
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!SKIP_CALL.test(line)) return;
      // Look for the annotation on the skip line itself or up to 3 lines above.
      const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      const m = context.match(ANNOTATION);
      if (!m) {
        failures.push(`${file}:${i + 1}: .skip without a SKIP(reason, issue, expires: YYYY-MM-DD) annotation`);
      } else if (m[1] < today) {
        failures.push(`${file}:${i + 1}: SKIP annotation expired ${m[1]} (today: ${today})`);
      }
    });
  }
}

// Pipeline YAML: a test-file `--exclude` in a pipeline is a skip by another name, same rule.
// (Introduced for the channel-suite exclusion in templates/live-l2-job.yml, which is gated on
// the SERVICE_PRINCIPAL_* app-user provisioning.)
function* walkYml(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkYml(p);
    else if (/\.ya?ml$/.test(entry.name)) yield p;
  }
}
try {
  for (const file of walkYml("../pipelines")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("--exclude")) return;
      const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      const m = context.match(ANNOTATION);
      if (!m) {
        failures.push(`${file}:${i + 1}: pipeline --exclude without a SKIP(reason, issue, expires: YYYY-MM-DD) comment`);
      } else if (m[1] < today) {
        failures.push(`${file}:${i + 1}: pipeline exclusion's SKIP annotation expired ${m[1]} (today: ${today})`);
      }
    });
  }
} catch {
  /* pipelines dir missing in a partial checkout */
}

if (failures.length) {
  console.error("skip-lint FAILED:\n" + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log("skip-lint: OK (no unannotated or expired skips)");
