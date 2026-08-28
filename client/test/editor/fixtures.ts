// Raw OData shapes (lookups as _x_value, choices as numbers) mirroring a
// Web API response. GUIDs are illustrative.
export const rawRule = {
  asx_ruleid: "11111111-1111-1111-1111-111111111111",
  asx_name: "Credit limit approver required",
  asx_tablelogicalname: "account",
  statuscode: 1,
  asx_triggers: "1,4",
  asx_channels: null,
  asx_effectivefrom: null,
  asx_effectiveto: null,
  asx_evaluationcontext: 1,
  asx_triggercolumns: '["sample_lineamount"]',
  _asx_roottableconfig_value: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};

export const rawTableConfig = {
  asx_tableconfigid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  asx_name: "Account (root)",
  asx_tablelogicalname: "account",
  asx_tableconfigtype: 1,
};

export const rawCondition = {
  asx_ruleconditionid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  asx_name: "creditlimit > 10000",
  asx_conditiontype: 1,
  asx_comparisoncolumn: "creditlimit",
  asx_comparisonoperator: 5,
  asx_comparisonvaluesource: 1,
  asx_comparisonvalue: "10000",
  asx_comparisonvaluecolumn: null,
  asx_minexpectedrows: null,
  asx_maxexpectedrows: null,
  asx_conditionexpression: null,
  _asx_tableconfig_value: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  _asx_comparisonvaluenode_value: null,
};

export const rawAction = {
  asx_ruleactionid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  asx_name: "Require approver",
  asx_order: 1,
  asx_actiontype: 2,
  asx_fireon: 1,
  asx_targetcolumn: "creditlimitapprovedby",
  asx_targettable: null,
  asx_message: null,
  asx_fieldmapping: null,
  _asx_targetnode_value: null,
  asx_ruleaction_localizedmessage: [
    { asx_localizedmessageid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", asx_languagecode: 1036, asx_message: "Bonjour" },
  ],
};

// Flat group list: one execution group, one validation group, one nested subgroup.
export const rawGroups = [
  {
    asx_conditiongroupid: "g1",
    asx_name: "Exec",
    asx_logicaloperator: 1,
    asx_isexecutioncondition: true,
    _asx_parentconditiongroup_value: null,
    asx_conditiongroup_condition: [],
  },
  {
    asx_conditiongroupid: "g2",
    asx_name: "Validation root",
    asx_logicaloperator: 1,
    asx_isexecutioncondition: false,
    _asx_parentconditiongroup_value: null,
    asx_conditiongroup_condition: [rawCondition],
  },
  {
    asx_conditiongroupid: "g3",
    asx_name: "Validation sub (OR)",
    asx_logicaloperator: 2,
    asx_isexecutioncondition: false,
    _asx_parentconditiongroup_value: "g2",
    asx_conditiongroup_condition: [],
  },
];
