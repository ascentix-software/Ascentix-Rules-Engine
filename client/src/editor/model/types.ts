export type LogicalOperatorLabel = "And" | "Or";
export type ConditionTypeLabel = "FieldComparison" | "RowCount" | "RegexMatch" | "Expression";
export type ActionTypeLabel =
  | "SetVisible" | "SetRequired" | "ShowMessage" | "Block"
  | "CreateRecord" | "UpdateRecord" | "DeleteRecord";
export type TableConfigTypeLabel = "RootTable" | "LookupTable" | "ChildTable";

export interface RuleHeader {
  id: string;
  name: string;
  tableLogicalName: string;
  statusCode: number | null;
  publishedRevisionId?: string | null;
  publishedVersion?: number;
  activeRuleId?: string;
  activeEtag?: string | null;
  etag: string | null;
  triggers: number[];
  channels: number[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  evaluationContext: number | null;
  rootTableConfigId: string | null;
  /** Root-table column logical names that fire OnUpdate evaluation (asx_triggercolumns, JSON array). */
  triggerColumns: string[];
}

export interface ConditionNode {
  id: string;
  name: string;
  /**
   * Row version from the load (`@odata.etag`), threaded onto this row's PATCH as `If-Match` so a
   * concurrent edit by another author 412s instead of silently last-write-wins. Absent (undefined)
   * on rows the editor created locally and on any row whose load did not surface an etag. In both
   * cases save/diff.ts emits `etag: null` and the PATCH goes out unconditioned, exactly as before.
   */
  etag?: string | null;

  tableConfigId: string | null;
  conditionType: ConditionTypeLabel | null;
  comparisonColumn: string | null;
  comparisonOperator: number | null;
  valueSource: number | null;
  comparisonValue: string | null;
  comparisonValueColumn: string | null;
  comparisonValueNodeId: string | null;
  minExpectedRows: number | null;
  maxExpectedRows: number | null;
  /**
   * Expression condition only: the LHS mathexpr. Optional: full model wiring (loaders,
   * ConditionInspector) lands with the "Calculation" condition kind; present now so
   * validation.ts can hint on a blank/unparseable expression.
   */
  expression?: string | null;
  /** Per-condition node filter ("Only consider records where…"); a list of single-target
   *  top-level filter groups (engine-accurate, per nodeFilter.ts); null ⇒ no filter. */
  filter?: import("./nodeFilter").NodeFilterBlock[] | null;
}

export interface ConditionGroupNode {
  id: string;
  name: string;
  /**
   * Row version from the load (`@odata.etag`), threaded onto this row's PATCH as `If-Match` so a
   * concurrent edit by another author 412s instead of silently last-write-wins. Absent (undefined)
   * on rows the editor created locally and on any row whose load did not surface an etag. In both
   * cases save/diff.ts emits `etag: null` and the PATCH goes out unconditioned, exactly as before.
   */
  etag?: string | null;

  parentGroupId: string | null;
  logicalOperator: LogicalOperatorLabel;
  isExecutionCondition: boolean;
  conditions: ConditionNode[];
  groups: ConditionGroupNode[];
}

export interface LocalizedMessage {
  id: string;
  languageCode: number;
  message: string;
  /**
   * Row version from the load (`@odata.etag`), threaded onto this row's PATCH as `If-Match` so a
   * concurrent edit by another author 412s instead of silently last-write-wins. Absent (undefined)
   * on rows the editor created locally and on any row whose load did not surface an etag. In both
   * cases save/diff.ts emits `etag: null` and the PATCH goes out unconditioned, exactly as before.
   */
  etag?: string | null;
}

export interface ActionNode {
  id: string;
  name: string;
  /**
   * Row version from the load (`@odata.etag`), threaded onto this row's PATCH as `If-Match` so a
   * concurrent edit by another author 412s instead of silently last-write-wins. Absent (undefined)
   * on rows the editor created locally and on any row whose load did not surface an etag. In both
   * cases save/diff.ts emits `etag: null` and the PATCH goes out unconditioned, exactly as before.
   */
  etag?: string | null;

  order: number;
  actionType: ActionTypeLabel | null;
  fireOn: number | null;
  targetColumn: string | null;
  targetTable: string | null;
  targetNodeId: string | null;
  message: string | null;
  fieldMapping: string | null;
  value: boolean | null;
  applyInverseWhenNotFired: boolean | null;
  severity: number | null;
  isActive: boolean | null;
  localizedMessages: LocalizedMessage[];
}

export interface TableConfigRef {
  id: string;
  name: string;
  /**
   * Row version from the load (`@odata.etag`), threaded onto this row's PATCH as `If-Match` so a
   * concurrent edit by another author 412s instead of silently last-write-wins. Absent (undefined)
   * on rows the editor created locally and on any row whose load did not surface an etag. In both
   * cases save/diff.ts emits `etag: null` and the PATCH goes out unconditioned, exactly as before.
   */
  etag?: string | null;

  tableLogicalName: string;
  tableConfigType: TableConfigTypeLabel | null;
  parentTableConfigId: string | null;
  lookupColumnLogicalName: string | null;
  childLinkField: string | null;
  lookupTargetIdAttribute: string | null;
}

export interface RuleGraph {
  rule: RuleHeader;
  executionGroups: ConditionGroupNode[];
  validationGroups: ConditionGroupNode[];
  actions: ActionNode[];
  tableConfigs: Record<string, TableConfigRef>;
}

export type Selection =
  | { kind: "rule" }
  | { kind: "group"; id: string }
  | { kind: "condition"; id: string }
  | { kind: "action"; id: string }
  | { kind: "node"; id: string }
  | null;
