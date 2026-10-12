import { describe, it, expect, beforeEach } from "vitest";
import { describeChanges } from "../../src/editor/ui/ReviewChangesDialog";
import { resetTempIds, newTempId } from "../../src/editor/model/ids";
import { makeAction, makeGraph, makeGroup } from "./domFixtures";
import type { RuleGraph } from "../../src/editor/model/types";

const outcome = (id: string, name: string) => makeGroup({ id, name, isExecutionCondition: false });
const clone = (g: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(g));

describe("describeChanges", () => {
  beforeEach(() => resetTempIds());

  it("labels Fires when rows, and titles each test with the outcome it tests", () => {
    const snapshot = makeGraph({
      validationGroups: [outcome("o1", "High value"), outcome("o2", "At risk")],
      actions: [makeAction({ id: "a1", name: "Block save", firesWhen: {
        id: "fg-root", op: "all", groups: [], tests: [{ id: "ft-1", outcomeId: "o1", expected: true }],
      } })],
    });
    const working = clone(snapshot);
    const groupId = newTempId();
    const testId = newTempId();
    working.actions[0].firesWhen = {
      id: "fg-root", op: "all", tests: [],
      groups: [{ id: groupId, op: "any", groups: [], tests: [{ id: testId, outcomeId: "o2", expected: false }] }],
    };

    const text = describeChanges(snapshot, working);

    expect(text).toContain("DELETE Fires when test: High value");
    expect(text).toContain(`CREATE Fires when group: ${groupId}`);
    expect(text).toContain("CREATE Fires when test: At risk");
    expect(text).not.toContain("asx_actioncondition");
  });
});
