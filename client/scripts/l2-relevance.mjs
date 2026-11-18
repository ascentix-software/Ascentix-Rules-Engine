// Decides whether a Client CI merge can change what live L2 runs, so Client CI queues L2 only
// when it can. L2 (vitest.config.dev.ts) loads the test-dev files, the seed script and the client
// modules they import. Those modules are found by bundling the same entry points with esbuild and
// reading its metafile, so a new import is picked up without editing a path list.
//
// Usage (from client/): node scripts/l2-relevance.mjs [--base <rev>] [--head <rev>]
// Prints the reason and, on Azure Pipelines, sets skipLiveL2=true only when no changed file is
// L2-relevant. Every other outcome (an error, a commit that isn't a merge) leaves it unset, so
// L2 is queued.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Repo-relative paths that make L2 relevant whatever esbuild finds: the suite and its config,
// dependency changes, and the pipeline files that run L2.
const ALWAYS = [
  /^client\/test-dev\//,
  /^client\/vitest\.config\.dev\.ts$/,
  /^client\/package(-lock)?\.json$/,
  /^client\/tsconfig[^/]*\.json$/,
  /^client\/scripts\/(seed-dev-fixtures|devOrg|l2-relevance)\.m?js$/,
  /^pipelines\/client-live\.yml$/,
  /^pipelines\/templates\//,
  /^pipelines\/Wait-DevDeploys\.ps1$/,
];

/**
 * The changed files (repo-relative, forward slashes) that can change what L2 runs.
 * @param {string[]} changed
 * @param {Set<string>} l2Inputs repo-relative paths of every file the L2 bundle reads
 * @returns {string[]}
 */
export function l2RelevantFiles(changed, l2Inputs) {
  return changed.filter(f => ALWAYS.some(re => re.test(f)) || l2Inputs.has(f));
}

function devTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return devTestFiles(p);
    return e.name.endsWith(".dev.test.ts") ? [p] : [];
  });
}

/** Repo-relative paths of every source file L2 loads, from an esbuild metafile. */
export async function l2Inputs() {
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: clientDir,
    entryPoints: [
      ...devTestFiles(join(clientDir, "test-dev")),
      join(clientDir, "test-dev", "failFastReporter.ts"),
      join(clientDir, "scripts", "seed-dev-fixtures.mjs"),
      join(clientDir, "vitest.config.dev.ts"),
    ],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outdir: "out",
    logLevel: "silent",
  });
  return new Set(Object.keys(result.metafile.inputs).map(p => `client/${p.replace(/\\/g, "/")}`));
}

function git(...args) {
  return execFileSync("git", args, { cwd: clientDir, encoding: "utf8" }).trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const head = arg("--head") ?? "HEAD";
  let base = arg("--base");
  if (!base) {
    // A merge commit's first parent is develop before the merge, so the diff is the merged PR.
    const parents = git("rev-list", "--parents", "-n", "1", head).split(" ").slice(1);
    if (parents.length < 2) {
      console.log(`${head} is not a merge commit. Queuing live L2.`);
      return;
    }
    base = parents[0];
  }
  const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const relevant = l2RelevantFiles(changed, await l2Inputs());
  if (relevant.length) {
    console.log(`L2-relevant changes:\n  ${relevant.join("\n  ")}\nQueuing live L2.`);
    return;
  }
  console.log(`No L2-relevant change in ${changed.length} changed file(s) (${base}..${head}). Not queuing live L2.`);
  if (process.env.TF_BUILD) console.log("##vso[task.setvariable variable=skipLiveL2]true");
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
  main().catch(err => {
    console.log(`##vso[task.logissue type=warning]L2 relevance check failed, queuing live L2: ${err?.message ?? err}`);
  });
}
