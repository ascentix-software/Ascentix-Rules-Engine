import * as React from "react";
import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { MathExprEditor } from "../../src/editor/ui/valueExpressions";
import type { TableConfigRef } from "../../src/editor/model/types";
import type { NodeFilterGroupModel } from "../../src/editor/model/nodeFilter";

// A valid node id (aggregates in mathExpr must reference a saved GUID or a "new-" temp id, per
// MathExpr.ts's parseAggArg, so unlike ConditionInspector's node-filter fixtures, this
// can't just be "lines").
const CHILD_ID = "22222222-2222-2222-2222-222222222222";

const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  [CHILD_ID]: {
    id: CHILD_ID, name: "Order lines", tableLogicalName: "account_line", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid", lookupTargetIdAttribute: null,
  },
};

const META = fakeMetadata({
  account: [col({ logicalName: "name", displayName: "Account name" })],
  account_line: [col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" })],
});

// Stateful harness, mirroring how FieldMappingDialog wires MathExprEditor: expression + filters
// both live in parent state, updated via onChange/onFiltersChange. `onFiltersChangeSpy`, when
// given, is called with every value onFiltersChange receives (in addition to updating state) so
// tests can assert on calls that never produce a subsequent render change (e.g. a call that
// would drop a key that's about to be pruned right back).
function Harness({ initialExpression, initialFilters, onFiltersChangeSpy }: {
  initialExpression: string;
  initialFilters: Record<string, NodeFilterGroupModel>;
  onFiltersChangeSpy?(next: Record<string, NodeFilterGroupModel>): void;
}) {
  const [expression, setExpression] = React.useState(initialExpression);
  const [filters, setFilters] = React.useState(initialFilters);
  return (
    <MathExprEditor value={expression} ruleTable="account" tableConfigs={TABLE_CONFIGS}
      onChange={setExpression} filters={filters}
      onFiltersChange={(next) => { onFiltersChangeSpy?.(next); setFilters(next); }} />
  );
}

function expressionTextarea() {
  return screen.getByPlaceholderText(/Insert field/) as HTMLTextAreaElement;
}

describe("MathExprEditor — Filters on aggregates", () => {
  it("renders a chip row for the sum aggregate with an Only rows where… button", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    expect(await screen.findByRole("button", { name: /only rows where/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /only rows where.*no filter/i })).toBeInTheDocument();
  });

  it("clicking Only rows where… opens the modal with a NodeFilterBuilder on the child table", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    fireEvent.click(await screen.findByRole("button", { name: /only rows where/i }));
    expect(await screen.findByRole("combobox", { name: "Filter column" })).toBeInTheDocument();

    // The builder is scoped to the child (account_line) table: its column picker offers
    // Amount, not the root Account's columns.
    fireEvent.click(screen.getByRole("combobox", { name: "Filter column" }));
    expect(await screen.findByRole("option", { name: /^Amount/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Account name/ })).toBeNull();
  });

  it("adding a criterion + Apply rewrites the expression to include filter:f1 and stores filters.f1", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    fireEvent.click(await screen.findByRole("button", { name: /only rows where/i }));

    const colBox = await screen.findByRole("combobox", { name: "Filter column" });
    fireEvent.click(colBox);
    fireEvent.click(await screen.findByRole("option", { name: /^Amount/ }));

    const opBox = screen.getByRole("combobox", { name: "Filter operator" });
    fireEvent.click(opBox);
    fireEvent.click(await screen.findByRole("option", { name: "Greater than" }));

    const valueBox = await screen.findByRole("textbox", { name: "Filter value" });
    fireEvent.change(valueBox, { target: { value: "100" } });

    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    // Modal closes.
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Filter column" })).toBeNull());

    // Expression rewritten with the allocated filter key…
    expect(expressionTextarea()).toHaveValue(`sum(node:${CHILD_ID}.amount filter:f1)`);
    // …and the filter map/summary reflect the new criterion, rendered inside the button label.
    expect(screen.getByRole("button", { name: /only rows where.*1 condition/i })).toBeInTheDocument();
  });

  it("removing the filter strips filter:f1 from the expression and drops filters.f1", async () => {
    const filled: NodeFilterGroupModel = {
      kind: "group", id: "g1", op: "and",
      rules: [{
        kind: "rule", id: "r1", column: "amount", operator: 3,
        valueSource: 1, value: "100", valueNodeId: null, valueColumn: null,
      }],
    };
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount filter:f1)`} initialFilters={{ f1: filled }} />,
      META,
    );

    expect(await screen.findByRole("button", { name: /only rows where.*1 condition/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));

    await waitFor(() => expect(expressionTextarea()).toHaveValue(`sum(node:${CHILD_ID}.amount)`));
    expect(screen.getByRole("button", { name: /only rows where.*no filter/i })).toBeInTheDocument();
  });

  it("does not drop filters.f1 while the expression is transiently unparseable but still textually references filter:f1", async () => {
    const filled: NodeFilterGroupModel = {
      kind: "group", id: "g1", op: "and",
      rules: [{
        kind: "rule", id: "r1", column: "amount", operator: 3,
        valueSource: 1, value: "100", valueNodeId: null, valueColumn: null,
      }],
    };
    const calls: Record<string, NodeFilterGroupModel>[] = [];
    // Mid-typing state: a trailing "+" with no right operand makes the whole expression fail
    // to parse (parseMathExpr returns ok: false), even though "filter:f1" is still present in
    // the text. Before the fix, the prune effect derived its live-key set from parseMathExpr's
    // refs, which are empty on a parse failure, wiping filters to {}.
    renderWithMeta(
      <Harness
        initialExpression={`sum(node:${CHILD_ID}.amount filter:f1) +`}
        initialFilters={{ f1: filled }}
        onFiltersChangeSpy={(next) => calls.push(next)}
      />,
      META,
    );

    // Give the prune effect (and any other effects) a chance to run.
    await waitFor(() => expect(expressionTextarea()).toHaveValue(`sum(node:${CHILD_ID}.amount filter:f1) +`));

    // onFiltersChange must never have been called with a map that dropped f1, i.e. either it
    // was never called, or every call it did receive still has f1.
    expect(calls.every((c) => "f1" in c)).toBe(true);
  });
});

describe("MathExprEditor — Aggregates chip section", () => {
  it("renders a chip row per aggregate with the collection Pill", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    const rows = await screen.findAllByTestId("agg-chip-row");
    expect(rows).toHaveLength(1);
    // Both the Pill and the "Aggregate collection" Dropdown's selected-value text read
    // "Order lines". Narrow to the Pill's own <span>.
    const pill = within(rows[0]).getAllByText("Order lines").find((el) => el.tagName === "SPAN");
    expect(pill).toBeDefined();
    expect(pill!.style.backgroundColor).toBe("rgb(230, 244, 242)");
  });

  it("editing the second of two identical aggregates leaves the first untouched", async () => {
    renderWithMeta(
      <Harness
        initialExpression={`sum(node:${CHILD_ID}.amount) + sum(node:${CHILD_ID}.amount)`}
        initialFilters={{}}
      />,
      META,
    );
    const rows = await screen.findAllByTestId("agg-chip-row");
    expect(rows).toHaveLength(2);

    fireEvent.click(within(rows[1]).getByRole("combobox", { name: "Aggregate function" }));
    fireEvent.click(await screen.findByRole("option", { name: "avg" }));

    await waitFor(() => expect(expressionTextarea()).toHaveValue(
      `sum(node:${CHILD_ID}.amount) + avg(node:${CHILD_ID}.amount)`,
    ));
  });

  it("chips disable while the expression is transiently unparseable, and filters survive", async () => {
    const filled: NodeFilterGroupModel = {
      kind: "group", id: "g1", op: "and",
      rules: [{
        kind: "rule", id: "r1", column: "amount", operator: 3,
        valueSource: 1, value: "100", valueNodeId: null, valueColumn: null,
      }],
    };
    const calls: Record<string, NodeFilterGroupModel>[] = [];
    renderWithMeta(
      <Harness
        initialExpression={`sum(node:${CHILD_ID}.amount filter:f1)`}
        initialFilters={{ f1: filled }}
        onFiltersChangeSpy={(next) => calls.push(next)}
      />,
      META,
    );

    // Establish the last-good row before breaking the parse.
    expect(await screen.findAllByTestId("agg-chip-row")).toHaveLength(1);

    fireEvent.change(expressionTextarea(), {
      target: { value: `sum(node:${CHILD_ID}.amount filter:f1) +` },
    });
    await waitFor(() => expect(expressionTextarea())
      .toHaveValue(`sum(node:${CHILD_ID}.amount filter:f1) +`));

    // The row survives (last-good), just disabled, never wiped mid-keystroke.
    const rows = await screen.findAllByTestId("agg-chip-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByRole("combobox", { name: "Aggregate function" })).toBeDisabled();

    // Filters map still carries f1 through the transient parse failure.
    expect(calls.every((c) => "f1" in c)).toBe(true);
  });

  it("switching a sum row's fn to count keeps the section enabled (no arity corruption)", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    const rows = await screen.findAllByTestId("agg-chip-row");
    expect(rows).toHaveLength(1);

    fireEvent.click(within(rows[0]).getByRole("combobox", { name: "Aggregate function" }));
    fireEvent.click(await screen.findByRole("option", { name: "count" }));

    // The rewritten expression drops the column and stays parseable: count(node:<id>), not
    // the corrupted count(node:<id>.amount) an arity-blind rewrite would have produced.
    await waitFor(() => expect(expressionTextarea()).toHaveValue(`count(node:${CHILD_ID})`));

    // parsed.ok stayed true throughout: the chip row survives with its dropdowns enabled,
    // not disabled the way the last-good/inert-rows path renders a transient parse failure.
    const rowsAfter = await screen.findAllByTestId("agg-chip-row");
    expect(rowsAfter).toHaveLength(1);
    expect(within(rowsAfter[0]).getByRole("combobox", { name: "Aggregate function" })).not.toBeDisabled();
    expect(within(rowsAfter[0]).getByRole("combobox", { name: "Aggregate collection" })).not.toBeDisabled();
  });

  it("'Only rows where…' opens the grouped-spine filter dialog", async () => {
    renderWithMeta(
      <Harness initialExpression={`sum(node:${CHILD_ID}.amount)`} initialFilters={{}} />, META,
    );
    const rows = await screen.findAllByTestId("agg-chip-row");
    fireEvent.click(within(rows[0]).getByRole("button", { name: /only rows where/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("nf-root")).toBeInTheDocument();
  });
});
