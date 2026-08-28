export type VisibilityMap = {
  controls: Record<string, boolean>;
  sections: Record<string, boolean>;
  required?: Record<string, boolean>;
};

// Subgrid control names are assigned by the form-provisioning scripts (build_forms.py)
// and MUST match exactly. Keep these two in sync.
export const GRID = {
  conditionSearchCriteria: "ConditionSearchCriteriaGrid",
} as const;

// asx_conditiontype: FieldComparison=1, RowCount=2, RegexMatch=3
// asx_comparisonvaluesource: Literal=1, FieldReference=2
// asx_actiontype: SetVisible=1, SetRequired=2, ShowMessage=3, Block=4, CreateRecord=5, UpdateRecord=6, DeleteRecord=7
// asx_tableconfigtype: RootTable=1, LookupTable=2, ChildTable=3

export function conditionVisibility(
  conditionType: number | null,
  valueSource: number | null,
): VisibilityMap {
  const isFieldCmp = conditionType === 1;
  const isRowCount = conditionType === 2;
  const isRegex = conditionType === 3; // regex: target column + pattern (asx_comparisonvalue)
  const isRef = valueSource === 2;

  return {
    sections: {
      comparison: isFieldCmp || isRegex,
      rowcount: isRowCount,
    },
    controls: {
      asx_comparisoncolumn: isFieldCmp || isRegex,
      asx_comparisonoperator: isFieldCmp,
      asx_comparisonvaluesource: isFieldCmp,
      // literal comparison value, or the regex pattern for RegexMatch
      asx_comparisonvalue: (isFieldCmp && !isRef) || isRegex,
      asx_comparisonvaluecolumn: isFieldCmp && isRef,
      asx_comparisonvaluenode: isFieldCmp && isRef,
      asx_minexpectedrows: isRowCount,
      asx_maxexpectedrows: isRowCount,
      [GRID.conditionSearchCriteria]: isRowCount,
    },
  };
}

// asx_actiontype: SetVisible=1, SetRequired=2, ShowMessage=3, Block=4, CreateRecord=5, UpdateRecord=6, DeleteRecord=7
export function actionVisibility(actionType: number | null): VisibilityMap {
  const isSet = actionType === 1 || actionType === 2;
  const isShow = actionType === 3;
  const isBlock = actionType === 4;
  const isCreate = actionType === 5;
  const isUpdate = actionType === 6;
  const isDelete = actionType === 7;
  return {
    sections: {},
    controls: {
      asx_targetcolumn: isSet || isBlock,
      asx_valuebool: isSet,
      asx_applyinversewhennotfired: isSet,
      asx_message: isShow || isBlock,
      asx_severity: isShow || isBlock,
      asx_targettable: isCreate,
      asx_targetnode: isUpdate || isDelete,
      asx_fieldmapping: isCreate || isUpdate,
    },
  };
}

// asx_tableconfigtype: RootTable=1, LookupTable=2, ChildTable=3
export function tableConfigVisibility(configType: number | null): VisibilityMap {
  const isLookup = configType === 2;
  const isChild = configType === 3;
  return {
    sections: {},
    controls: {
      asx_parenttable: isLookup || isChild,
      asx_lookupcolumnlogicalname: isLookup,
      asx_lookuptargetidattribute: isLookup,
      asx_childlinkfield: isChild,
    },
    required: {
      asx_lookupcolumnlogicalname: isLookup,
      asx_lookuptargetidattribute: isLookup,
    },
  };
}
