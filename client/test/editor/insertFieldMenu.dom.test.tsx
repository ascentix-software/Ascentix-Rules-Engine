import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { InsertFieldMenu } from "../../src/editor/ui/InsertFieldMenu";
import { fakeMetadata, renderWithMeta, col } from "./metaFixtures";

function harness(onInsert = vi.fn()) {
  const meta = fakeMetadata({
    account: [
      col({ logicalName: "name", displayName: "Name" }),
      col({ logicalName: "revenue", displayName: "Revenue" }),
    ],
  });
  renderWithMeta(
    <InsertFieldMenu ruleTable="account" tableConfigs={{}} onInsert={onInsert} />,
    meta,
  );
  return { onInsert };
}

describe("InsertFieldMenu", () => {
  it("renders the Insert field trigger", () => {
    harness();
    expect(screen.getByRole("button", { name: "Insert field" })).toBeInTheDocument();
  });

  it("opening This record lists the root-table columns", async () => {
    harness();
    fireEvent.click(screen.getByRole("button", { name: "Insert field" }));
    fireEvent.click(await screen.findByText("This record"));
    expect(await screen.findByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Revenue")).toBeInTheDocument();
  });

  it("clicking a column inserts its {root.<col>} token", async () => {
    const { onInsert } = harness();
    fireEvent.click(screen.getByRole("button", { name: "Insert field" }));
    fireEvent.click(await screen.findByText("This record"));
    fireEvent.click(await screen.findByText("Name"));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith("{root.name}");
  });
});
