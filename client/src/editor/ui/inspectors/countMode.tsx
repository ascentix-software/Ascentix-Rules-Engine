import * as React from "react";
import { Dropdown, Option, Field, Input } from "@fluentui/react-components";

// Shared "count mode" UI: presents min/max row-count bounds as a friendlier mode dropdown
// ("At least one (exists)" / "None" / etc.) instead of raw min/max inputs. ONE source of truth
// for both RowCountEditor (ConditionInspector's RowCount condition type) and ExistsRow
// (NodeFilterBuilder's "Has related rows…" criterion): same labels, same seeding rules.
export type RowCountMode =
  | "atLeastOne" | "none" | "atLeast" | "atMost" | "exactly" | "between" | "custom";

export const ROWCOUNT_MODE_LABELS: Record<RowCountMode, string> = {
  atLeastOne: "At least one (exists)",
  none: "None (does not exist)",
  atLeast: "At least N",
  atMost: "At most N",
  exactly: "Exactly N",
  between: "Between N and M",
  custom: "Custom (min / max)",
};
export const ROWCOUNT_MODE_ORDER: RowCountMode[] =
  ["atLeastOne", "none", "atLeast", "atMost", "exactly", "between", "custom"];

// Derive the mode shown in the dropdown from the stored min/max. Both null (a fresh value)
// falls to "custom" so nothing is silently rewritten on load.
export function deriveRowCountMode(min: number | null, max: number | null): RowCountMode {
  if (min === 1 && max == null) return "atLeastOne";
  if (min == null && max === 0) return "none";
  if (min != null && max == null) return "atLeast";
  if (min == null && max != null) return "atMost";
  if (min != null && max != null && min === max) return "exactly";
  if (min != null && max != null) return "between";
  return "custom";
}

// Pure mapping from a chosen mode + current min/max to the new min/max. Extracted so every
// consumer (RowCountEditor, ExistsRow) applies IDENTICAL seeding rules when switching modes.
export function applyCountMode(
  mode: RowCountMode, min: number | null, max: number | null,
): { min: number | null; max: number | null } {
  const seed = min ?? max ?? 1;
  switch (mode) {
    case "atLeastOne": return { min: 1, max: null };
    case "none": return { min: null, max: 0 };
    // Seed ≥ 2: "at least 1" collapses to the atLeastOne mode (deriveRowCountMode), which would
    // snap the dropdown back and hide the count input the moment the user selects "At least N".
    case "atLeast": return { min: min != null && min > 1 ? min : max != null && max > 1 ? max : 2, max: null };
    case "atMost": return { min: null, max: seed };
    case "exactly": return { min: seed, max: seed };
    case "between": return {
      min: min ?? 1,
      max: max != null && max > (min ?? 1) ? max : (min ?? 1) + 1,
    };
    case "custom": return { min, max }; // keep current min/max, expose the raw inputs
  }
}

// Can `mode` still describe this stored pair? "exactly" and "between" are the only two modes
// that overlap (both want two non-null bounds), and that overlap is exactly what
// deriveRowCountMode cannot resolve on its own, which is why the author's choice has to break
// the tie rather than being recomputed from storage on every keystroke.
export function canExpress(mode: RowCountMode, min: number | null, max: number | null): boolean {
  switch (mode) {
    case "atLeastOne": return min === 1 && max == null;
    case "none": return min == null && max === 0;
    case "atLeast": return min != null && max == null;
    case "atMost": return min == null && max != null;
    case "exactly":
    case "between": return min != null && max != null;
    case "custom": return true;
  }
}

// Renders the mode Dropdown + the conditional numeric inputs. `min`/`max` are the stored
// bounds; `onChange` always receives the full (min, max) pair for the caller to patch.
export function CountModeFields({ min, max, onChange }: {
  min: number | null; max: number | null; onChange(min: number | null, max: number | null): void;
}) {
  // The displayed mode is the author's CHOICE, held here, not a pure function of the stored
  // pair. Deriving it on every render makes the dropdown snap while the author is still typing:
  // in "Between N and M", raising the Minimum to the current Maximum makes min === max for one
  // keystroke, deriveRowCountMode reports "exactly", and the two inputs collapse into one,
  // discarding the range mid-edit. (The sibling case is the `atLeast` seed >= 2 note in
  // applyCountMode, which addresses one symptom of the same cause.)
  //
  // The stored pair still WINS when it changes from outside (selecting another condition must
  // move the dropdown), so re-derive whenever the incoming pair is not the one we last emitted.
  const [chosen, setChosen] = React.useState<RowCountMode>(() => deriveRowCountMode(min, max));
  const lastEmitted = React.useRef<{ min: number | null; max: number | null } | null>(null);

  React.useEffect(() => {
    const mine = lastEmitted.current;
    if (mine && mine.min === min && mine.max === max) return; // our own edit, keep the choice
    setChosen(deriveRowCountMode(min, max));
  }, [min, max]);

  // Keep the author's mode while the stored pair can still express it; otherwise the choice is
  // stale (its inputs were cleared) and the data wins.
  const mode: RowCountMode = canExpress(chosen, min, max) ? chosen : deriveRowCountMode(min, max);

  const emit = (nextMin: number | null, nextMax: number | null) => {
    lastEmitted.current = { min: nextMin, max: nextMax };
    onChange(nextMin, nextMax);
  };

  const applyMode = (m: RowCountMode) => {
    const r = applyCountMode(m, min, max);
    setChosen(m);
    emit(r.min, r.max);
  };

  const numInput = (label: string, value: number | null, onNum: (n: number | null) => void) => (
    <Field label={label}>
      <Input type="number" value={value == null ? "" : String(value)}
        onChange={(_e, d) => onNum(d.value === "" ? null : Number(d.value))} />
    </Field>
  );

  return (
    <>
      <Field label="How many matching rows?">
        <Dropdown aria-label="Row count mode" value={ROWCOUNT_MODE_LABELS[mode]} selectedOptions={[mode]}
          onOptionSelect={(_e, d) => d.optionValue && applyMode(d.optionValue as RowCountMode)}>
          {ROWCOUNT_MODE_ORDER.map((m) => <Option key={m} value={m}>{ROWCOUNT_MODE_LABELS[m]}</Option>)}
        </Dropdown>
      </Field>
      {mode === "atLeast" && numInput("Count", min, (n) => emit(n, null))}
      {mode === "atMost" && numInput("Count", max, (n) => emit(null, n))}
      {mode === "exactly" && numInput("Count", min, (n) => emit(n, n))}
      {mode === "between" && (
        <>
          {numInput("Minimum", min, (n) => emit(n, max))}
          {numInput("Maximum", max, (n) => emit(min, n))}
        </>
      )}
      {mode === "custom" && (
        <>
          {numInput("Min expected rows", min, (n) => emit(n, max))}
          {numInput("Max expected rows", max, (n) => emit(min, n))}
        </>
      )}
    </>
  );
}
