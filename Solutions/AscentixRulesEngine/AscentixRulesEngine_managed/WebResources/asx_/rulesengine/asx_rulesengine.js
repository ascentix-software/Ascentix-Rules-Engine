"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

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

  // src/api.ts
  var STRING_PARAM = { typeName: "Edm.String", structuralProperty: 1 };
  function createApi(execute) {
    return {
      readRules(table, triggers) {
        return __async(this, null, function* () {
          const request = {
            TableName: table,
            Triggers: triggers,
            getMetadata: () => ({
              boundParameter: null,
              operationType: 1,
              // Function
              operationName: "asx_ReadRules",
              parameterTypes: { TableName: STRING_PARAM, Triggers: STRING_PARAM }
            })
          };
          const body = yield (yield execute(request)).json();
          if (body == null || body.Rules == null)
            throw new Error("asx_ReadRules returned no Rules payload");
          return JSON.parse(body.Rules);
        });
      },
      runRules(table, recordId, recordJson, triggers) {
        return __async(this, null, function* () {
          const params = {
            TableName: table,
            RecordJson: recordJson,
            Triggers: triggers
          };
          const paramTypes = {
            TableName: STRING_PARAM,
            RecordJson: STRING_PARAM,
            Triggers: STRING_PARAM
          };
          if (recordId !== null) {
            params.RecordId = recordId;
            paramTypes.RecordId = STRING_PARAM;
          }
          const request = __spreadProps(__spreadValues({}, params), {
            getMetadata: () => ({
              boundParameter: null,
              operationType: 0,
              // Action
              operationName: "asx_RunRules",
              parameterTypes: paramTypes
            })
          });
          const body = yield (yield execute(request)).json();
          if (body == null || body.Results == null)
            throw new Error("asx_RunRules returned no Results payload");
          const fired = JSON.parse(body.Results);
          return {
            isValid: body == null ? void 0 : body.IsValid,
            failedRuleCount: body == null ? void 0 : body.FailedRuleCount,
            firedActions: fired
          };
        });
      }
    };
  }

  // src/applier.ts
  function snapshotBaseline(xrm, universeControls) {
    const visible = {};
    const required = {};
    for (const c of universeControls) {
      visible[c] = xrm.getControlVisible(c);
      required[c] = xrm.getRequiredLevel(c);
    }
    return { visible, required };
  }
  function levelFor(severity) {
    switch (severity) {
      case "Warning":
        return "WARNING";
      case "Error":
        return "ERROR";
      default:
        return "INFO";
    }
  }
  var Applier = class {
    constructor(xrm, baseline, universeControls) {
      this.xrm = xrm;
      this.baseline = baseline;
      this.universeControls = universeControls;
      // What we believe is currently ON the form, updated as each Xrm call succeeds and never
      // ahead of reality, so a throw part-way through a commit still leaves an accurate record
      // for the next cycle (and for its retraction pass) to work from.
      this.liveControlNotes = [];
      this.liveFormNotes = [];
    }
    // ATOMICITY. A `reset(); then re-apply` shape is not acceptable here: a throw from any Xrm
    // call in the re-apply would leave the user looking at a CLEAN form (the previous cycle's
    // blocking message gone) and concluding their record was now valid.
    //
    // The chosen shape is compute-then-commit with the destructive step LAST:
    //   1. plan():    fold the fired actions into the full next state. Pure w.r.t. the form.
    //   2. commit():  issue this cycle's notifications, THEN retract last cycle's that this one
    //                 does not re-issue, THEN drive every governed control to its final value.
    //
    // Snapshot-and-roll-back was considered and rejected: rolling back means re-issuing the
    // previous notifications through the very Xrm calls that just failed, so in the failure mode
    // that actually occurs (a form API that is throwing), the rollback throws too and the form
    // is wiped anyway. Ordering the commit so nothing is torn down before its replacement is
    // established needs no such second chance: the worst outcome of a throw is a form still
    // wearing last cycle's decoration, which is exactly what "retains the last successful
    // cycle's state" (docs/Client-Form-Library.md §5) promises.
    //
    // Note there is no reset-to-baseline pass any more. Controls are set straight to their
    // computed final value, which is idempotent, means no visible flicker, and means a partial
    // commit leaves a control on either its old or its new value, never stripped to baseline.
    apply(fired) {
      this.commit(this.plan(fired));
    }
    plan(fired) {
      const next = {
        visible: __spreadValues({}, this.baseline.visible),
        required: __spreadValues({}, this.baseline.required),
        controlNotes: [],
        formNotes: []
      };
      fired.forEach((a, i) => this.planOne(next, a, i));
      return next;
    }
    commit(next) {
      const keep = /* @__PURE__ */ new Set([
        ...next.controlNotes.map((n) => n.uid),
        ...next.formNotes.map((n) => n.uid)
      ]);
      for (const n of next.controlNotes) {
        this.xrm.setControlNotification(n.name, n.message, n.uid);
        if (!this.liveControlNotes.some((l) => l.name === n.name && l.uid === n.uid))
          this.liveControlNotes.push({ name: n.name, uid: n.uid });
      }
      for (const n of next.formNotes) {
        this.xrm.setFormNotification(n.message, n.level, n.uid);
        if (!this.liveFormNotes.includes(n.uid)) this.liveFormNotes.push(n.uid);
      }
      for (const n of this.liveControlNotes.slice()) {
        if (keep.has(n.uid)) continue;
        this.xrm.clearControlNotification(n.name, n.uid);
        this.liveControlNotes = this.liveControlNotes.filter((l) => l !== n);
      }
      for (const uid of this.liveFormNotes.slice()) {
        if (keep.has(uid)) continue;
        this.xrm.clearFormNotification(uid);
        this.liveFormNotes = this.liveFormNotes.filter((l) => l !== uid);
      }
      const governed = /* @__PURE__ */ new Set([
        ...this.universeControls,
        ...Object.keys(next.visible),
        ...Object.keys(next.required)
      ]);
      for (const c of governed) {
        if (c in next.visible) this.xrm.setControlVisible(c, next.visible[c]);
        if (c in next.required) this.xrm.setRequiredLevel(c, next.required[c]);
      }
    }
    // The index disambiguates notifications when one rule has multiple form-targeted
    // actions firing in the same cycle (e.g. a form-level Block + a ShowMessage). Without
    // it, two actions would share a uid and the platform would silently overwrite one.
    uid(a, index) {
      var _a;
      return `${a.ruleId}:${(_a = a.targetColumn) != null ? _a : "form"}:${index}`;
    }
    planOne(next, a, index) {
      var _a;
      switch (a.actionType) {
        case "SetVisible":
          if (a.targetColumn) next.visible[a.targetColumn] = a.value === true;
          return;
        case "SetRequired":
          if (a.targetColumn)
            next.required[a.targetColumn] = a.value === true ? "required" : "none";
          return;
        case "ShowMessage": {
          const uid = this.uid(a, index);
          const msg = (_a = a.message) != null ? _a : "";
          if (a.targetColumn && this.xrm.controlExists(a.targetColumn))
            next.controlNotes.push({ name: a.targetColumn, message: msg, uid });
          else next.formNotes.push({ message: msg, level: levelFor(a.severity), uid });
          return;
        }
        case "Block":
          this.planBlock(next, a, index);
          return;
        // CreateRecord and any unknown server action: ignored on the client.
        default:
          return;
      }
    }
    planBlock(next, a, index) {
      var _a;
      const uid = this.uid(a, index);
      const msg = (_a = a.message) != null ? _a : "";
      if (a.targetColumn && this.xrm.controlExists(a.targetColumn)) {
        next.controlNotes.push({ name: a.targetColumn, message: msg, uid });
      } else {
        next.formNotes.push({ message: msg, level: "ERROR", uid });
      }
    }
  };

  // src/recordJson.ts
  function buildRecordJson(xrm, columns) {
    const out = {};
    for (const col of columns) {
      if (!xrm.hasAttribute(col)) continue;
      out[col] = encode(xrm.getAttributeType(col), xrm.getValue(col));
    }
    return out;
  }
  function encodeRecordJson(xrm, columns) {
    return JSON.stringify(buildRecordJson(xrm, columns));
  }
  function encode(type, value) {
    if (value === null || value === void 0) return null;
    switch (type) {
      case "lookup": {
        const arr = value;
        if (!arr || arr.length === 0) return null;
        const ref = arr[0];
        if (!ref.id || !ref.entityType) return null;
        return { id: ref.id.replace(/[{}]/g, ""), logicalname: ref.entityType };
      }
      case "multiselectoptionset":
        return value;
      // number[]
      case "datetime":
        return value instanceof Date ? value.toISOString() : value;
      // optionset/boolean/integer/decimal/double/money/string/memo: primitive as-is
      default:
        return value;
    }
  }

  // src/classifier.ts
  function classify(_rule) {
    return "NeedsExternal";
  }

  // src/engine.ts
  function rootNodeIds(rule) {
    const ids = /* @__PURE__ */ new Set();
    for (const n of rule.tableConfig) if (n.tableConfigType === "RootTable") ids.add(n.tableConfigId);
    return ids;
  }
  function eachCondition(groups, fn) {
    for (const g2 of groups) {
      for (const c of g2.conditions) fn(c);
      eachCondition(g2.groups, fn);
    }
  }
  function computeDependencyColumns(env) {
    const cols = /* @__PURE__ */ new Set();
    for (const rule of env.rules) {
      const roots = rootNodeIds(rule);
      eachCondition(rule.conditionGroups, (c) => {
        if (c.tableConfigId && roots.has(c.tableConfigId)) {
          if (c.comparisonColumn) cols.add(c.comparisonColumn);
          if (c.valueSource === "FieldReference" && c.referencedColumn) {
            const refRoot = c.referencedTableConfigId === null || roots.has(c.referencedTableConfigId);
            if (refRoot) cols.add(c.referencedColumn);
          }
        }
      });
    }
    return Array.from(cols);
  }
  function computeActionUniverse(env) {
    const cols = /* @__PURE__ */ new Set();
    for (const rule of env.rules)
      for (const a of rule.actions) if (a.targetColumn) cols.add(a.targetColumn);
    return Array.from(cols);
  }
  function bootstrap(xrm, api) {
    return __async(this, null, function* () {
      let env;
      try {
        env = yield api.readRules(xrm.getTableLogicalName(), "OnForm");
      } catch (e) {
        console.error("Ascentix RulesEngine: failed to load rules; skipping.", e);
        return;
      }
      const depColumns = computeDependencyColumns(env);
      const universe = computeActionUniverse(env);
      const baseline = snapshotBaseline(xrm, universe);
      const applier = new Applier(xrm, baseline, universe);
      const anyNeedsExternal = env.rules.some((r) => classify(r) === "NeedsExternal");
      let sequence = 0;
      const cycle = () => __async(this, null, function* () {
        const mine = ++sequence;
        if (!anyNeedsExternal) {
          applier.apply([]);
          return;
        }
        try {
          const recordJson = encodeRecordJson(xrm, depColumns);
          const result = yield api.runRules(xrm.getTableLogicalName(), xrm.getRecordId(), recordJson, "OnForm");
          if (mine !== sequence) return;
          applier.apply(result.firedActions);
        } catch (e) {
          console.error("Ascentix RulesEngine: evaluation failed; retaining last state.", e);
          return;
        }
      });
      const fireCycle = () => {
        void cycle().catch(
          (e) => console.error("Ascentix RulesEngine: evaluation failed; retaining last state.", e)
        );
      };
      for (const col of depColumns)
        if (xrm.hasAttribute(col)) xrm.addOnChange(col, fireCycle);
      yield cycle();
    });
  }
  function onLoad(executionContext) {
    const formContext = executionContext.getFormContext();
    const xrm = createXrmAdapter(formContext);
    const execute = Xrm.WebApi.online.execute.bind(Xrm.WebApi.online);
    const api = createApi(execute);
    void bootstrap(xrm, api).catch(
      (e) => console.error("Ascentix RulesEngine: bootstrap error.", e)
    );
  }

  // src/index.ts
  var g = globalThis;
  g.Ascentix = g.Ascentix || {};
  g.Ascentix.RulesEngine = { onLoad };
})();
