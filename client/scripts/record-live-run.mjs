// Records a green live-suite run into live-runs.json. Wired behind `&&` in package.json
// (`test:dev` -> l2, `test:e2e` -> l3) so it only fires when the full suite passed.
// The file is committed; CI's staleness report reads it so "CI green" can't silently
// stand in for live-layer freshness.
import { readFileSync, writeFileSync } from "node:fs";
import { readEnvFile } from "./devOrg.mjs";

const layer = process.argv[2];
if (layer !== "l2" && layer !== "l3") {
  console.error("usage: node scripts/record-live-run.mjs <l2|l3>");
  process.exit(1);
}

// The org the run was against: the repo-root .env's DATAVERSE_URL (the DevOrg module's file
// layer; .env optional — org stays "unknown").
let org = "unknown";
try {
  const url = readEnvFile().DATAVERSE_URL;
  if (url) org = new URL(url).hostname;
} catch {
  /* malformed URL (org stays "unknown") */
}

const path = "live-runs.json";
let data = {};
try {
  data = JSON.parse(readFileSync(path, "utf8"));
} catch {
  /* first run */
}
data[layer] = { lastGreen: new Date().toISOString().slice(0, 10), org };
writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
console.log(`recorded ${layer} green: ${data[layer].lastGreen} (${org})`);
