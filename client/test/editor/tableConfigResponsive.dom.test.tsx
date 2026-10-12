import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TableConfigApp } from "../../src/editor/ui/TableConfigApp";
import { TableConfigTree } from "../../src/editor/ui/TableConfigTree";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import type { MetadataService } from "../../src/editor/metadata";
import type { RuleGraph, TableConfigRef } from "../../src/editor/model/types";
import type { EditorApi } from "../../src/editor/webapi";
import type { ConfigUsage } from "../../src/editor/load/tableConfigEditor";
import { withNarrowViewport } from "./domFixtures";

const metaStub: MetadataService = {
  tables: async () => [],
  columns: async () => [],
  optionSet: async () => [],
  globalOptionSet: async () => [],
  lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const apiStub = {} as EditorApi;

function makeGraph(): RuleGraph {
  const root: TableConfigRef = {
    id: "root", name: "Order", tableLogicalName: "sample_order", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  };
  return {
    rule: {
      id: "r", name: "R", tableLogicalName: "sample_order", statusCode: 1, etag: null, triggers: [], channels: [],
      effectiveFrom: null, effectiveTo: null, evaluationContext: null, rootTableConfigId: "root",
      triggerColumns: [],
    },
    executionGroups: [], validationGroups: [], actions: [], tableConfigs: { root },
  };
}

function makeGraphWithChild(): RuleGraph {
  const graph = makeGraph();
  const child: TableConfigRef = {
    id: "child", name: "Child", tableLogicalName: "sample_line", tableConfigType: "LookupTable",
    parentTableConfigId: "root", lookupColumnLogicalName: "sample_orderid", childLinkField: null,
    lookupTargetIdAttribute: "sample_orderid",
  };
  return { ...graph, tableConfigs: { ...graph.tableConfigs, child } };
}

function renderApp() {
  const graph = makeGraph();
  const usage: ConfigUsage = { rulesUsingCount: 2, usedNodeIds: new Set() };
  return render(
    <MetadataProvider service={metaStub}>
      <TableConfigApp
        initialGraph={graph}
        initialUsage={usage}
        api={apiStub}
        reload={async () => ({ graph, usage })}
      />
    </MetadataProvider>,
  );
}

function renderAppWithChild() {
  const graph = makeGraphWithChild();
  const usage: ConfigUsage = { rulesUsingCount: 2, usedNodeIds: new Set() };
  return render(
    <MetadataProvider service={metaStub}>
      <TableConfigApp
        initialGraph={graph}
        initialUsage={usage}
        api={apiStub}
        reload={async () => ({ graph, usage })}
      />
    </MetadataProvider>,
  );
}

// Same graph, but the child node is referenced by another rule: canDeleteConfigNode
// blocks the delete with a reason, and that reason must surface visibly, not just
// as a title tooltip.
function renderAppWithUsedChild() {
  const graph = makeGraphWithChild();
  const usage: ConfigUsage = { rulesUsingCount: 2, usedNodeIds: new Set(["child"]) };
  return render(
    <MetadataProvider service={metaStub}>
      <TableConfigApp
        initialGraph={graph}
        initialUsage={usage}
        api={apiStub}
        reload={async () => ({ graph, usage })}
      />
    </MetadataProvider>,
  );
}

describe("TableConfigApp responsive layout", () => {
  it("stacks the two-pane body vertically when narrow; the inspector becomes an overlay, not a second column", async () => {
    await withNarrowViewport(async () => {
      renderApp();
      const body = screen.getByTestId("tableconfig-body");
      expect(body.style.flexDirection).toBe("column");
      // With the sticky pane retired, the overlay isn't a layout column at rest:
      // the tree is the only child of the (now single-column) body.
      expect(body.children).toHaveLength(1);
      // The drawer hasn't opened yet, so its heading isn't in the document.
      expect(screen.queryByTestId("inspector-heading")).not.toBeInTheDocument();
      // Selecting a node opens the overlay and its heading appears.
      fireEvent.click(within(body).getByText("Order"));
      expect(screen.getByTestId("inspector-heading")).toHaveTextContent("Order");
    });
  });

  it("shows config properties at rest and full node editing on selection", () => {
    renderAppWithChild();
    // Resting content (nothing selected): what to do next, not an empty dash.
    expect(screen.getByText("Select a table to edit it")).toBeInTheDocument();
    // Select the child node in the tree; the panel switches to the full node editor.
    fireEvent.click(screen.getByText("Child"));
    expect(screen.getByTestId("inspector-heading")).toHaveTextContent("Child");
    // Full-fidelity content: the delete affordance exists. Scope to the inspector panel itself.
    const panel = screen.getByTestId("inspector-heading").parentElement!.parentElement!;
    expect(within(panel).getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("uses a tight (12px per depth) indent for the tree when narrow", async () => {
    await withNarrowViewport(async () => {
      const graph = makeGraphWithChild();
      const { container } = render(
        <MetadataProvider service={metaStub}>
          <TableConfigTree
            graph={graph}
            selection={null}
            handlers={{ onSelectNode: vi.fn(), onAddNode: vi.fn(), onDeleteNode: vi.fn() }}
            usedNodeIds={new Set()}
          />
        </MetadataProvider>,
      );
      const childRow = Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]")).find(
        (d) => d.getAttribute("aria-level") === "2",
      );
      expect(childRow).toBeTruthy();
      expect(childRow!.style.paddingLeft).toBe("22px"); // 10px row padding + 12px per level
    });
  });

  it("is an ARIA tree: levels, a single tabbable row, and arrow keys move focus", async () => {
    const graph = makeGraphWithChild();
    const onSelectNode = vi.fn();
    render(
      <MetadataProvider service={metaStub}>
        <TableConfigTree graph={graph} selection={null}
          handlers={{ onSelectNode, onAddNode: vi.fn(), onDeleteNode: vi.fn() }} usedNodeIds={new Set()} />
      </MetadataProvider>,
    );
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((r) => r.getAttribute("aria-level"))).toEqual(["1", "2"]);
    expect(rows.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(onSelectNode).toHaveBeenCalledWith(rows[1].getAttribute("data-node-id"));
    fireEvent.keyDown(rows[1], { key: "ArrowLeft" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowLeft" });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("drops the permanent shared-scope warning for a neutral Used by chip", () => {
    renderApp();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("SHARED")).toBeNull();
    expect(screen.getByRole("button", { name: /^Used by 2 rules/ })).toBeInTheDocument();
  });

  it("explains why an in-use node can't be deleted, visibly (not just a tooltip)", () => {
    renderAppWithUsedChild();
    fireEvent.click(screen.getByText("Child"));
    expect(screen.getByTestId("inspector-heading")).toHaveTextContent("Child");
    const panel = screen.getByTestId("inspector-heading").parentElement!.parentElement!;
    expect(within(panel).getAllByText(/^Can't delete: used by/).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});
