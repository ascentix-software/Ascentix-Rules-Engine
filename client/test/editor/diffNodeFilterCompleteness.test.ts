import { describe, it, expect, beforeEach } from "vitest";
import { diffRuleGraph } from "../../src/editor/save/diff";
import { addGroup, addCondition, updateCondition } from "../../src/editor/model/reducer";
import { resetTempIds } from "../../src/editor/model/ids";
import { emptyBlock, emptyLeaf, type NodeFilterLeaf } from "../../src/editor/model/nodeFilter";
import type { RuleGraph } from "../../src/editor/model/types";

// Pins that diffRuleGraph never persists a half-finished filter row.
// (client/e2e/nodeFilterUi.e2e.spec.ts covers the same behaviour at the browser level.)
//
// Every filter block is SEEDED with one blank leaf, so a half-finished row is this editor's
// normal intermediate state. Persisting one writes an asx_nodefiltercriterion with a null
// column/operator, which Validate does not flag and which then makes NodeFilterEvaluator throw
// "Node filter criterion has no operator configured." on every subsequent write to the table.
// diffRuleGraph must therefore emit criteria only for COMPLETE leaves.

function baseGraph(): RuleGraph {
  return {
    rule: {
      id: "r1", name: "Rule", tableLogicalName: "sample_order", statusCode: 1, etag: 'W/"1"',
      triggers: [], channels: [], effectiveFrom: null, effectiveTo: null, evaluationContext: null,
      rootTableConfigId: "cfg-root", triggerColumns: [],
    },
    executionGroups: [],
    validationGroups: [],
    actions: [],
    tableConfigs: {
      "cfg-root": {
        id: "cfg-root", name: "Order", tableLogicalName: "sample_order",
        tableConfigType: "RootTable", parentTableConfigId: null,
        lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
      },
      "cfg-line": {
        id: "cfg-line", name: "Lines", tableLogicalName: "sample_orderline",
        tableConfigType: "ChildTable", parentTableConfigId: "cfg-root",
        lookupColumnLogicalName: null, childLinkField: "sample_orderid", lookupTargetIdAttribute: null,
      },
    },
  };
}
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));

const complete = (): NodeFilterLeaf => ({
  ...emptyLeaf(), column: "sample_lineamount", operator: 3, valueSource: 1, value: "100",
});

// Build a graph carrying one condition whose filter is a single block with `leaves`.
function graphWithFilterLeaves(leaves: NodeFilterLeaf[]): RuleGraph {
  let g = addGroup(clone(baseGraph()), "execution", null);
  const groupId = g.executionGroups[0].id;
  g = addCondition(g, groupId);
  const condId = g.executionGroups[0].conditions[0].id;
  const block = emptyBlock("cfg-line");
  block.root.rules = leaves;
  return updateCondition(g, condId, {
    conditionType: "RowCount", tableConfigId: "cfg-line", minExpectedRows: 1, filter: [block],
  });
}

const criterionCreates = (g: RuleGraph) =>
  diffRuleGraph(baseGraph(), g).filter(
    (o) => o.kind === "create" && o.entity === "asx_nodefiltercriterion",
  );

describe("diffRuleGraph — node-filter criterion completeness", () => {
  beforeEach(() => resetTempIds());

  it("does not persist the auto-seeded blank leaf", () => {
    expect(criterionCreates(graphWithFilterLeaves([emptyLeaf()]))).toEqual([]);
  });

  it("persists only the complete leaf when a blank seeded row sits beside it", () => {
    const ops = criterionCreates(graphWithFilterLeaves([emptyLeaf(), complete()]));
    expect(ops.length).toBe(1);
    expect((ops[0] as any).attrs.asx_fieldname).toBe("sample_lineamount");
    expect((ops[0] as any).attrs.asx_operator).toBe("gt");
  });

  it("drops a leaf with a column but no operator (mid-edit state)", () => {
    const half: NodeFilterLeaf = { ...emptyLeaf(), column: "sample_lineamount" };
    expect(criterionCreates(graphWithFilterLeaves([half]))).toEqual([]);
  });

  it("drops a leaf with a valued operator but no value", () => {
    const half: NodeFilterLeaf = { ...emptyLeaf(), column: "sample_lineamount", operator: 3 };
    expect(criterionCreates(graphWithFilterLeaves([half]))).toEqual([]);
  });

  it("keeps a valueless operator (IsNull) — it is complete without a value", () => {
    const isNull: NodeFilterLeaf = { ...emptyLeaf(), column: "sample_lineamount", operator: 9 };
    const ops = criterionCreates(graphWithFilterLeaves([isNull]));
    expect(ops.length).toBe(1);
    expect((ops[0] as any).attrs.asx_operator).toBe("null");
  });

  it("a block whose every leaf is incomplete writes NO group and NO criterion", () => {
    // isBlockEmpty already suppresses a wholly-blank block, so dropping its leaf must not leave
    // an orphan group row behind either.
    const ops = diffRuleGraph(baseGraph(), graphWithFilterLeaves([emptyLeaf()]))
      .filter((o) => o.kind === "create"
        && (o.entity === "asx_nodefiltergroup" || o.entity === "asx_nodefiltercriterion"));
    expect(ops).toEqual([]);
  });

  it("keeps the block's group when at least one leaf is complete", () => {
    const ops = diffRuleGraph(baseGraph(), graphWithFilterLeaves([emptyLeaf(), complete()]))
      .filter((o) => o.kind === "create" && o.entity === "asx_nodefiltergroup");
    expect(ops.length).toBe(1);
  });
});
