# Authoring Forms (`asx_authoringforms.js`)

A TypeScript-authored, esbuild-bundled JavaScript **web resource** that drives
**conditional field visibility** on the 9 `asx_` config-table forms inside the
*Ascentix Rules Engine* model-driven app.

---

## 1. What this covers

- Per-form layout (tabs, sections, fields, subgrids) for the nine directly authored config
  tables. `asx_localizedmessage` also ships a form, but is edited through the Localized
  Messages subgrid on an action (§3).
- Curated `savedquery` views used by those subgrids.
- Sitemap structure (Authoring + Reference groups).
- The conditional-visibility handlers this bundle registers.

**This web resource is for the engine's own config forms only.** For the rules-engine
library that runs on *customer* forms, see [`docs/Client-Form-Library.md`](Client-Form-Library.md).

---

## 2. Build & deployment

```
cd client && npm run build
```

That produces `client/dist/asx_authoringforms.js`. Deploy it into the
`AscentixRulesEngine` solution as the JScript web resource
**`asx_/authoringforms/asx_authoringforms.js`**, display name **Ascentix Authoring Forms**
(create it if it does not exist, otherwise update its content), then **publish** the
customization. Repeat after every build.

The forms, curated views and sitemap are provisioned in the environment, and must exist before the
bundle has anything to attach to; §3-§6 describe the shape it expects.

---

## 3. Per-form layout

Convention: a **General** tab (header fields, grouped into named sections) + a
**Children** tab (subgrids). `[cond]` = field shown/hidden by the form script (§5).

### `asx_rule`: Rule

**General** tab

| Section | Fields |
|---|---|
| Rule | `asx_name`, `asx_tablelogicalname`, `asx_triggers` |
| Lifecycle | `statuscode`, `asx_effectivefrom`, `asx_effectiveto`, `asx_evaluationcontext`, `asx_channels` |

> `asx_severity` (rule-level) was removed from the form because the engine never reads it, and
> action-level severity is the real one.

**Logic** tab: subgrids

| Subgrid | Target entity | View |
|---|---|---|
| Execution Conditions | `asx_conditiongroup` | Asx Rule - Execution Condition Groups (top-level + `asx_isexecutioncondition` = Yes) |
| Conditions | `asx_conditiongroup` | Asx Rule - Validation Condition Groups (top-level + `asx_isexecutioncondition` = No) |
| Actions | `asx_ruleaction` | Asx Rule - Actions |

### `asx_conditiongroup`: Condition Group

**General** tab, section *Condition Group*: `asx_name`, `asx_rule`,
`asx_parentconditiongroup`, `asx_logicaloperator`, `asx_isexecutioncondition`.

**Children** tab: subgrids

| Subgrid | Target entity | View |
|---|---|---|
| Conditions | `asx_rulecondition` | Asx Condition Group - Conditions |
| Sub-groups | `asx_conditiongroup` | Asx Condition Group - Sub-groups |
| Node-Filter Groups | `asx_nodefiltergroup` | Asx Condition Group - Node-Filter Groups |

### `asx_rulecondition`: Condition (conditional-visibility)

**General** tab, sections:

| Section | Fields |
|---|---|
| Condition | `asx_name`, `asx_conditiongroup`, `asx_tableconfig`, `asx_conditiontype` |
| Comparison `[cond]` | `asx_comparisoncolumn`, `asx_comparisonoperator`, `asx_comparisonvaluesource`, `asx_comparisonvalue` `[cond]`, `asx_comparisonvaluecolumn` `[cond]`, `asx_comparisonvaluenode` `[cond]` |
| Row Count `[cond]` | `asx_minexpectedrows`, `asx_maxexpectedrows` |

**Children** tab, subgrid: *Search-Criteria Groups* (`asx_searchcriteriagroup` /
`Asx Rule Condition - Search-Criteria Groups`), shown only when `asx_conditiontype = RowCount`.

OnLoad handler: `Ascentix.Authoring.onConditionLoad` (§5).

### `asx_ruleaction`: Action (conditional-visibility)

**General** tab, section *Action*: `asx_name`, `asx_rule`, `asx_order`, `asx_actiontype`,
`asx_fireon`, `asx_applyinversewhennotfired`, plus conditional fields `[cond]`:
`asx_targetcolumn`, `asx_valuebool`, `asx_targettable`, `asx_targetnode`, `asx_message`, `asx_severity`,
`asx_fieldmapping`, `asx_isactive`. `asx_message` is labelled **"Message (default /
fallback)"**. Per-language overrides live in `asx_localizedmessage`.

**Children** tab, subgrid: *Localized Messages* (`asx_localizedmessage` /
`Asx Rule Action - Localized Messages`).

OnLoad handler: `Ascentix.Authoring.onActionLoad` (§5).

### `asx_tableconfig`: Table-Config Node (conditional-visibility)

**General** tab, section *Table Config*: `asx_name`, `asx_tablelogicalname`,
`asx_tableconfigtype`, plus conditional fields `[cond]`: `asx_parenttable`,
`asx_lookupcolumnlogicalname`, `asx_childlinkfield`.

> `asx_parentrelationshipname` was removed from the form: traversal never reads it.

**Children** tab, subgrid: *Child Nodes* (`asx_tableconfig` /
`Asx Table Config - Child Nodes`).

OnLoad handler: `Ascentix.Authoring.onTableConfigLoad` (§5).

### `asx_searchcriteriagroup`: Search Criteria Group

**General** tab, section *Search Criteria Group*: `asx_name`, `asx_rulecondition`,
`asx_parentcriteriagroup`, `asx_logicaloperator`.

**Children** tab, subgrids:

| Subgrid | Target entity | View |
|---|---|---|
| Criteria | `asx_searchcriterion` | Asx Search Criteria Group - Criteria |
| Sub-groups | `asx_searchcriteriagroup` | Asx Search Criteria Group - Sub-groups |

No conditional visibility. No OnLoad handler.

### `asx_nodefiltergroup`: Node Filter Group

**General** tab, section *Node Filter Group*: `asx_name`, `asx_conditiongroup`,
`asx_tableconfignode`, `asx_parentfiltergroup`, `asx_logicaloperator`.

**Children** tab, subgrids:

| Subgrid | Target entity | View |
|---|---|---|
| Criteria | `asx_nodefiltercriterion` | Asx Node Filter Group - Criteria |
| Sub-groups | `asx_nodefiltergroup` | Asx Node Filter Group - Sub-groups |

No conditional visibility. No OnLoad handler.

### `asx_searchcriterion`: Search Criterion (leaf)

**General** tab, section *Search Criterion*: `asx_name`, `asx_criteriagroup`,
`asx_fieldname`, `asx_operator`, `asx_value`.

No subgrids. No conditional visibility: the leaf is a single literal predicate with no
value-source column to drive.

### `asx_nodefiltercriterion`: Node Filter Criterion (leaf)

**General** tab, section *Node Filter Criterion*: `asx_name`, `asx_filtergroup`,
`asx_fieldname`, `asx_operator`, `asx_value`.

No subgrids. No conditional visibility: the leaf is a single literal predicate with no
value-source column to drive.

---

## 4. Subgrid view map

| Form | Subgrid control ID | View name | Target entity |
|---|---|---|---|
| `asx_rule` | `RuleExecutionConditionGroupsGrid` | Asx Rule - Execution Condition Groups | `asx_conditiongroup` |
| `asx_rule` | `RuleValidationConditionGroupsGrid` | Asx Rule - Validation Condition Groups | `asx_conditiongroup` |
| `asx_rule` | `RuleActionsGrid` | Asx Rule - Actions | `asx_ruleaction` |
| `asx_conditiongroup` | `ConditionGroupConditionsGrid` | Asx Condition Group - Conditions | `asx_rulecondition` |
| `asx_conditiongroup` | `ConditionGroupSubgroupsGrid` | Asx Condition Group - Sub-groups | `asx_conditiongroup` |
| `asx_conditiongroup` | `ConditionGroupNodeFilterGrid` | Asx Condition Group - Node-Filter Groups | `asx_nodefiltergroup` |
| `asx_rulecondition` | `ConditionSearchCriteriaGrid` | Asx Rule Condition - Search-Criteria Groups | `asx_searchcriteriagroup` |
| `asx_ruleaction` | `RuleActionLocalizedMessagesGrid` | Asx Rule Action - Localized Messages | `asx_localizedmessage` |
| `asx_tableconfig` | `TableConfigChildNodesGrid` | Asx Table Config - Child Nodes | `asx_tableconfig` |
| `asx_searchcriteriagroup` | `SearchCriteriaGroupCriteriaGrid` | Asx Search Criteria Group - Criteria | `asx_searchcriterion` |
| `asx_searchcriteriagroup` | `SearchCriteriaGroupSubgroupsGrid` | Asx Search Criteria Group - Sub-groups | `asx_searchcriteriagroup` |
| `asx_nodefiltergroup` | `NodeFilterGroupCriteriaGrid` | Asx Node Filter Group - Criteria | `asx_nodefiltercriterion` |
| `asx_nodefiltergroup` | `NodeFilterGroupSubgroupsGrid` | Asx Node Filter Group - Sub-groups | `asx_nodefiltergroup` |

List views (top-level navigation): the **out-of-box** `Active/Inactive` public views are
updated **in place** (column swap only, preserving each view's `statecode` filter); the
sitemap SubAreas bind these default views. No standalone curated list views are created.

| View name | Entity | Columns |
|---|---|---|
| Active Rules | `asx_rule` | Name, Table, Triggers, Channels, Status |
| Inactive Rules | `asx_rule` | Name, Table, Triggers, Status |
| Active Table Configs | `asx_tableconfig` | Name, Table, Config Type, Parent |
| Inactive Table Configs | `asx_tableconfig` | Name, Table, Config Type, Parent |

> Severity is intentionally absent from the Rule views (`asx_rule.asx_severity` is being
> retired). An earlier build's standalone "Active Rules"/"Table Configs" curated views were
> redundant: the first collided-and-skipped the OOB view, the second duplicated it.

---

## 5. Conditional visibility (form script)

`asx_authoringforms.js` exposes three named handlers under `Ascentix.Authoring.*`, each wired into
its form's `<formLibraries>` + `<event>` at provisioning time. A handler registers OnChange on its
driving column(s) and applies the visibility map immediately on load.

Forms are authored **show-by-default**: a missing or broken script degrades gracefully to
"everything visible," never "everything hidden."

### `onConditionLoad` (wired onto `asx_rulecondition`)

Driving columns: `asx_conditiontype`, `asx_comparisonvaluesource`.

| `asx_conditiontype` | Sections shown | Controls shown | Hidden |
|---|---|---|---|
| `FieldComparison` | Comparison | `asx_comparisoncolumn`, `asx_comparisonoperator`, `asx_comparisonvaluesource` + value-source sub-fields (see below) | Row Count section, Search-Criteria subgrid |
| `RowCount` | Row Count | `asx_minexpectedrows`, `asx_maxexpectedrows`, `ConditionSearchCriteriaGrid` subgrid | Comparison section |
| `RegexMatch` | Comparison | `asx_comparisoncolumn` (target) + `asx_comparisonvalue` (the regex pattern) | operator, value-source, ref sub-fields, Row Count section, subgrid |

Within `FieldComparison`, `asx_comparisonvaluesource` further controls:

| `asx_comparisonvaluesource` | Shown | Hidden |
|---|---|---|
| `Literal` (or null) | `asx_comparisonvalue` | `asx_comparisonvaluecolumn`, `asx_comparisonvaluenode` |
| `FieldReference` | `asx_comparisonvaluecolumn`, `asx_comparisonvaluenode` | `asx_comparisonvalue` |

### `onActionLoad` (wired onto `asx_ruleaction`)

Driving column: `asx_actiontype`. All conditional fields are hidden unless listed.

| `asx_actiontype` | Controls shown |
|---|---|
| `SetVisible` / `SetRequired` | `asx_targetcolumn`, `asx_valuebool`, `asx_applyinversewhennotfired` |
| `ShowMessage` | `asx_message`, `asx_severity` |
| `Block` | `asx_message`, `asx_severity`, `asx_targetcolumn` |
| `CreateRecord` | `asx_targettable`, `asx_fieldmapping` |
| `UpdateRecord` | `asx_targetnode`, `asx_fieldmapping` |
| `DeleteRecord` | `asx_targetnode` |

### `onTableConfigLoad` (wired onto `asx_tableconfig`)

Driving column: `asx_tableconfigtype`.

| `asx_tableconfigtype` | Controls shown |
|---|---|
| `Root` | (none, all linkage fields hidden) |
| `LookupTable` | `asx_parenttable`, `asx_lookupcolumnlogicalname` |
| `ChildTable` | `asx_parenttable`, `asx_childlinkfield` |

---

## 6. Sitemap

The app sitemap has two areas, **Rule Configuration** and **Reference**. Rule Configuration
holds the Authoring, Configuration and Help groups:

**Authoring**
- Visual Rule Editor: the `asx_ruleeditor` web resource

**Configuration** (primary record entry points)
- Rules: `asx_rule`
- Table Configs: `asx_tableconfig`

**Help**
- Documentation: the in-app help viewer

Children are reached via subgrids on the parent record, not via the sitemap.

**Reference** (power-user direct access)
- Condition Groups: `asx_conditiongroup`
- Conditions: `asx_rulecondition`
- Actions: `asx_ruleaction`
- Search Criteria Groups: `asx_searchcriteriagroup`
- Search Criteria: `asx_searchcriterion`
- Node Filter Groups: `asx_nodefiltergroup`
- Node Filter Criteria: `asx_nodefiltercriterion`
- Localized Messages: `asx_localizedmessage`

---

## 7. Module overview

| Module | Responsibility |
|---|---|
| `client/src/authoring/visibility.ts` | Pure visibility-map functions (`conditionVisibility`, `actionVisibility`, `tableConfigVisibility`). Unit-tested with vitest. |
| `client/src/authoring/index.ts` | `applyMap` helper + `register*` wiring functions + `Ascentix.Authoring` namespace exposed on `window`. Entry point bundled to `dist/asx_authoringforms.js`. |
| `client/src/xrm.ts` | Shared `XrmAdapter` interface (used by both the client library and the authoring bundle). |

> **Control classid gotcha.** A multi-select option set ("Choices") control uses classid
> `{4AA28AB7-9C13-4F57-A73D-AD894D048B5F}`, distinct from the single-select picklist
> `{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}`. Provisioning a Choices column with the picklist
> classid makes the control render on top of its neighbours.

## Known follow-up

Set the web resource's **display name** explicitly when deploying (*Ascentix Authoring Forms*).
Deployment tooling that derives it from the file name instead leaves the raw basename showing in
the solution's component list.
