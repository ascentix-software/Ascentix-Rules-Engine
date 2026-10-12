import * as React from "react";
import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { TABLE_CONFIGS, TC_LIST } from "./nodeFilterFixtures";
import { NodeFilterBuilder } from "../../src/editor/ui/inspectors/NodeFilterBuilder";
import { emptyGroup, emptyLeaf, type NodeFilterGroupModel, type NodeFilterLeaf } from "../../src/editor/model/nodeFilter";

const META = fakeMetadata({
  account: [
    col({ logicalName: "name", displayName: "Account name" }),
    col({ logicalName: "createdon", displayName: "Created on", attributeType: "DateTime" }),
  ],
  contact: [col({ logicalName: "fullname", displayName: "Full name" })],
  account_line: [
    col({ logicalName: "closedon", displayName: "Closed on", attributeType: "DateTime" }),
    col({ logicalName: "label", displayName: "Label" }),
  ],
  account_note: [col({ logicalName: "body", displayName: "Body" })],
});

let latest: NodeFilterGroupModel | null = null;
function Harness({ initial }: { initial: NodeFilterGroupModel }) {
  const [value, setValue] = React.useState(initial);
  return (
    <NodeFilterBuilder table="account_line" tableConfigs={TABLE_CONFIGS} tcList={TC_LIST} currentNodeId="lines"
      value={value} onChange={(v) => { latest = v; setValue(v); }} />
  );
}

function renderWithLeaf(leaf: Partial<NodeFilterLeaf>) {
  latest = null;
  const initial: NodeFilterGroupModel = { ...emptyGroup(), rules: [{ ...emptyLeaf(), ...leaf }] };
  return renderWithMeta(<Harness initial={initial} />, META);
}

describe("NodeFilterBuilder date expressions", () => {
  it("offers Date expression for a date column and shows the date editor", async () => {
    renderWithLeaf({ column: "closedon", operator: 4 });
    fireEvent.click(await screen.findByRole("combobox", { name: "Filter value source" }));
    fireEvent.click(await screen.findByRole("option", { name: "Date expression" }));

    expect(await screen.findByRole("combobox", { name: "Anchor date" })).toBeInTheDocument();
    const leaf = latest!.rules[0] as NodeFilterLeaf;
    expect(leaf.valueSource).toBe(4);
  });

  it("does not offer Date expression for a text column", async () => {
    renderWithLeaf({ column: "label", operator: 1 });
    fireEvent.click(await screen.findByRole("combobox", { name: "Filter value source" }));
    await screen.findByRole("option", { name: "Literal" });
    expect(screen.queryByRole("option", { name: "Date expression" })).toBeNull();
  });

  it("stores the payload the engine parses", async () => {
    renderWithLeaf({ column: "closedon", operator: 4, valueSource: 4, value: null });
    fireEvent.click(await screen.findByRole("combobox", { name: "Anchor date" }));
    fireEvent.click(await screen.findByRole("option", { name: "When the rule runs" }));

    const leaf = latest!.rules[0] as NodeFilterLeaf;
    expect(JSON.parse(leaf.value!)).toMatchObject({ anchor: { kind: "now" } });
  });

  it("anchors on the rule's root record by its node", async () => {
    renderWithLeaf({ column: "closedon", operator: 3, valueSource: 4, value: null });
    fireEvent.click(await screen.findByRole("combobox", { name: "Anchor date" }));
    fireEvent.click(await screen.findByRole("option", { name: "Account → Created on" }));

    const leaf = latest!.rules[0] as NodeFilterLeaf;
    expect(JSON.parse(leaf.value!)).toMatchObject({ anchor: { kind: "field", node: "root", column: "createdon" } });
  });

  it("labels the filtered row's own dates as this row", async () => {
    renderWithLeaf({ column: "closedon", operator: 3, valueSource: 4, value: null });
    fireEvent.click(await screen.findByRole("combobox", { name: "Anchor date" }));
    fireEvent.click(await screen.findByRole("option", { name: "This row → Closed on" }));

    const leaf = latest!.rules[0] as NodeFilterLeaf;
    expect(JSON.parse(leaf.value!)).toMatchObject({ anchor: { kind: "field", node: null, column: "closedon" } });
  });

  it("Changing_the_column_resets_the_value_source", async () => {
    renderWithLeaf({ column: "closedon", operator: 4, valueSource: 4,
      value: JSON.stringify({ anchor: { kind: "now" }, op: "subtract", amount: 1, unit: "days" }) });
    fireEvent.click(await screen.findByRole("combobox", { name: "Filter column" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Label/ }));

    const leaf = latest!.rules[0] as NodeFilterLeaf;
    expect(leaf.column).toBe("label");
    expect(leaf.valueSource).toBe(1);
    expect(leaf.value).toBeNull();
  });
});
