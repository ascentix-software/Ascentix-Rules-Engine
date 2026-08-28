// Typed mirror of the asx_ReadRules "Rules" JSON envelope and the asx_RunRules
// "Results" array. Field names match the server's camelCase serialization
// exactly. Enums are string names.

export interface RulesEnvelope {
  tableLogicalName: string;
  languageId: number;
  rules: RuleDef[];
}

export interface RuleDef {
  ruleId: string;
  name: string;
  triggers: string[];
  severity: string | null;
  conditionGroups: ConditionGroupDef[];
  tableConfig: TableConfigDef[];
  actions: ActionDef[];
}

export interface ConditionGroupDef {
  logicalOperator: string; // "And" | "Or"
  isExecutionCondition: boolean;
  hasNodeFilters: boolean;
  conditions: ConditionDef[];
  groups: ConditionGroupDef[];
}

export interface ConditionDef {
  tableConfigId: string | null;
  conditionType: string; // FieldComparison | RowCount | RegexMatch
  comparisonColumn: string | null;
  comparisonOperator: string | null;
  valueSource: string; // Literal | FieldReference
  comparisonValue: string | null;
  referencedTableConfigId: string | null;
  referencedColumn: string | null;
  minExpectedRows: number | null;
  maxExpectedRows: number | null;
}

export interface TableConfigDef {
  tableConfigId: string;
  tableLogicalName: string;
  tableConfigType: string; // RootTable | LookupTable | ChildTable
  parentTableConfigId: string | null;
  lookupColumnLogicalName: string | null;
  parentRelationshipName: string | null;
  childLinkField: string | null;
}

export interface ActionDef {
  actionType: string; // SetVisible | SetRequired | ShowMessage | Block | CreateRecord
  fireOn: string; // OnMatch | OnNoMatch
  targetColumn: string | null;
  value: boolean | null;
  applyInverseWhenNotFired: boolean;
  message: string | null;
  severity: string | null;
  order: number;
}

// asx_RunRules "Results" element. NOTE: no `order` field. The server emits
// fired actions already sorted by asx_order during dispatch.
export interface FiredAction {
  ruleId: string;
  actionType: string;
  fireOn: string;
  targetColumn: string | null;
  value: boolean | null;
  message: string | null;
  severity: string | null;
  targetTable: string | null;
}

export interface RunRulesResult {
  isValid: boolean;
  failedRuleCount: number;
  firedActions: FiredAction[];
}
