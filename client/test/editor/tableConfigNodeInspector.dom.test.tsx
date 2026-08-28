import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { TableConfigNodeInspector } from "../../src/editor/ui/inspectors/TableConfigNodeInspector";
import type { TableConfigRef } from "../../src/editor/model/types";
import { fakeMetadata, renderWithMeta } from "./metaFixtures";

const META = fakeMetadata({ account: [] });

function childNode(overrides: Partial<TableConfigRef> = {}): TableConfigRef {
  return {
    id: "lines", name: "Lines", tableLogicalName: "account_line", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid",
    lookupTargetIdAttribute: null,
    ...overrides,
  };
}

function rootNode(overrides: Partial<TableConfigRef> = {}): TableConfigRef {
  return {
    id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null,
    lookupTargetIdAttribute: null,
    ...overrides,
  };
}

describe("TableConfigNodeInspector", () => {
  it("shows the node's name in the Node name input", () => {
    renderWithMeta(<TableConfigNodeInspector node={childNode()} onRename={vi.fn()} />, META);
    expect(screen.getByDisplayValue("Lines")).toBeInTheDocument();
  });

  it("calls onRename with the new value when the node-name input changes", () => {
    const onRename = vi.fn();
    renderWithMeta(<TableConfigNodeInspector node={childNode()} onRename={onRename} />, META);
    fireEvent.change(screen.getByDisplayValue("Lines"), { target: { value: "Order lines" } });
    expect(onRename).toHaveBeenCalledWith("Order lines");
  });

  it("shows the canDelete reason and disables Delete node when deletion is blocked", () => {
    renderWithMeta(
      <TableConfigNodeInspector
        node={childNode()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        canDelete={{ ok: false, reason: "Has children" }}
      />,
      META,
    );
    expect(screen.getByText("Has children")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete node/i })).toBeDisabled();
  });

  it("calls onDelete when Delete node is clicked and deletion is allowed", () => {
    const onDelete = vi.fn();
    renderWithMeta(
      <TableConfigNodeInspector
        node={childNode()}
        onRename={vi.fn()}
        onDelete={onDelete}
        canDelete={{ ok: true }}
      />,
      META,
    );
    fireEvent.click(screen.getByRole("button", { name: /delete node/i }));
    expect(onDelete).toHaveBeenCalled();
  });

  it("renders no Delete node button for a root node", () => {
    renderWithMeta(
      <TableConfigNodeInspector node={rootNode()} onRename={vi.fn()} onDelete={vi.fn()} />,
      META,
    );
    expect(screen.queryByRole("button", { name: /delete node/i })).not.toBeInTheDocument();
  });
});
