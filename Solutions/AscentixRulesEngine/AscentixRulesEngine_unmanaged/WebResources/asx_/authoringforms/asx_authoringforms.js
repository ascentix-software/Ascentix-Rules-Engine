"use strict";
(() => {
  // src/xrm.ts
  function createXrmAdapter(formContext) {
    const attr = (n) => formContext.getAttribute(n) || null;
    const controlsFor = (n) => {
      const a = attr(n);
      if (!a) return [];
      return a.controls.get() || [];
    };
    return {
      getTableLogicalName: () => formContext.data.entity.getEntityName(),
      getRecordId: () => {
        const id = formContext.data.entity.getId();
        return id ? id.replace(/[{}]/g, "") : null;
      },
      hasAttribute: (n) => attr(n) !== null,
      getAttributeType: (n) => attr(n) ? attr(n).getAttributeType() : null,
      getValue: (n) => attr(n) ? attr(n).getValue() : null,
      controlExists: (n) => controlsFor(n).length > 0,
      getControlVisible: (n) => {
        const c = controlsFor(n)[0];
        return c ? c.getVisible() : true;
      },
      setControlVisible: (n, v) => controlsFor(n).forEach((c) => c.setVisible(v)),
      setSectionVisible: (section, visible) => {
        formContext.ui.tabs.forEach((tab) => {
          const s = tab.sections.get(section);
          if (s) s.setVisible(visible);
        });
      },
      getRequiredLevel: (n) => {
        const a = attr(n);
        return a ? a.getRequiredLevel() : "none";
      },
      setRequiredLevel: (n, level) => {
        const a = attr(n);
        if (a) a.setRequiredLevel(level);
      },
      // Inline notification on the control (addNotification, NOT setNotification). ERROR is
      // the only level the platform actually RENDERS inline, and an ERROR control notification
      // stops the save at the form's validation stage. So this call blocks: a field-targeted
      // ShowMessage or Block holds the save until its condition stops matching. RECOMMENDATION
      // neither blocks nor displays anything, so there is no useful second level to offer here
      // and hence no level parameter on the port. A FORM-level notification (setFormNotification
      // below) banners and does not block. See docs/Client-Form-Library.md §1: the action
      // table and "Any message on a FIELD stops the save". The server plugin remains the
      // authoritative enforcer for non-form writes.
      setControlNotification: (n, message, uid) => controlsFor(n).forEach((c) => c.addNotification({ messages: [message], notificationLevel: "ERROR", uniqueId: uid })),
      clearControlNotification: (n, uid) => controlsFor(n).forEach((c) => c.clearNotification(uid)),
      setFormNotification: (message, level, uid) => formContext.ui.setFormNotification(message, level, uid),
      clearFormNotification: (uid) => formContext.ui.clearFormNotification(uid),
      addOnChange: (n, handler) => {
        const a = attr(n);
        if (a) a.addOnChange(() => handler());
      }
    };
  }

  // src/authoring/visibility.ts
  var GRID = {
    conditionSearchCriteria: "ConditionSearchCriteriaGrid"
  };
  function conditionVisibility(conditionType, valueSource) {
    const isFieldCmp = conditionType === 1;
    const isRowCount = conditionType === 2;
    const isRegex = conditionType === 3;
    const isRef = valueSource === 2;
    return {
      sections: {
        comparison: isFieldCmp || isRegex,
        rowcount: isRowCount
      },
      controls: {
        asx_comparisoncolumn: isFieldCmp || isRegex,
        asx_comparisonoperator: isFieldCmp,
        asx_comparisonvaluesource: isFieldCmp,
        // literal comparison value, or the regex pattern for RegexMatch
        asx_comparisonvalue: isFieldCmp && !isRef || isRegex,
        asx_comparisonvaluecolumn: isFieldCmp && isRef,
        asx_comparisonvaluenode: isFieldCmp && isRef,
        asx_minexpectedrows: isRowCount,
        asx_maxexpectedrows: isRowCount,
        [GRID.conditionSearchCriteria]: isRowCount
      }
    };
  }
  function actionVisibility(actionType) {
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
        asx_fieldmapping: isCreate || isUpdate
      }
    };
  }
  function tableConfigVisibility(configType) {
    const isLookup = configType === 2;
    const isChild = configType === 3;
    return {
      sections: {},
      controls: {
        asx_parenttable: isLookup || isChild,
        asx_lookupcolumnlogicalname: isLookup,
        asx_lookuptargetidattribute: isLookup,
        asx_childlinkfield: isChild
      },
      required: {
        asx_lookupcolumnlogicalname: isLookup,
        asx_lookuptargetidattribute: isLookup
      }
    };
  }

  // src/authoring/index.ts
  function applyMap(xrm, map) {
    const ctrl = map.controls;
    for (const name in ctrl)
      if (xrm.controlExists(name)) xrm.setControlVisible(name, ctrl[name]);
    const sect = map.sections;
    for (const section in sect) xrm.setSectionVisible(section, sect[section]);
    const req = map.required;
    if (req) {
      for (const name in req)
        if (xrm.hasAttribute(name)) xrm.setRequiredLevel(name, req[name] ? "required" : "none");
    }
  }
  var num = (v) => v == null ? null : Number(v);
  function registerCondition(xrm) {
    const recompute = () => applyMap(xrm, conditionVisibility(num(xrm.getValue("asx_conditiontype")), num(xrm.getValue("asx_comparisonvaluesource"))));
    xrm.addOnChange("asx_conditiontype", recompute);
    xrm.addOnChange("asx_comparisonvaluesource", recompute);
    recompute();
  }
  function registerAction(xrm) {
    const recompute = () => applyMap(xrm, actionVisibility(num(xrm.getValue("asx_actiontype"))));
    xrm.addOnChange("asx_actiontype", recompute);
    recompute();
  }
  function registerTableConfig(xrm) {
    const recompute = () => applyMap(xrm, tableConfigVisibility(num(xrm.getValue("asx_tableconfigtype"))));
    xrm.addOnChange("asx_tableconfigtype", recompute);
    recompute();
  }
  function onLoad(executionContext, register) {
    try {
      register(createXrmAdapter(executionContext.getFormContext()));
    } catch (e) {
      console.error("Ascentix Authoring: visibility wiring failed.", e);
    }
  }
  if (typeof window !== "undefined") {
    const ns = window.Ascentix = window.Ascentix || {};
    ns.Authoring = {
      onConditionLoad: (c) => onLoad(c, registerCondition),
      onActionLoad: (c) => onLoad(c, registerAction),
      onTableConfigLoad: (c) => onLoad(c, registerTableConfig)
    };
  }
})();
