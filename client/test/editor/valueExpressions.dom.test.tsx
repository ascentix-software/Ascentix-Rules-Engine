import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { DateExprEditor } from "../../src/editor/ui/valueExpressions";

describe("DateExprEditor sub-labels", () => {
  it("labels the anchor, op, amount, and unit fields", async () => {
    renderWithMeta(
      <DateExprEditor
        value={{ anchorKind: "now", anchorNode: null, anchorColumn: null, op: "add", amount: 1, unit: "days" }}
        ruleTable="account" tableConfigs={{}} onChange={() => {}} />,
      fakeMetadata({ account: [col({ logicalName: "createdon", displayName: "Created on", attributeType: "DateTime" })] }),
    );
    expect(await screen.findByText("Anchor")).toBeInTheDocument();
    expect(screen.getByText("Op")).toBeInTheDocument();
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("Unit")).toBeInTheDocument();
  });
});
