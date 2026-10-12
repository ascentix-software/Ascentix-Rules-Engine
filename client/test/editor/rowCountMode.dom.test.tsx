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

describe("ConditionInspector — Count rows", () => {
  const count = () => screen.findByRole("combobox", { name: "Count" });

  it("reads a stored minimum as has at least N row(s)", async () => {
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1 })} onPatch={() => {}} />, META);
    expect(await count()).toHaveTextContent("has at least");
    expect(screen.getByRole("spinbutton", { name: "Minimum rows" })).toHaveValue(1);
    expect(screen.getByText("row")).toBeInTheDocument();
  });

  it("selecting has no patches min=null, max=0", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1 })} onPatch={onPatch} />, META);
    fireEvent.click(await count());
    fireEvent.click(await screen.findByRole("option", { name: "has no" }));
    expect(onPatch).toHaveBeenLastCalledWith({ minExpectedRows: null, maxExpectedRows: 0 });
  });

  it("selecting has at most seeds from the stored count", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 3 })} onPatch={onPatch} />, META);
    fireEvent.click(await count());
    fireEvent.click(await screen.findByRole("option", { name: "has at most" }));
    expect(onPatch).toHaveBeenLastCalledWith({ minExpectedRows: null, maxExpectedRows: 3 });
    expect(screen.getByRole("spinbutton", { name: "Maximum rows" })).toHaveValue(3);
  });

  it("has between seeds distinct bounds and survives typing a minimum equal to the maximum", async () => {
    const onPatch = vi.fn();
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1 })} onPatch={onPatch} />, META);
    fireEvent.click(await count());
    fireEvent.click(await screen.findByRole("option", { name: "has between" }));
    expect(onPatch).toHaveBeenLastCalledWith({ minExpectedRows: 1, maxExpectedRows: 2 });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum rows" }), { target: { value: "2" } });
    expect(await count()).toHaveTextContent("has between");
    expect(screen.getByRole("spinbutton", { name: "Maximum rows" })).toHaveValue(2);
  });

  // The control must still follow the STORED value when it changes from outside the component
  // (selecting a different condition).
  it("re-derives when a different condition's min/max arrives", async () => {
    function Swapper() {
      const [c, setC] = React.useState(baseCondition({ minExpectedRows: 1, maxExpectedRows: 2 }));
      return (
        <>
          <button onClick={() => setC(baseCondition({ id: "c2", minExpectedRows: null, maxExpectedRows: 0 }))}>swap</button>
          <ConditionInspector condition={c} ruleTable="sample_order" tableConfigs={TABLE_CONFIGS} onPatch={() => {}} />
        </>
      );
    }
    renderWithMeta(<Swapper />, META);
    expect(await count()).toHaveTextContent("has between");
    fireEvent.click(screen.getByRole("button", { name: "swap" }));
    expect(await count()).toHaveTextContent("has no");
  });

  it("offers only collections in the Rows of picker", async () => {
    renderWithMeta(<Harness initial={baseCondition({ minExpectedRows: 1 })} onPatch={() => {}} />, META);
    fireEvent.click(await screen.findByRole("combobox", { name: "Rows of" }));
    expect(await screen.findByRole("option", { name: "Order lines" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Order" })).toBeNull();
  });
});
