import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent, makeGraph, makeGroup } from "./domFixtures";
import { duplicateCondition, duplicateGroup } from "../../src/editor/model/reducer";
import { conditionSentence, rowCountPhrase } from "../../src/editor/ui/labels";
import { scheduleStripSummary, emptySchedule } from "../../src/editor/schedule/scheduleModel";
import { RuleSettingsStrip, DataModelChip } from "../../src/editor/ui/RuleSettingsStrip";
import { triggerList } from "../../src/editor/ui/GraphTree";
import type { ConditionNode, TableConfigRef } from "../../src/editor/model/types";

const cond = (over: Partial<ConditionNode> = {}): ConditionNode => ({
  id: "c1", name: "", tableConfigId: "root", conditionType: "FieldComparison",
  comparisonColumn: "estimatedvalue", comparisonOperator: 4, valueSource: 1, comparisonValue: "100000",
  comparisonValueColumn: null, comparisonValueNodeId: null, minExpectedRows: null, maxExpectedRows: null, ...over,
});
const node = (over: Partial<TableConfigRef>): TableConfigRef => ({
  id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable",
  parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null, ...over,
});
const tcs = { root: node({}), lines: node({ id: "lines", name: "Opportunity Lines", tableLogicalName: "opportunityproduct", tableConfigType: "ChildTable", parentTableConfigId: "root" }) };

describe("conditionSentence", () => {
  const meta = {
    rootNodeId: "root",
    columnLabel: (_t: string | null, l: string) => ({ estimatedvalue: "Est. Revenue", ownerid: "Approver" } as Record<string, string>)[l],
    columnType: (_t: string | null, l: string) => (l === "estimatedvalue" ? "Money" : undefined),
  };

  it("reads a comparison as a sentence with the display name and grouped digits", () => {
    const s = conditionSentence(cond(), tcs, { ...meta, currencySymbol: "$" });
    expect(s).toMatchObject({ field: "Est. Revenue", fieldLogical: "estimatedvalue", op: "is at least", value: "$100,000" });
    expect(s.nodeTag).toBeUndefined();
  });

  it("tags a condition on a node other than the root, and has no value for is empty", () => {
    const s = conditionSentence(cond({ tableConfigId: "lines", comparisonColumn: "ownerid", comparisonOperator: 9 }), tcs, meta);
    expect(s).toMatchObject({ nodeTag: "Opportunity Lines", field: "Approver", op: "is empty" });
    expect(s.value).toBeUndefined();
  });

  it("falls back to the logical name while metadata loads", () => {
    expect(conditionSentence(cond({ comparisonColumn: "name" }), tcs, { rootNodeId: "root" }).field).toBe("name");
  });

  it("phrases row counts", () => {
    expect(rowCountPhrase(1, null)).toEqual({ op: "has at least", value: "1 row" });
    expect(rowCountPhrase(null, 3)).toEqual({ op: "has at most", value: "3 rows" });
    expect(rowCountPhrase(2, 5)).toEqual({ op: "has between", value: "2 and 5 rows" });
    expect(rowCountPhrase(0, 0)).toEqual({ op: "has no rows" });
  });
});

describe("duplicate reducers", () => {
  it("duplicates a condition right after the original with a new temp id", () => {
    const g = makeGraph({ executionGroups: [makeGroup({ conditions: [cond({ id: "c1" }), cond({ id: "c2" })] })] });
    const next = duplicateCondition(g, "c1");
    const ids = next.executionGroups[0].conditions.map((c) => c.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("c1");
    expect(ids[1]).toMatch(/^new-/);
    expect(ids[2]).toBe("c2");
    expect(next.executionGroups[0].conditions[1].comparisonColumn).toBe("estimatedvalue");
  });

  it("duplicates an outcome with fresh ids throughout and a unique name", () => {
    const nested = makeGroup({ id: "n1", name: "Nested", parentGroupId: "o1", isExecutionCondition: false, conditions: [cond({ id: "c9" })] });
    const g = makeGraph({ validationGroups: [makeGroup({ id: "o1", name: "Approval gaps", isExecutionCondition: false, groups: [nested] })] });
    const next = duplicateGroup(g, "o1");
    expect(next.validationGroups.map((o) => o.name)).toEqual(["Approval gaps", "Approval gaps (copy)"]);
    const copy = next.validationGroups[1];
    expect(copy.id).toMatch(/^new-/);
    expect(copy.groups[0].id).toMatch(/^new-/);
    expect(copy.groups[0].parentGroupId).toBe(copy.id);
    expect(copy.groups[0].conditions[0].id).toMatch(/^new-/);
  });
});

describe("scheduleStripSummary", () => {
  it.each([
    [{ pattern: 4 as const, days: [4, 1], timeOfDay: "06:00" }, "Weekly Mon & Thu 06:00 UTC"],
    [{ pattern: 3 as const, timeOfDay: "06:00" }, "Daily 06:00 UTC"],
    [{ pattern: 2 as const, every: 2 }, "Every 2 hours"],
    [{ pattern: 5 as const, dayOfMonth: 1, timeOfDay: "06:00" }, "Monthly on day 1, 06:00 UTC"],
  ])("%o → %s", (over, text) => {
    expect(scheduleStripSummary({ ...emptySchedule(), on: true, ...over })).toBe(text);
  });
});

describe("triggerList", () => {
  it("joins with commas and a final and", () => {
    expect(triggerList([1, 4, 3])).toBe("on create, on update and on demand");
    expect(triggerList([1])).toBe("on create");
  });
});

describe("RuleSettingsStrip", () => {
  it("summarises table, triggers, schedule and channels, and opens on Enter", () => {
    const onOpen = vi.fn();
    const g = makeGraph();
    g.rule = { ...g.rule, triggers: [1, 3], onDemandScope: 2, channels: [] };
    renderWithFluent(<RuleSettingsStrip graph={g} editing={false} onOpen={onOpen}
      schedule={{ ...emptySchedule(), on: true, pattern: 3, timeOfDay: "06:00" }} />);
    const strip = screen.getByTestId("rule-settings-strip");
    expect(strip).toHaveTextContent("account · On create, On demand · Daily 06:00 UTC · All channels");
    expect(strip).toHaveTextContent("Edit");
    fireEvent.keyDown(strip, { key: "Enter" });
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("DataModelChip", () => {
  it("counts related tables and lists the model tree in its popover", async () => {
    const g = makeGraph({ tableConfigs: tcs });
    g.rule.rootTableConfigId = "root";
    const onEdit = vi.fn();
    renderWithFluent(<DataModelChip graph={g} sharedBy={3} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Data model: Opportunity, 1 related tables" }));
    expect(await screen.findByText("Data model · Opportunity")).toBeInTheDocument();
    expect(screen.getByText("HAS MANY")).toBeInTheDocument();
    expect(screen.getByText("· shared by 3 rules")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit data model" }));
    expect(onEdit).toHaveBeenCalled();
  });
});
