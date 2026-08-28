import { test, expect } from "@playwright/test";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import { resolveAppId } from "./devHelpers";
import { openRuleFromHub, getEditorFrame } from "./editorHarness";

// Control-id uniqueness and label binding across the live editor frame.
//
// Fluent can generate control ids (`field-<n>__control`) that COLLIDE across the editor once
// several Field-wrapped controls are mounted at once. The consequence is not cosmetic: a
// `<label for>` then points at the wrong control, so the accessible name a screen reader
// announces belongs to some other field entirely.
//
// The two shapes of that, as they read in a browser with the record picker open over the
// condition inspector:
//   input#field-rr__control  (the "Advanced filter" checkbox)
//     aria-label: null, aria-labelledby: null
//     the <label for="field-rr__control"> on the page reads "Value"   <-- the inspector's
//                                                                          "Value" Field
// i.e. the Advanced-filter checkbox announces as "Value". The other shape is two DISTINCT
// comboboxes both carrying id="field-r10__control" (a strict-mode duplicate in the node-filter
// dialog), which is the same root cause and is invalid HTML besides.
//
// WCAG 4.1.2 (Name, Role, Value). a11y is a shipping gate here, alongside dialogA11y.e2e,
// contrast.dom and the L3 keyboard checks.

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long after a red run leaves orphans behind
  await sweepRuleBehaviorOrphans();
});
test.describe.configure({ timeout: 180_000 });

// Opens a rule, drills into a condition, and opens the record picker on top of the inspector,
// the state in which the collision was measured (many Field-wrapped controls mounted at once).
async function openPickerOverInspector(page: Parameters<typeof openRuleFromHub>[0], appId: string, ruleName: string) {
  const frame = await openRuleFromHub(page, appId, ruleName);
  await frame.getByRole("button", { name: /^\+\s?Condition$/ }).click();
  await frame.getByRole("button", { name: /^Edit condition/ }).click();
  const columnBox = frame.getByRole("combobox", { name: "Comparison column" });
  await columnBox.click();
  await columnBox.pressSequentially("customerid", { delay: 30 });
  await frame.getByRole("option", { name: /\(sample_customerid\)/ }).click();
  await frame.getByRole("button", { name: "Browse…" }).click();
  await frame.getByRole("checkbox").waitFor();
  return frame;
}

// The mechanism, which is why this needs a browser: the ids are not colliding useId values.
// Fluent's <Field> publishes { generatedControlId, labelId, … } on a React CONTEXT, and every
// field-aware control in the subtree adopts that id when it has none of its own. React context
// flows through portals, so a <Dialog> surface or a <Combobox> popup opened from inside a Field
// is still inside that Field for id purposes: the record picker (opened from <Field
// label="Value">) would hand the Value field's id to its own checkbox, and the node-filter dialog
// would hand one Field's id to two comboboxes. The barrier that stops it is <OutsideField>
// (src/editor/ui/fieldScope.tsx) at every dialog root and around each composite picker's
// secondary controls. jsdom models three shapes of the collision in
// test/editor/fluentFieldIds.dom.test.tsx. This holds the stricter bar only a real browser can
// measure (ZERO duplicate ids across the whole editor frame), so a regression that lets a portal
// re-adopt an outer Field's id fails here.
test("editor control ids are unique and labels bind to their own control", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_a11yid_${Math.random().toString(36).slice(2, 7)}`, rootNodeId: tc.order, triggers: "3",
    conditions: [], actions: [{ actionType: 3, fireOn: 1, message: "ZZ_RB a11y", severity: 1 }],
    publish: false, requireValid: false,
  });
  try {
    await openPickerOverInspector(page, appId, rule.ruleName);
    const f = getEditorFrame(page);

    const report = await f.evaluate(() => {
      const withId = Array.from(document.querySelectorAll<HTMLElement>("[id]"));
      const seen = new Map<string, number>();
      for (const el of withId) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
      const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

      const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const label = box?.id
        ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`)
        : null;
      return {
        duplicates,
        checkbox: {
          ariaLabel: box?.getAttribute("aria-label") ?? null,
          labelText: label ? (label.textContent ?? "").trim() : null,
          ownText: (box?.parentElement?.textContent ?? "").trim(),
        },
      };
    });

    // No two elements may share an id: that is what makes `label[for]` ambiguous.
    expect(report.duplicates).toEqual([]);

    // The Advanced-filter checkbox must be named by its OWN label, not by whatever Field
    // happened to win the id lottery.
    const name = report.checkbox.ariaLabel ?? report.checkbox.labelText;
    expect(name).toBe("Advanced filter");
  } finally {
    await rule.cleanup();
    await tc.cleanup();
  }
});
