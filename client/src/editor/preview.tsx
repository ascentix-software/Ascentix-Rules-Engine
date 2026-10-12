import { createRoot } from "react-dom/client";
import { RuleEditorApp } from "./ui/RuleEditorApp";
import { TableConfigApp } from "./ui/TableConfigApp";
import { HelpApp } from "./help/HelpApp";
import { MetadataProvider } from "./ui/useMetadata";
import { RecordSearchProvider } from "./ui/useRecordSearch";
import { SystemChoicesProvider } from "./ui/useSystemChoices";
import type { MetadataService, ColumnMeta } from "./metadata";
import type { RecordSearchService } from "./records";
import type { EditorApi } from "./webapi";
import type { RuleGraph } from "./model/types";
import { always } from "./model/firesWhen";

// --- stub services: every call resolves to an empty/identity result -------
// A few typed opportunity columns so kind-dependent UI (value editors, the
// template/date-calculation source options) is exercisable in the preview.
const OPP_COLUMNS: ColumnMeta[] = [
  { logicalName: "name", displayName: "Topic", attributeType: "String", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "description", displayName: "Description", attributeType: "Memo", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "estimatedclosedate", displayName: "Est. Close Date", attributeType: "DateTime", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "budgetamount", displayName: "Budget Amount", attributeType: "Money", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "closeprobability", displayName: "Probability", attributeType: "Integer", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "estimatedvalue", displayName: "Est. Revenue", attributeType: "Money", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "statecode", displayName: "Status", attributeType: "State", isValidForCreate: false, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "ownerid", displayName: "Approver", attributeType: "Owner", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "salesstage", displayName: "Sales Stage", attributeType: "Picklist", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
];

const metaStub: MetadataService = {
  tables: async () => [
    { logicalName: "opportunity", displayName: "Opportunity", entitySetName: "opportunities", primaryNameAttribute: "name", primaryIdAttribute: "opportunityid", isCustom: false },
    { logicalName: "account", displayName: "Account", entitySetName: "accounts", primaryNameAttribute: "name", primaryIdAttribute: "accountid", isCustom: false },
    { logicalName: "contact", displayName: "Contact", entitySetName: "contacts", primaryNameAttribute: "fullname", primaryIdAttribute: "contactid", isCustom: false },
    { logicalName: "opportunityproduct", displayName: "Opportunity Product", entitySetName: "opportunityproducts", primaryNameAttribute: "productname", primaryIdAttribute: "opportunityproductid", isCustom: false },
  ],
  columns: async () => OPP_COLUMNS,
  optionSet: async () => [],
  globalOptionSet: async () => [],
  lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({
    manyToOne: [
      { schemaName: "opp_contact", referencingAttribute: "parentcontactid", referencedEntity: "contact" },
      { schemaName: "opp_account", referencingAttribute: "parentaccountid", referencedEntity: "account" },
    ],
    oneToMany: [{ schemaName: "opp_lines", referencingEntity: "opportunityproduct", referencingAttribute: "opportunityid" }],
  }),
  views: async () => [],
};
const SAMPLE_RECORDS = [{ id: "o1", name: "Contoso 2026 renewal" }, { id: "o2", name: "Fabrikam expansion" }];
const recordStub: RecordSearchService = {
  search: async (_t, q) => SAMPLE_RECORDS.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())),
  resolveName: async () => null,
  resolveNames: async (_t, ids) => new Map(SAMPLE_RECORDS.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.name])),
  queryByFetchXml: async () => [],
};
// ?state=new (never published) | live (live, no draft) | draft (default: a draft of live v3)
const state = new URLSearchParams(location.search).get("state") ?? "draft";
const apiStub = {
  getClientUrl: () => location.origin,
  executeBatch: async () => ({ httpStatus: 200, text: "" }),
  fetchJson: async () => ({ value: [] }),
  retrieveRecord: async () => ({}),
  retrieveMultipleRecords: async () => ({ entities: [] }),
  validateRule: async () => ({
    isValid: true,
    issues: [{ severity: "Warning", code: "OUTCOME_UNUSED", message: "No active action tests this outcome.", target: { kind: "Group", id: "g-val" } }],
  }),
  publishRule: async () => {},
  unpublishRule: async () => {},
  openRuleDraft: async () => "draft",
  dryRun: async () => ({
    isValid: true,
    changeSet: { creates: 0, updates: 1, deletes: 0, unchanged: 0 },
    outcomes: [{ ruleId: "sample", name: "Approval gaps", value: true }],
    actions: [
      { ruleId: "sample", actionType: "ShowMessage", message: "Low probability for this stage", targetTable: null },
      { ruleId: "sample", actionType: "UpdateRecord", message: null, targetTable: "opportunity",
        writes: [{ operation: "Update", targetTable: "opportunity", targetId: "o1" }], writeCount: 1, unchangedCount: 0 },
      { ruleId: "other", actionType: "ShowMessage", message: "Check the close date", targetTable: null },
    ],
  }),
} as unknown as EditorApi;

// --- sample graph: "High-value deal guardrails" --------------------------
const SAMPLE: RuleGraph = {
  rule: {
    id: "sample", name: "High-value deal guardrails", tableLogicalName: "opportunity",
    statusCode: 1, etag: null, triggers: [1, 2], channels: [], effectiveFrom: null,
    effectiveTo: null, evaluationContext: null, onDemandScope: null,
    rootTableConfigId: "root", triggerColumns: [],
  },
  tableConfigs: {
    root: { id: "root", name: "Opportunity", tableLogicalName: "opportunity", tableConfigType: "RootTable", parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null },
  },
  executionGroups: [{
    id: "g-exec", name: "Qualifying deals", parentGroupId: null, logicalOperator: "And",
    isExecutionCondition: true, groups: [],
    conditions: [
      { id: "c1", name: "", tableConfigId: "root", conditionType: "FieldComparison",
        comparisonColumn: "estimatedvalue", comparisonOperator: 4, valueSource: 1,
        comparisonValue: "100000", comparisonValueColumn: null, comparisonValueNodeId: null,
        minExpectedRows: null, maxExpectedRows: null },
      { id: "c2", name: "", tableConfigId: "root", conditionType: "FieldComparison",
        comparisonColumn: "statecode", comparisonOperator: 1, valueSource: 1,
        comparisonValue: "Open", comparisonValueColumn: null, comparisonValueNodeId: null,
        minExpectedRows: null, maxExpectedRows: null },
    ],
  }],
  validationGroups: [{
    id: "g-val", name: "Approval gaps", parentGroupId: null, logicalOperator: "Or",
    isExecutionCondition: false,
    conditions: [
      { id: "c3", name: "", tableConfigId: "root", conditionType: "FieldComparison",
        comparisonColumn: "ownerid", comparisonOperator: 9, valueSource: 1,
        comparisonValue: null, comparisonValueColumn: null, comparisonValueNodeId: null,
        minExpectedRows: null, maxExpectedRows: null },
      { id: "c4", name: "", tableConfigId: "root", conditionType: "FieldComparison",
        comparisonColumn: "closeprobability", comparisonOperator: 6, valueSource: 1,
        comparisonValue: "60", comparisonValueColumn: null, comparisonValueNodeId: null,
        minExpectedRows: null, maxExpectedRows: null },
    ],
    groups: [{
      id: "g-late", name: "Late-stage check", parentGroupId: "g-val", logicalOperator: "And",
      isExecutionCondition: false, groups: [],
      conditions: [
        { id: "c5", name: "", tableConfigId: "root", conditionType: "FieldComparison",
          comparisonColumn: "salesstage", comparisonOperator: 1, valueSource: 1,
          comparisonValue: "Propose", comparisonValueColumn: null, comparisonValueNodeId: null,
          minExpectedRows: null, maxExpectedRows: null },
      ],
    }],
  }],
  actions: [
    { id: "a1", name: "", order: 1, actionType: "Block", firesWhen: always(), targetColumn: null,
      targetTable: null, targetNodeId: null, message: "Needs an assigned approver",
      fieldMapping: null, value: null, applyInverseWhenNotFired: null, severity: 3,
      isActive: true, localizedMessages: [] },
    { id: "a2", name: "", order: 2, actionType: "ShowMessage", firesWhen: always(),
      targetColumn: "closeprobability", targetTable: null, targetNodeId: null,
      message: "Low probability for this stage", fieldMapping: null, value: null,
      applyInverseWhenNotFired: null, severity: 2, isActive: true, localizedMessages: [] },
    { id: "a3", name: "", order: 3, actionType: "SetRequired", firesWhen: always(),
      targetColumn: "budgetamount", targetTable: null, targetNodeId: null, message: null,
      fieldMapping: null, value: true, applyInverseWhenNotFired: null, severity: null,
      isActive: true, localizedMessages: [] },
    { id: "a4", name: "", order: 4, actionType: "UpdateRecord", firesWhen: always(), targetColumn: null,
      targetTable: null, targetNodeId: "root", message: null,
      fieldMapping: '{"asx_needsreview": true}', value: null, applyInverseWhenNotFired: null,
      severity: null, isActive: true, localizedMessages: [] },
  ],
};

if (state !== "new") {
  SAMPLE.rule.publishedVersion = 3;
  SAMPLE.rule.publishedRevisionId = "rev3";
  SAMPLE.rule.statusCode = 753840000;
  SAMPLE.rule.publishedOn = "2026-10-02T09:00:00Z";
  SAMPLE.rule.publishedBy = "Dana Whitfield";
  SAMPLE.rule.triggers = [1, 4, 3];
  if (state === "draft") SAMPLE.rule.activeRuleId = "live";
}

const TC_GRAPH: RuleGraph = {
  rule: { ...SAMPLE.rule, id: "__config-editor__", name: "", rootTableConfigId: "root" },
  executionGroups: [], validationGroups: [], actions: [],
  tableConfigs: {
    root: SAMPLE.tableConfigs.root,
    acct: { id: "acct", name: "Account", tableLogicalName: "account", tableConfigType: "LookupTable", parentTableConfigId: "root", lookupColumnLogicalName: "parentaccountid", childLinkField: null, lookupTargetIdAttribute: "accountid" },
    pc: { id: "pc", name: "Primary Contact", tableLogicalName: "contact", tableConfigType: "LookupTable", parentTableConfigId: "acct", lookupColumnLogicalName: "primarycontactid", childLinkField: null, lookupTargetIdAttribute: "contactid" },
    lines: { id: "lines", name: "Opportunity Lines", tableLogicalName: "opportunityproduct", tableConfigType: "ChildTable", parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "opportunityid", lookupTargetIdAttribute: null },
  },
};
const TC_USAGE = {
  rulesUsingCount: 3, usedNodeIds: new Set(["lines"]),
  rules: [
    { id: "r1", name: "High-value deal guardrails", statusCode: 753840000, refs: [{ nodeId: "lines", conditions: 1, actions: 0 }] },
    { id: "r2", name: "Line discount cap", statusCode: 753840000, refs: [{ nodeId: "lines", conditions: 2, actions: 1 }] },
    { id: "r3", name: "Weekly stale-deal sweep", statusCode: 1, refs: [{ nodeId: "pc", conditions: 1, actions: 0 }] },
  ],
};

const host = document.getElementById("root");
// ?view=help: the docs viewer. Screenshots load from /WebResources/asx_/docs/images/ on the
// server serving this page (copy docs/guide/images there).
if (host && new URLSearchParams(location.search).get("view") === "help") {
  createRoot(host).render(<HelpApp getClientUrl={() => ""} />);
} else if (host && new URLSearchParams(location.search).get("view") === "tableconfig") {
  createRoot(host).render(
    <MetadataProvider service={metaStub}>
      <TableConfigApp initialGraph={TC_GRAPH} initialUsage={TC_USAGE} api={apiStub}
        reload={async () => ({ graph: TC_GRAPH, usage: TC_USAGE })} />
    </MetadataProvider>,
  );
} else if (host) {
  createRoot(host).render(
    <MetadataProvider service={metaStub}>
      <RecordSearchProvider service={recordStub}>
        <SystemChoicesProvider>
          <RuleEditorApp
            initialGraph={SAMPLE}
            api={apiStub}
            reload={async () => SAMPLE}
            initialValueLabels={{}}
            loadValueLabels={async () => ({})}
          />
        </SystemChoicesProvider>
      </RecordSearchProvider>
    </MetadataProvider>,
  );
}
