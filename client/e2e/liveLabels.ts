// The LIVE global-choice labels the editor renders, keyed the way a spec reads them.
//
// Why this file exists: every choice dropdown in the editor renders `useChoiceLabel()`, the
// label from the ORG's global option set (docs/Schema.md §1), and only falls back to the
// TypeScript token when the choice is missing. The tokens and the shipped labels DIVERGE
// ("OnNoMatch" vs "On No Match", "Expression" vs "Calculation", "Text template" vs "Template",
// "Date calculation" vs "Date Expression"). A spec that types the token silently never matches
// an option, and the symptom is a 3-minute timeout on an expanded dropdown rather than an
// assertion failure, so a token typed by mistake reads as a hung test, not as a wrong string.
//
// Source of truth = the org, read from DEV:
//   node -e "GlobalOptionSetDefinitions(Name='asx_actionfireon')"  (see scripts/devOrg.mjs)
// If a label changes in the org, change it HERE, not in each spec.
export const CHOICE = {
  conditionType: {
    fieldComparison: "Field Comparison",
    rowCount: "Row Count",
    regexMatch: "Regex Match",
    expression: "Calculation",          // token is "Expression"
  },
  valueSource: {
    literal: "Literal",
    fieldReference: "Field Reference",  // token is "FieldReference"
    template: "Template",               // token/Field label is "Text template"
    dateExpression: "Date Expression",  // token/Field label is "Date calculation"
  },
  operator: {
    equals: "Equals",
    notEquals: "Not Equals",
    greaterThan: "Greater Than",
    greaterThanOrEqual: "Greater Than Or Equal",
    lessThan: "Less Than",
    lessThanOrEqual: "Less Than Or Equal",
    // The four the TS token list spells without spaces (ConditionInspector.tsx:30-36
    // "DoesNotContain", "IsNull", "IsNotNull"): exactly the divergence this module exists for.
    // Re-read from DEV: GlobalOptionSetDefinitions(Name='asx_comparisonoperator')
    // is 1 Equals, 2 Not Equals, 3 Greater Than, 4 Greater Than Or Equal, 5 Less Than,
    // 6 Less Than Or Equal, 7 Contains, 8 Does Not Contain, 9 Is Null, 10 Is Not Null.
    contains: "Contains",
    doesNotContain: "Does Not Contain",
    isNull: "Is Null",
    isNotNull: "Is Not Null",
  },
  actionType: {
    setVisible: "Set Visible",
    setRequired: "Set Required",
    showMessage: "Show Message",
    block: "Block",
    createRecord: "Create Record",
    updateRecord: "Update Record",
    deleteRecord: "Delete Record",
  },
  fireOn: { onMatch: "On Match", onNoMatch: "On No Match" },
  severity: { information: "Information", warning: "Warning", error: "Error" },
  channel: { standard: "Standard", portal: "Portal" },
  trigger: {
    onCreate: "On Create", onForm: "On Form", manual: "Manual",
    onUpdate: "On Update", onDelete: "On Delete",
  },
} as const;
