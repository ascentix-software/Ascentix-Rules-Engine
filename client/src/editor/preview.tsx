import { createRoot } from "react-dom/client";
import { RuleEditorApp } from "./ui/RuleEditorApp";
import { MetadataProvider } from "./ui/useMetadata";
import { RecordSearchProvider } from "./ui/useRecordSearch";
import { SystemChoicesProvider } from "./ui/useSystemChoices";
import type { MetadataService, ColumnMeta } from "./metadata";
import type { RecordSearchService } from "./records";
import type { EditorApi } from "./webapi";
import type { RuleGraph } from "./model/types";

// --- stub services: every call resolves to an empty/identity result -------
// A few typed opportunity columns so kind-dependent UI (value editors, the
// template/date-calculation source options) is exercisable in the preview.
const OPP_COLUMNS: ColumnMeta[] = [
  { logicalName: "name", displayName: "Topic", attributeType: "String", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "description", displayName: "Description", attributeType: "Memo", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "estimatedclosedate", displayName: "Est. Close Date", attributeType: "DateTime", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "budgetamount", displayName: "Budget Amount", attributeType: "Money", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
  { logicalName: "closeprobability", displayName: "Probability", attributeType: "Integer", isValidForCreate: true, isValidForUpdate: true, isValidForRead: true, isCustom: false },
];

const metaStub: MetadataService = {
  tables: async () => [],
  columns: async () => OPP_COLUMNS,
  optionSet: async () => [],
  globalOptionSet: async () => [],
  lookupTargets: async () => [],
  booleanLabels: async () => ({ trueLabel: "Yes", falseLabel: "No" }),
  relationships: async () => ({ manyToOne: [], oneToMany: [] }),
  views: async () => [],
};
const recordStub: RecordSearchService = {
  search: async () => [],
  resolveName: async () => null,
  queryByFetchXml: async () => [],
};
const apiStub = {} as EditorApi;

// --- sample graph: "High-value deal guardrails" --------------------------
const SAMPLE: RuleGraph = {
  rule: {
    id: "sample", name: "High-value deal guardrails", tableLogicalName: "opportunity",
    statusCode: 1, etag: null, triggers: [1, 2], channels: [], effectiveFrom: null,
    effectiveTo: null, evaluationContext: null, rootTableConfigId: "root", triggerColumns: [],
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
        comparisonColumn: "statecode", comparisonOperator: 0, valueSource: 1,
        comparisonValue: "Open", comparisonValueColumn: null, comparisonValueNodeId: null,
        minExpectedRows: null, maxExpectedRows: null },
    ],
  }],
  validationGroups: [{
    id: "g-val", name: "Approval gaps", parentGroupId: null, logicalOperator: "Or",
    isExecutionCondition: false,
    conditions: [
      { id: "c3", name: "", tableConfigId: "root", conditionType: "FieldComparison",
        comparisonColumn: "ownerid", comparisonOperator: 12, valueSource: 1,
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
          comparisonColumn: "salesstage", comparisonOperator: 0, valueSource: 1,
          comparisonValue: "Propose", comparisonValueColumn: null, comparisonValueNodeId: null,
          minExpectedRows: null, maxExpectedRows: null },
      ],
    }],
  }],
  actions: [
    { id: "a1", name: "", order: 1, actionType: "Block", fireOn: 1, targetColumn: null,
      targetTable: null, targetNodeId: null, message: "Needs an assigned approver",
      fieldMapping: null, value: null, applyInverseWhenNotFired: null, severity: 3,
      isActive: true, localizedMessages: [] },
    { id: "a2", name: "", order: 2, actionType: "ShowMessage", fireOn: 1,
      targetColumn: "closeprobability", targetTable: null, targetNodeId: null,
      message: "Low probability for this stage", fieldMapping: null, value: null,
      applyInverseWhenNotFired: null, severity: 2, isActive: true, localizedMessages: [] },
    { id: "a3", name: "", order: 3, actionType: "SetRequired", fireOn: 1,
      targetColumn: "budgetamount", targetTable: null, targetNodeId: null, message: null,
      fieldMapping: null, value: true, applyInverseWhenNotFired: null, severity: null,
      isActive: true, localizedMessages: [] },
    { id: "a4", name: "", order: 4, actionType: "UpdateRecord", fireOn: 1, targetColumn: null,
      targetTable: null, targetNodeId: "root", message: null,
      fieldMapping: '{"asx_needsreview": true}', value: null, applyInverseWhenNotFired: null,
      severity: null, isActive: true, localizedMessages: [] },
  ],
};

const host = document.getElementById("root");
if (host) {
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
