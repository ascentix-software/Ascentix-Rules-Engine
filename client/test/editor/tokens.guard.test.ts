import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI_ROOT = join(__dirname, "..", "..", "src", "editor", "ui");
/** tokens.ts is the single source of color; scripts/ is outside the app. */
const ALLOWED = new Set(["tokens.ts"]);
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

// Definition of done (spec §5): a screen is on-system when it adds ZERO new
// color literals. Active as of the completed sweep: B/C/D cannot regress the
// palette without failing here. The regex is deliberately comment-blind, which
// keeps the invariant crisp: the string "#rrggbb" appears in exactly one file.
describe("no hex literals outside tokens.ts", () => {
  it("every color routes through tokens.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(UI_ROOT)) {
      if (ALLOWED.has(relative(UI_ROOT, file))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const hit of line.match(HEX) ?? []) {
          offenders.push(`${relative(UI_ROOT, file)}:${i + 1} raw literal ${hit}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
