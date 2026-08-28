// Matrix-drift check: COVERAGE-MATRIX.md's claims must match the actual test files.
// Coverage claims are generated-or-verified, never merely asserted (the IsNull lesson:
// the matrix said "pending deploy" long after the fix shipped, because nothing checked).
//
// Checks:
//  1. Every simple suite reference in the matrix resolves to a real test file
//     (`ruleBehaviorX` -> test-dev/ruleBehaviorX.dev.test.ts, `X.e2e` -> e2e/X.e2e.spec.ts).
//  2. Any matrix line claiming a skip ("it.skip" / "pending deploy" / "skipped pending")
//     must reference a suite that actually contains a `.skip`, otherwise the claim is stale.
//  3. Any actual `.skip` in test-dev/ or e2e/ must be recorded in the matrix (a line naming
//     that suite and containing "skip"), otherwise a live-proof gap is going unrecorded.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";

const MATRIX = "test-dev/ruleBehavior/COVERAGE-MATRIX.md";
const matrix = readFileSync(MATRIX, "utf8");
const matrixLines = matrix.split("\n");
const failures = [];

function suiteToFile(name) {
  if (name.endsWith(".e2e")) return `e2e/${name.slice(0, -4)}.e2e.spec.ts`;
  if (name.startsWith("ruleBehavior")) return `test-dev/${name}.dev.test.ts`;
  return null; // L1 suites and brace-expansion shorthand are out of scope
}

// 1. Suite references resolve.
const seen = new Set();
for (const m of matrix.matchAll(/`([A-Za-z]+(?:\.e2e)?)`/g)) {
  const file = suiteToFile(m[1]);
  if (file && !seen.has(file)) {
    seen.add(file);
    if (!existsSync(file)) failures.push(`matrix references \`${m[1]}\` but ${file} does not exist`);
  }
}

function fileHasSkip(file) {
  return /\b(?:it|test|describe)\.skip\s*\(/.test(readFileSync(file, "utf8"));
}

// 2. Skip claims in the matrix must be true.
const SKIP_CLAIM = /it\.skip|pending (?:re)?deploy|skipped pending/i;
matrixLines.forEach((line, i) => {
  if (!SKIP_CLAIM.test(line)) return;
  const refs = [...line.matchAll(/`([A-Za-z]+(?:\.e2e)?)`/g)]
    .map((m) => suiteToFile(m[1]))
    .filter((f) => f && existsSync(f));
  if (refs.length && !refs.some(fileHasSkip)) {
    failures.push(
      `${MATRIX}:${i + 1} claims a skip ("${line.trim().slice(0, 80)}…") but no referenced suite contains .skip (stale claim)`
    );
  }
});

// 3. Real skips must be recorded in the matrix.
for (const dir of ["test-dev", "e2e"]) {
  for (const entry of readdirSync(dir)) {
    if (!/\.(test|spec)\.tsx?$/.test(entry)) continue;
    const file = `${dir}/${entry}`;
    if (!fileHasSkip(file)) continue;
    const suite = basename(entry).replace(/\.dev\.test\.tsx?$/, "").replace(/\.e2e\.spec\.tsx?$/, ".e2e");
    const recorded = matrixLines.some((l) => l.includes(suite.replace(/\.e2e$/, "")) && /skip/i.test(l));
    if (!recorded) failures.push(`${file} contains .skip but ${MATRIX} does not record it for \`${suite}\``);
  }
}

if (failures.length) {
  console.error("matrix-drift check FAILED:\n" + failures.map((f) => `  ${f}`).join("\n"));
  process.exit(1);
}
console.log("matrix-drift check: OK (matrix claims match test files)");
