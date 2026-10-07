// The labels the editor renders for its choice controls, keyed the way a spec reads them.
//
// Two kinds live here:
//
// 1. The EDITOR'S OWN WORDS (conditionType, valueSource, operator, actionType). Since the Rule
//    Builder redesign these controls no longer show the org's global choice labels: the
//    condition panel renders "Compare" / "Count rows" / "Pattern" / "Calculation" as radios
//    (ConditionInspector MODES), the value source as "Compare with" tabs (ValueSourceTabs), the
//    operator as a phrase (labels.ts OPERATOR_PHRASE), and the action Type as a verb
//    (labels.ts actionVerb). If one of those changes, change it HERE, not in each spec.
//    Note that several operator phrases contain "is", so pick an operator option with
//    exact: true or Playwright's substring match finds several.
//
// 2. ORG GLOBAL-CHOICE LABELS (severity, channel, trigger). These dropdowns still render
//    `useChoiceLabel()`, the label from the org's global option set (docs/Schema.md §1), and
//    only fall back to the TypeScript token when the choice is missing. The tokens and the
//    shipped labels can DIVERGE, and a spec that types the token silently never matches an
//    option: the symptom is a 3-minute timeout on an expanded dropdown rather than an
//    assertion failure. Source of truth = the org, read from DEV:
//      node -e "GlobalOptionSetDefinitions(Name='asx_severity')"  (see scripts/devOrg.mjs)
export const CHOICE = {
  // The "Condition type" radiogroup's radios.
  conditionType: {
    fieldComparison: "Compare",
    rowCount: "Count rows",         // only rendered when the data model has a ChildTable node
    regexMatch: "Pattern",
    expression: "Calculation",
  },
  // The "Compare with" tablist's tabs.
  valueSource: {
    literal: "a value",
    fieldReference: "another column",
    template: "a text template",      // text columns only
    dateExpression: "a date calculation", // date columns only
  },
  // The "Operator" dropdown's options (labels.ts OPERATOR_PHRASE, by operator value 1..10).
  operator: {
    equals: "is",
    notEquals: "is not",
    greaterThan: "is more than",
    greaterThanOrEqual: "is at least",
    lessThan: "is less than",
    lessThanOrEqual: "is at most",
    contains: "contains",
    doesNotContain: "doesn't contain",
    isNull: "is empty",
    isNotNull: "has a value",
  },
  // The action panel's "Type" dropdown options (labels.ts actionVerb).
  actionType: {
    setVisible: "Set visible",
    setRequired: "Set required",
    showMessage: "Show message",
    block: "Block save",
    createRecord: "Create record",
    updateRecord: "Update record",
    deleteRecord: "Delete record",
    deactivateRecord: "Deactivate record",
  },
  // Org global-choice labels from here down.
  severity: { information: "Information", warning: "Warning", error: "Error" },
  channel: { standard: "Standard", portal: "Portal" },
  trigger: {
    onCreate: "On Create", onForm: "On Form", manual: "On demand",
    onUpdate: "On Update", onDelete: "On Delete",
  },
} as const;
