import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
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
    // Resting content (selection.kind === "rule"): config-level info, not an empty dash.
    expect(screen.getByTestId("inspector-heading")).toHaveTextContent(/configuration/i);
    // Select the child node in the tree; the panel switches to the full node editor.
    fireEvent.click(screen.getByText("Child"));
    expect(screen.getByTestId("inspector-heading")).toHaveTextContent("Child");
    // Full-fidelity content: the delete affordance exists (the old shared branch dropped it).
    // Scope to the inspector panel itself: the tree row also renders its own (icon-only)
    // delete button for the same node, which would otherwise collide on an unscoped query.
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
      const childRow = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
        (d) => d.textContent?.includes("Child") && d.style.marginLeft !== "",
      );
      expect(childRow).toBeTruthy();
      expect(childRow!.style.marginLeft).toBe("12px");
    });
  });

  it("announces the shared-scope warning and renders SHARED as an amber Pill", () => {
    renderApp();
    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent(/shared by .* rules/i);
    const shared = screen.getByText("SHARED");
    expect(shared.style.backgroundColor).toBe("rgb(253, 246, 227)"); // warnTint: Pill, amber
  });

  it("narrow: the Properties button opens the overlay with config info", async () => {
    await withNarrowViewport(async () => {
      renderApp();
      fireEvent.click(screen.getByRole("button", { name: "Properties" }));
      await waitFor(() => expect(screen.getByTestId("inspector-heading")).toHaveTextContent(/configuration/i));
    });
  });

  it("explains why an in-use node can't be deleted, visibly (not just a tooltip)", () => {
    renderAppWithUsedChild();
    fireEvent.click(screen.getByText("Child"));
    expect(screen.getByTestId("inspector-heading")).toHaveTextContent("Child");
    // Scope to the inspector panel: the page also carries an unrelated shared-scope
    // warning (role="alert"), which would otherwise collide with an unscoped query.
    const panel = screen.getByTestId("inspector-heading").parentElement!.parentElement!;
    expect(within(panel).getByText(/in use/i)).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});
