import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { ConditionInspector, deriveRowCountMode } from "../../src/editor/ui/inspectors/ConditionInspector";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

describe("deriveRowCountMode", () => {
  it("maps stored min/max to a mode", () => {
    expect(deriveRowCountMode(1, null)).toBe("atLeastOne");
    expect(deriveRowCountMode(null, 0)).toBe("none");
    expect(deriveRowCountMode(2, null)).toBe("atLeast");
    expect(deriveRowCountMode(null, 3)).toBe("atMost");
    expect(deriveRowCountMode(5, 5)).toBe("exactly");
    expect(deriveRowCountMode(2, 4)).toBe("between");
    expect(deriveRowCountMode(null, null)).toBe("custom");
  });
});

function baseCondition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Line count", tableConfigId: "lines", conditionType: "RowCount",
    comparisonColumn: null, comparisonOperator: null, valueSource: null,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null, filter: null,
    ...over,
  };
}

const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Order", tableLogicalName: "sample_order", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  lines: {
    id: "lines", name: "Order lines", tableLogicalName: "sample_orderline", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "sample_orderid", lookupTargetIdAttribute: null,
  },
};

const META = fakeMetadata({
  sample_order: [col({ logicalName: "name", displayName: "Name" })],
  sample_orderline: [col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" })],
});

function Harness({ initial, onPatch }: { initial: ConditionNode; onPatch(p: Partial<ConditionNode>): void }) {
  const [condition, setCondition] = React.useState(initial);
  return (
    <ConditionInspector
      condition={condition} ruleTable="sample_order" tableConfigs={TABLE_CONFIGS}
      onPatch={(p) => { onPatch(p); setCondition((c) => ({ ...c, ...p })); }}
    />
  );
}

describe("ConditionInspector — RowCount count mode", () => {
  it("shows the derived mode for a stored min/max ('exists')", async () => {
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1, maxExpectedRows: null })} onPatch={() => {}} />, META);
    const modeBox = await screen.findByRole("combobox", { name: "Row count mode" });
    expect(modeBox).toHaveTextContent("At least one (exists)");
  });

  it("selecting 'None' patches min=null, max=0", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1, maxExpectedRows: null })} onPatch={onPatch} />, META);
    fireEvent.click(await screen.findByRole("combobox", { name: "Row count mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "None (does not exist)" }));
    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: null, maxExpectedRows: 0 });
  });

  it("selecting 'At least one' patches min=1, max=null", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: null, maxExpectedRows: 3 })} onPatch={onPatch} />, META);
    fireEvent.click(await screen.findByRole("combobox", { name: "Row count mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "At least one (exists)" }));
    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: 1, maxExpectedRows: null });
  });

  it("'Exactly N' shows a single count input reflecting the stored value", async () => {
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 3, maxExpectedRows: 3 })} onPatch={() => {}} />, META);
    const modeBox = await screen.findByRole("combobox", { name: "Row count mode" });
    expect(modeBox).toHaveTextContent("Exactly N");
    expect(screen.getByRole("spinbutton", { name: "Count" })).toHaveValue(3);
  });

  // Regression: "At least N" must seed >= 2, else deriveRowCountMode(1,null) snaps back to
  // "At least one" and the count input vanishes, making the mode unreachable from a fresh condition.
  it("'At least N' from a fresh condition sticks (seeds 2, keeps the count input)", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition()} onPatch={onPatch} />, META); // both null -> custom
    fireEvent.click(await screen.findByRole("combobox", { name: "Row count mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "At least N" }));
    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: 2, maxExpectedRows: null });
    expect(await screen.findByRole("combobox", { name: "Row count mode" })).toHaveTextContent("At least N");
    expect(screen.getByRole("spinbutton", { name: "Count" })).toHaveValue(2);
  });

  it("'At most N' from a fresh condition sticks", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition()} onPatch={onPatch} />, META);
    fireEvent.click(await screen.findByRole("combobox", { name: "Row count mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "At most N" }));
    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: null, maxExpectedRows: 1 });
    expect(await screen.findByRole("combobox", { name: "Row count mode" })).toHaveTextContent("At most N");
  });

  it("'Between N and M' seeds distinct min/max (does not collapse to Exactly)", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition()} onPatch={onPatch} />, META);
    fireEvent.click(await screen.findByRole("combobox", { name: "Row count mode" }));
    fireEvent.click(await screen.findByRole("option", { name: "Between N and M" }));
    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: 1, maxExpectedRows: 2 });
    expect(await screen.findByRole("combobox", { name: "Row count mode" })).toHaveTextContent("Between N and M");
  });

  // The mode must NOT be re-derived from the STORED pair on every render: if it is, typing a
  // Minimum that transiently equals the Maximum satisfies `min === max` and snaps the dropdown
  // to "Exactly N", collapsing the two inputs into one and discarding the range the author is
  // halfway through entering. Same class as the "At least N" case above; the browser-level
  // counterpart is client/e2e/conditionTypesUi.e2e.spec.ts.
  it("'Between N and M' survives typing a Minimum equal to the Maximum", async () => {
    const onPatch = vi.fn();
    renderWithMeta(
      <Harness initial={baseCondition({ minExpectedRows: 1, maxExpectedRows: 2 })} onPatch={onPatch} />,
      META,
    );
    const modeBox = await screen.findByRole("combobox", { name: "Row count mode" });
    expect(modeBox).toHaveTextContent("Between N and M");

    // Raise the minimum to the current maximum: the author's next keystroke would be the max.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum" }), { target: { value: "2" } });

    expect(onPatch).toHaveBeenCalledWith({ minExpectedRows: 2, maxExpectedRows: 2 });
    // The editor must STAY in Between and keep BOTH inputs mounted.
    expect(await screen.findByRole("combobox", { name: "Row count mode" })).toHaveTextContent("Between N and M");
    expect(screen.getByRole("spinbutton", { name: "Minimum" })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: "Maximum" })).toHaveValue(2);

    // ...and finishing the range still works.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum" }), { target: { value: "5" } });
    expect(onPatch).toHaveBeenLastCalledWith({ minExpectedRows: 2, maxExpectedRows: 5 });
  });

  // The dropdown must still follow the STORED value when it changes from outside the component
  // (selecting a different condition), otherwise pinning the mode in state would strand it.
  it("re-derives the mode when a different condition's min/max arrives", async () => {
    // Swap the whole condition from outside, the way selecting another node does.
    function Swapper() {
      const [c, setC] = React.useState(baseCondition({ minExpectedRows: 1, maxExpectedRows: 2 }));
      return (
        <>
          <button onClick={() => setC(baseCondition({ id: "c2", minExpectedRows: 1, maxExpectedRows: null }))}>
            swap
          </button>
          <ConditionInspector condition={c} ruleTable="sample_order"
            tableConfigs={TABLE_CONFIGS} onPatch={() => {}} />
        </>
      );
    }
    renderWithMeta(<Swapper />, META);
    expect(await screen.findByRole("combobox", { name: "Row count mode" })).toHaveTextContent("Between N and M");

    fireEvent.click(screen.getByRole("button", { name: "swap" }));
    expect(await screen.findByRole("combobox", { name: "Row count mode" }))
      .toHaveTextContent("At least one (exists)");
  });

  it("hides the filter hint for a RowCount on a non-child (root) node", async () => {
    renderWithMeta(<Harness initial={baseCondition({ tableConfigId: "root", minExpectedRows: 1 })} onPatch={() => {}} />, META);
    await screen.findByRole("combobox", { name: "Row count mode" });
    expect(screen.queryByText(/count only the rows that match a filter/)).toBeNull();
  });
});
