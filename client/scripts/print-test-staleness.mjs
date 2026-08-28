// Three-line test-staleness report for CI: one green number must not overstate safety.
// L1 runs in this pipeline; L2 (DEV contract) and L3 (Playwright) are live suites run
// outside CI — this prints when each was last green so staleness is visible, not laundered
// into a single badge. Print-only for now; release-tag gating on freshness arrives with
// the Tier B nightly pipeline.
import { readFileSync } from "node:fs";

let data = {};
try {
  data = JSON.parse(readFileSync("live-runs.json", "utf8"));
} catch {
  /* no recorded runs yet */
}

const fmt = (e) => (e ? `last green ${e.lastGreen} (${e.org})` : "NO RECORDED RUN");
const age = (e) => (e ? Math.floor((Date.now() - new Date(e.lastGreen).getTime()) / 86400000) : Infinity);

console.log("Test staleness:");
console.log(`  L1 (vitest):        green in this run`);
console.log(`  L2 (DEV contract):  ${fmt(data.l2)}`);
console.log(`  L3 (Playwright):    ${fmt(data.l3)}`);

for (const [layer, days] of [["L2", age(data.l2)], ["L3", age(data.l3)]]) {
  if (days > 2) {
    // Azure DevOps warning annotation; visible in the run summary without failing the build.
    console.log(`##vso[task.logissue type=warning]${layer} has not been green in ${days === Infinity ? "any recorded run" : days + " days"}`);
  }
}
