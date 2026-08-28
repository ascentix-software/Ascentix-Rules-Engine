import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { ConditionInspector, visibleOperatorsForExpression } from "../../src/editor/ui/inspectors/ConditionInspector";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

function baseCondition(over: Partial<ConditionNode> = {}): ConditionNode {
  return {
    id: "c1", name: "Calc", tableConfigId: null, conditionType: null,
    comparisonColumn: null, comparisonOperator: null, valueSource: null,
    comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
    minExpectedRows: null, maxExpectedRows: null, expression: null,
    ...over,
  };
}

const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  lines: {
    id: "lines", name: "Order lines", tableLogicalName: "account_line", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid", lookupTargetIdAttribute: null,
  },
};

const META = fakeMetadata({
  account: [col({ logicalName: "creditlimit", displayName: "Credit Limit", attributeType: "Money" })],
  account_line: [col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" })],
});

describe("ConditionInspector — Calculation (Expression) condition kind", () => {
  it("renders the shared MathExprEditor, a numeric-only operator dropdown, and the RHS value editor", async () => {
    const onPatch = vi.fn();
    renderWithMeta(
      <ConditionInspector condition={baseCondition({ conditionType: "Expression" })} ruleTable="account"
        tableConfigs={TABLE_CONFIGS} onPatch={onPatch} />,
      META,
    );

    // Distinguishing DOM for the shared MathExprEditor (LHS): Insert-field / Insert-aggregate controls.
    expect(await screen.findByText("Insert field")).toBeInTheDocument();
    expect(screen.getByText("Insert aggregate")).toBeInTheDocument();

    // Numeric-only operator dropdown. No live choice map is wired in this harness, so labels
    // fall back to humanize(token), e.g. "GreaterThanOrEqual" -> "Greater Than Or Equal".
    const opBox = screen.getByRole("combobox", { name: "Operator" });
    fireEvent.click(opBox);
    expect(await screen.findByRole("option", { name: "Greater Than Or Equal" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Contains" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Is Null" })).toBeNull();

    // RHS comparison-value editor, reused verbatim from FieldComparison (Value source + literal Input).
    expect(screen.getByRole("combobox", { name: "Value source" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("value")).toBeInTheDocument();
  });

  it("edits go through onChange/onPatch for expression and operator", async () => {
    const onPatch = vi.fn();
    renderWithMeta(
      <ConditionInspector condition={baseCondition({ conditionType: "Expression" })} ruleTable="account"
        tableConfigs={TABLE_CONFIGS} onPatch={onPatch} />,
      META,
    );
    const textarea = await screen.findByPlaceholderText(/Insert field/);
    fireEvent.change(textarea, { target: { value: "{root.creditlimit} * 2" } });
    expect(onPatch).toHaveBeenCalledWith({ expression: "{root.creditlimit} * 2" });

    const opBox = screen.getByRole("combobox", { name: "Operator" });
    fireEvent.click(opBox);
    fireEvent.click(await screen.findByRole("option", { name: "Greater Than Or Equal" }));
    expect(onPatch).toHaveBeenCalledWith({ comparisonOperator: 4 });
  });
});

describe("visibleOperatorsForExpression", () => {
  it("is restricted to the six numeric operators", () => {
    expect(visibleOperatorsForExpression().map((o) => o.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
