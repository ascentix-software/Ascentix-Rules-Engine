export type LogicalOperatorLabel = "And" | "Or";
export type ConditionTypeLabel = "FieldComparison" | "RowCount" | "RegexMatch" | "Expression";
export type ActionTypeLabel =
  | "SetVisible" | "SetRequired" | "ShowMessage" | "Block"
  | "CreateRecord" | "UpdateRecord" | "DeleteRecord" | "DeactivateRecord";
export type TableConfigTypeLabel = "RootTable" | "LookupTable" | "ChildTable";

export interface RuleHeader {
  id: string;
  name: string;
  tableLogicalName: string;
  statusCode: number | null;
  publishedRevisionId?: string | null;
  publishedVersion?: number;
  /** When and by whom the live revision was published (the revision row); display only, never saved. */
  publishedOn?: string | null;
  publishedBy?: string | null;
  activeRuleId?: string;
  activeEtag?: string | null;
  etag: string | null;
  triggers: number[];
  channels: number[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  evaluationContext: number | null;
  /** Windows time zone id for date comparisons (asx_evaluationtimezone); null/absent = UTC. */
  evaluationTimeZone?: string | null;
  /** Which records an On demand run processes (asx_ondemandscope); 1 = "a record it's given",
   *  2 = "all records that pass its execution conditions". Meaningful only when triggers
   *  includes ON_DEMAND; null/absent (optional like evaluationTimeZone above, so existing rule
   *  literals need not be touched) defaults to 1. */
  onDemandScope?: number | null;
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
  /** Expression condition only: aggregate filters keyed by `filter:<key>` (asx_expressionfilters). */
  expressionFilters?: import("./expressionFilters").ExpressionFilters | null;
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
  /** The "Fires when" tree (asx_actionconditiongroup/test). null = no tree: the action never fires
   * and publish refuses it. */
  firesWhen: FiresWhenGroup | null;
  /** Load-time warning about the tree (more than one root in Dataverse); never saved. */
  firesWhenWarning?: string | null;
  targetColumn: string | null;
  targetTable: string | null;
  targetNodeId: string | null;
  message: string | null;
  fieldMapping: string | null;
  value: boolean | null;
  applyInverseWhenNotFired: boolean | null;
  severity: number | null;
  isActive: boolean | null;
  /** Update Record only: also apply to the previous record when the save changes the lookup above
   * the target (asx_applytoprevious). */
  applyToPrevious?: boolean | null;
  /** Set actions only (model/setActions.ts isSetAction): the Rows filter
   * (asx_nodefiltergroup.asx_ruleaction), which rows of the target node the action writes. Its
   * targetNodeId is always the action's target node; save/diff.ts binds it from the action. */
  rowFilter?: import("./nodeFilter").NodeFilterBlock | null;
  localizedMessages: LocalizedMessage[];
}

export interface FiresWhenTest { id: string; etag?: string | null; outcomeId: string | null; expected: boolean; }
export interface FiresWhenGroup { id: string; etag?: string | null; op: "all" | "any"; tests: FiresWhenTest[]; groups: FiresWhenGroup[]; }

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
