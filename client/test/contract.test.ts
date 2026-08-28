import { describe, it, expect } from "vitest";
import type { RulesEnvelope, FiredAction } from "../src/contract";

describe("contract types", () => {
  it("parses a ReadRules envelope", () => {
    const json = `{
      "tableLogicalName": "account",
      "languageId": 1033,
      "rules": [{
        "ruleId": "11111111-1111-1111-1111-111111111111",
        "name": "Approver required",
        "triggers": ["OnForm"],
        "severity": "Error",
        "conditionGroups": [{
          "logicalOperator": "And", "isExecutionCondition": false, "hasNodeFilters": false,
          "conditions": [{
            "tableConfigId": "n1", "conditionType": "FieldComparison",
            "comparisonColumn": "creditlimit", "comparisonOperator": "GreaterThan",
            "valueSource": "Literal", "comparisonValue": "10000",
            "referencedTableConfigId": null, "referencedColumn": null,
            "minExpectedRows": null, "maxExpectedRows": null
          }],
          "groups": []
        }],
        "tableConfig": [{
          "tableConfigId": "n1", "tableLogicalName": "account", "tableConfigType": "RootTable",
          "parentTableConfigId": null, "lookupColumnLogicalName": null,
          "parentRelationshipName": null, "childLinkField": null
        }],
        "actions": [{
          "actionType": "Block", "fireOn": "OnNoMatch", "targetColumn": null,
          "value": null, "applyInverseWhenNotFired": false, "message": "Required.",
          "severity": "Error", "order": 1
        }]
      }]
    }`;
    const env = JSON.parse(json) as RulesEnvelope;
    expect(env.tableLogicalName).toBe("account");
    expect(env.rules[0].conditionGroups[0].conditions[0].comparisonColumn).toBe("creditlimit");
    expect(env.rules[0].tableConfig[0].tableConfigType).toBe("RootTable");
    expect(env.rules[0].actions[0].actionType).toBe("Block");
  });

  it("parses RunRules fired actions", () => {
    const json = `[{
      "ruleId": "11111111-1111-1111-1111-111111111111", "actionType": "SetVisible",
      "fireOn": "OnMatch", "targetColumn": "telephone1", "value": true,
      "message": null, "severity": null, "targetTable": null
    }]`;
    const fired = JSON.parse(json) as FiredAction[];
    expect(fired[0].actionType).toBe("SetVisible");
    expect(fired[0].value).toBe(true);
  });
});
