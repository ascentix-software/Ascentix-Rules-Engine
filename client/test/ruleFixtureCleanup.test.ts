import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), validate: vi.fn(), publish: vi.fn(), remove: vi.fn(), retrieve: vi.fn(),
}));
vi.mock("../test-dev/devApi", () => ({
  createDevApi: () => ({ createRecord: mocks.create, validateRule: mocks.validate, publishRule: mocks.publish, retrieveMultipleRecords: mocks.retrieve }),
  deleteDevRecord: mocks.remove,
}));
vi.mock("../test-dev/ruleBehavior/settle", () => ({ configsVisible: vi.fn(), enforcementSettled: vi.fn() }));
import { authorRule, ensureTableConfig } from "../test-dev/ruleBehavior/authoring";
import { createRuleFixture } from "../e2e/devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";

beforeEach(() => {
  vi.resetAllMocks();
  let next = 0;
  mocks.create.mockImplementation(async () => `id-${++next}`);
  mocks.validate.mockResolvedValue({ isValid: true, issues: [] });
  mocks.publish.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.retrieve.mockResolvedValue({ entities: [] });
});

const cfg = { name: "cleanup", rootNodeId: "model", conditions: [], actions: [{ actionType: 4, fireOn: 2, message: "Test" }] };

it("deletes an authored rule once and leaves its server-owned children to the server", async () => {
  const rule = await authorRule(cfg);
  await rule.cleanup();
  await rule.cleanup();
  expect(mocks.remove.mock.calls).toEqual([["asx_rules", rule.ruleId]]);
});

it("retains failed cleanup work for a retry without deleting individual owned children", async () => {
  const rule = await authorRule(cfg);
  mocks.remove.mockRejectedValueOnce(new Error("Delete failed"));
  await expect(rule.cleanup()).rejects.toThrow("Delete failed");
  await rule.cleanup();
  await rule.cleanup();
  expect(mocks.remove.mock.calls).toEqual([["asx_rules", rule.ruleId], ["asx_rules", rule.ruleId]]);
});

it("preserves the original publication error when cleanup also fails", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.publish.mockRejectedValue(new Error("Publication rejected"));
  mocks.remove.mockRejectedValue(new Error("Cleanup rejected"));
  try {
    await expect(authorRule(cfg)).rejects.toThrow("Publication rejected");
    expect(warning).toHaveBeenCalledWith("Fixture cleanup failed:", expect.any(Error));
  } finally { warning.mockRestore(); }
});

it("cleans partially authored rules through the same server-owned delete", async () => {
  mocks.create.mockResolvedValueOnce("rule").mockRejectedValueOnce(new Error("Child failed"));
  await expect(authorRule(cfg)).rejects.toThrow("Child failed");
  expect(mocks.remove.mock.calls).toEqual([["asx_rules", "rule"]]);
});

it("deletes standalone shared models in reverse order once", async () => {
  const model = await ensureTableConfig();
  await model.cleanup();
  await model.cleanup();
  expect(mocks.remove.mock.calls).toEqual([6, 5, 4, 3, 2, 1].map(id => ["asx_tableconfigs", `id-${id}`]));
});

it("cleans browser fixtures by deleting the rule and then its shared model", async () => {
  const fixture = await createRuleFixture();
  await fixture.cleanup();
  await fixture.cleanup();
  expect(mocks.remove.mock.calls).toEqual([["asx_rules", fixture.ruleId], ["asx_tableconfigs", "id-1"]]);
});

it("sweeps original rules once and stops on a real lifecycle failure", async () => {
  mocks.retrieve.mockResolvedValueOnce({ entities: [{ asx_ruleid: "original", asx_name: "ZZ_RB_example" }] });
  mocks.remove.mockRejectedValueOnce(new Error("Lifecycle failed"));
  await expect(sweepRuleBehaviorOrphans()).rejects.toThrow("Lifecycle failed");
  expect(mocks.retrieve.mock.calls).toEqual([["asx_rules", expect.stringContaining("and _asx_draftof_value eq null")]]);
  expect(mocks.remove.mock.calls).toEqual([["asx_rules", "original"]]);
});
