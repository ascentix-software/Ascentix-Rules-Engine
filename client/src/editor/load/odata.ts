// Centralized OData names. Relationship/navigation names follow docs/Schema.md §5;
// confirm against live metadata if a fetch 400s.
export const ENTITY = {
  rule: "asx_rule",
  group: "asx_conditiongroup",
  condition: "asx_rulecondition",
  action: "asx_ruleaction",
  tableConfig: "asx_tableconfig",
  localizedMessage: "asx_localizedmessage",
  nodeFilterGroup: "asx_nodefiltergroup",
  nodeFilterCriterion: "asx_nodefiltercriterion",
} as const;

export const LOOKUP = {
  ruleOfGroup: "_asx_rule_value",
  parentGroup: "_asx_parentconditiongroup_value",
  ruleOfAction: "_asx_rule_value",
  conditionTableConfig: "_asx_tableconfig_value",
  comparisonValueNode: "_asx_comparisonvaluenode_value",
  actionTargetNode: "_asx_targetnode_value",
  parentTableOfConfig: "_asx_parenttable_value",
  ruleOfTableConfig: "_asx_roottableconfig_value",
  // asx_nodefiltergroup / asx_nodefiltercriterion (docs/Schema.md §2.7-2.8)
  filterGroupCondition: "_asx_rulecondition_value",
  filterGroupTargetNode: "_asx_tableconfignode_value",
  filterParentGroup: "_asx_parentfiltergroup_value",
  filterGroupOfCriterion: "_asx_filtergroup_value",
  filterCriterionValueNode: "_asx_comparisonvaluenode_value",
  // Nestable EXISTS predicate (docs/Schema.md §2.7-2.8). Owning-criterion is on
  // the GROUP (the sub-filter's root); collection-node is on the CRITERION (Exists target).
  filterGroupOwningCriterion: "_asx_owningcriterion_value",
  filterCriterionCollectionNode: "_asx_collectionnode_value",
} as const;

export const NAV = {
  ruleGroups: "asx_rule_conditiongroup",
  groupConditions: "asx_conditiongroup_condition",
  ruleActions: "asx_rule_ruleaction",
  // action → localized messages; confirm nav name in live smoke if a fetch 400s
  actionLocalizedMessages: "asx_ruleaction_localizedmessage",
  filterGroupCriteria: "asx_nodefiltergroup_criterion",
} as const;

export const RULE_SELECT =
  "asx_ruleid,asx_name,asx_tablelogicalname,statuscode," +
  "asx_triggers,asx_channels,asx_effectivefrom,asx_effectiveto,asx_evaluationcontext,asx_triggercolumns," +
  LOOKUP.ruleOfTableConfig;
export const GROUP_SELECT =
  "asx_conditiongroupid,asx_name,asx_logicaloperator,asx_isexecutioncondition," +
  LOOKUP.parentGroup;
export const CONDITION_SELECT =
  "asx_ruleconditionid,asx_name,asx_conditiontype,asx_comparisoncolumn," +
  "asx_comparisonoperator,asx_comparisonvaluesource,asx_comparisonvalue," +
  "asx_comparisonvaluecolumn,asx_minexpectedrows,asx_maxexpectedrows,asx_conditionexpression," +
  LOOKUP.conditionTableConfig + "," + LOOKUP.comparisonValueNode;
export const ACTION_SELECT =
  "asx_ruleactionid,asx_name,asx_order,asx_actiontype,asx_fireon," +
  "asx_targetcolumn,asx_targettable,asx_message,asx_fieldmapping," +
  "asx_valuebool,asx_applyinversewhennotfired,asx_severity,asx_isactive," +
  LOOKUP.actionTargetNode;
export const TABLECONFIG_SELECT =
  "asx_tableconfigid,asx_name,asx_tablelogicalname,asx_tableconfigtype," +
  LOOKUP.parentTableOfConfig + ",asx_lookupcolumnlogicalname,asx_childlinkfield,asx_lookuptargetidattribute";
export const LOCALIZEDMSG_SELECT =
  "asx_localizedmessageid,asx_languagecode,asx_message";
export const NODEFILTERGROUP_SELECT =
  "asx_nodefiltergroupid,asx_logicaloperator," +
  LOOKUP.filterGroupCondition + "," + LOOKUP.filterGroupTargetNode + "," + LOOKUP.filterParentGroup + "," +
  LOOKUP.filterGroupOwningCriterion;
export const NODEFILTERCRITERION_SELECT =
  "asx_nodefiltercriterionid,asx_fieldname,asx_operator,asx_value," +
  "asx_comparisonvaluesource,asx_comparisonvaluecolumn," +
  "asx_criteriontype,asx_mincount,asx_maxcount," +
  LOOKUP.filterCriterionValueNode + "," + LOOKUP.filterCriterionCollectionNode;

// Entity set (collection) names for $batch URLs and @odata.bind targets.
export const ENTITY_SET = {
  rule: "asx_rules",
  group: "asx_conditiongroups",
  condition: "asx_ruleconditions",
  action: "asx_ruleactions",
  tableConfig: "asx_tableconfigs",
  localizedMessage: "asx_localizedmessages",
  nodeFilterGroup: "asx_nodefiltergroups",
  nodeFilterCriterion: "asx_nodefiltercriterions",
} as const;

// @odata.bind navigation-property names. The referencing-side navigation
// property is NOT the relationship schema name; it is the lookup attribute's
// navigation-property name (the SchemaName casing of the referencing attribute).
// Every entry round-tripped against DEV by client/test-dev/bindNav.dev.test.ts
// (npm run test:dev).
// NOTE: conditionValueNode + actionTargetNode are PascalCased, and @odata.bind is case-sensitive.
export const BIND_NAV = {
  groupRule: "asx_rule",
  groupParent: "asx_parentconditiongroup",
  conditionGroup: "asx_conditiongroup",
  conditionTableConfig: "asx_tableconfig",
  conditionValueNode: "asx_ComparisonValueNode",
  actionRule: "asx_rule",
  actionTargetNode: "asx_TargetNode",
  localizedMessageAction: "asx_RuleAction",
  tableConfigParent: "asx_parenttable",
  ruleRootTableConfig: "asx_RootTableConfig",
  // asx_nodefiltergroup / asx_nodefiltercriterion binds. The two owner/value-node lookups are
  // PascalCased (created with PascalCase SchemaNames). @odata.bind is case-sensitive; the four
  // pre-existing lookups are lowercase.
  filterGroupCondition: "asx_RuleCondition",
  filterGroupConditionGroup: "asx_conditiongroup",
  filterGroupTargetNode: "asx_tableconfignode",
  filterGroupParent: "asx_parentfiltergroup",
  filterCriterionGroup: "asx_filtergroup",
  filterCriterionValueNode: "asx_ComparisonValueNode",
  // Nestable EXISTS predicate binds: both lookups were created with LOWERCASE schema names,
  // so the nav property is lowercase (asx_collectionnode / asx_owningcriterion), like the four
  // lowercase lookups above.
  filterCriterionCollectionNode: "asx_collectionnode",
  filterGroupOwningCriterion: "asx_owningcriterion",
} as const;
