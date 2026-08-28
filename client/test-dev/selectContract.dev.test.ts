import { describe, it, expect } from "vitest";
import { createDevApi } from "./devApi";
import * as O from "../src/editor/load/odata";

const api = createDevApi();

const CASES: { name: string; set: string; select: string }[] = [
  { name: "RULE_SELECT", set: O.ENTITY_SET.rule, select: O.RULE_SELECT },
  { name: "GROUP_SELECT", set: O.ENTITY_SET.group, select: O.GROUP_SELECT },
  { name: "CONDITION_SELECT", set: O.ENTITY_SET.condition, select: O.CONDITION_SELECT },
  { name: "ACTION_SELECT", set: O.ENTITY_SET.action, select: O.ACTION_SELECT },
  { name: "TABLECONFIG_SELECT", set: O.ENTITY_SET.tableConfig, select: O.TABLECONFIG_SELECT },
  { name: "LOCALIZEDMSG_SELECT", set: O.ENTITY_SET.localizedMessage, select: O.LOCALIZEDMSG_SELECT },
  { name: "NODEFILTERGROUP_SELECT", set: O.ENTITY_SET.nodeFilterGroup, select: O.NODEFILTERGROUP_SELECT },
  { name: "NODEFILTERCRITERION_SELECT", set: O.ENTITY_SET.nodeFilterCriterion, select: O.NODEFILTERCRITERION_SELECT },
];

describe("*_SELECT column contracts resolve against DEV", () => {
  for (const c of CASES) {
    it(`${c.name} names only real columns`, async () => {
      const r = await api.retrieveMultipleRecords(c.set, `?$select=${c.select}&$top=1`);
      expect(Array.isArray(r.entities)).toBe(true);
    });
  }
});
