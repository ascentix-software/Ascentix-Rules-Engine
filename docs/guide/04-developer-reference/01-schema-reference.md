---
title: Schema Reference
section: Developer Reference
order: 401
slug: schema-reference
---

# Schema Reference

The rule model is stored as ordinary Dataverse records in a small set of
`asx_`-prefixed tables. The default publisher prefix is `asx`, and every logical name
below assumes it. Every table carries the standard `asx_name` primary column in
addition to the columns listed here. For what these objects mean, see *Core
Concepts*.

## Global choices

All choices are **global** and single-select unless marked multi-select. Values are
stable integers. Do not assume label text; match on the value.

| Choice | Schema name | Values |
|---|---|---|
| Logical Operator | `asx_logicaloperator` | And = 1, Or = 2 |
| Table Config Type | `asx_tableconfigtype` | Root Table = 1, Lookup Table = 2, Child Table = 3 |
| Condition Type | `asx_conditiontype` | Field Comparison = 1, Row Count = 2, Regex Match = 3, Calculation = 4 |
| Comparison Operator | `asx_comparisonoperator` | Equals = 1, Not Equals = 2, Greater Than = 3, Greater Than Or Equal = 4, Less Than = 5, Less Than Or Equal = 6, Contains = 7, Does Not Contain = 8, Is Null = 9, Is Not Null = 10 |
| Severity | `asx_severity` | Information = 1, Warning = 2, Error = 3 |
| Action Type | `asx_actiontype` | Set Visible = 1, Set Required = 2, Show Message = 3, Block = 4, Create Record = 5, Update Record = 6, Delete Record = 7 |
| Action Fire On | `asx_actionfireon` | On Match = 1, On No Match = 2 |
| Triggers *(multi-select)* | `asx_triggers` | On Create = 1, On Form = 2, Manual = 3, On Update = 4, On Delete = 5 |
| Channel *(multi-select)* | `asx_channel` | Standard = 1, Portal = 2 |
| Comparison Value Source | `asx_comparisonvaluesource` | Literal = 1, Field Reference = 2, Template = 3, Date Expression = 4 |
| Evaluation Context | `asx_evaluationcontext` | User = 1, System = 2 |
| Criterion Type | `asx_criteriontype` | Comparison = 1, Exists = 2 |

## Core tables

### Rule (`asx_rule`)

The top-level object. Lifecycle uses the standard Dataverse `statecode`/`statuscode`
pair rather than a custom field. See *Rule Lifecycle* for what Draft, Published, and
Archived mean.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text | Yes | The entity the rule applies to |
| Triggers | `asx_triggers` | Choice (multi) → `asx_triggers` | Yes | At least one |
| Channels | `asx_channels` | Choice (multi) → `asx_channel` | No | Empty means all channels |
| Effective From | `asx_effectivefrom` | DateTime (UTC) | No | Null = open start |
| Effective To | `asx_effectiveto` | DateTime (UTC) | No | Null = open end |
| Evaluation Context | `asx_evaluationcontext` | Choice → `asx_evaluationcontext` | No | Default User |
| Root Table Config | `asx_roottableconfig` | Lookup → `asx_tableconfig` | Yes | The root of the rule's Table Config tree |
| Trigger Columns | `asx_triggercolumns` | Multiline Text (4000) | No | JSON array of root-table column logical names; OnUpdate only. The rule also fires when one of these columns changes (unioned with the columns its conditions reference) |

### Table Config (`asx_tableconfig`)

A node in the traversal tree. Self-referential via Parent Table.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text | Yes | Dataverse entity logical name |
| Table Config Type | `asx_tableconfigtype` | Choice → `asx_tableconfigtype` | Yes | Root / Lookup / Child |
| Parent Table | `asx_parenttable` | Lookup → `asx_tableconfig` | No | Self-referential |
| Lookup Column Logical Name | `asx_lookupcolumnlogicalname` | Text | No | Lookup Table nodes only |
| Child Link Field | `asx_childlinkfield` | Text | No | Child Table nodes only |
| Lookup Target Id Attribute | `asx_lookuptargetidattribute` | Text | No | Lookup Table nodes only: the target table's primary-id attribute |

### Condition Group (`asx_conditiongroup`)

An AND/OR node in a rule's condition tree (self-referential).

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | Parent rule |
| Parent Condition Group | `asx_parentconditiongroup` | Lookup → `asx_conditiongroup` | No | Self-referential |
| Logical Operator | `asx_logicaloperator` | Choice → `asx_logicaloperator` | Yes | And / Or |
| Is Execution Condition | `asx_isexecutioncondition` | Yes/No | Yes | Marks a group as a rule gate, evaluated before the validation groups |

### Rule Condition (`asx_rulecondition`)

A single leaf check inside a Condition Group.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Condition Group | `asx_conditiongroup` | Lookup → `asx_conditiongroup` | Yes | Parent group |
| Table Config | `asx_tableconfig` | Lookup → `asx_tableconfig` | Yes | Which node this condition evaluates |
| Condition Type | `asx_conditiontype` | Choice → `asx_conditiontype` | Yes | Field Comparison / Row Count / Regex Match / Calculation |
| Comparison Column | `asx_comparisoncolumn` | Text | No | Field to evaluate (also the target column for Regex Match) |
| Comparison Operator | `asx_comparisonoperator` | Choice → `asx_comparisonoperator` | No | Field Comparison only |
| Comparison Value | `asx_comparisonvalue` | Multiline text | No | Literal value; for Regex Match, the pattern |
| Min / Max Expected Rows | `asx_minexpectedrows` / `asx_maxexpectedrows` | Whole Number | No | Row Count only |
| Comparison Value Source | `asx_comparisonvaluesource` | Choice → `asx_comparisonvaluesource` | No | Blank = Literal; Template and Date Expression store their payload in `asx_comparisonvalue` (template text / date-expression JSON) rather than the node/column fields |
| Comparison Value Node | `asx_comparisonvaluenode` | Lookup → `asx_tableconfig` | No | Field Reference right-hand node (see *Value nodes* below) |
| Comparison Value Column | `asx_comparisonvaluecolumn` | Text | No | Field Reference right-hand column |
| Condition Expression | `asx_conditionexpression` | Multiline Text (4000) | No | LHS math expression (mathexpr) for a Calculation condition: aggregates over child collections + arithmetic, compared by a numeric operator to the RHS |

### Rule Action (`asx_ruleaction`)

The outcome layer. Columns not relevant to a given Action Type are left blank.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | Parent rule |
| Action Type | `asx_actiontype` | Choice → `asx_actiontype` | Yes | What to do |
| Fire On | `asx_fireon` | Choice → `asx_actionfireon` | Yes | On Match / On No Match |
| Target Column | `asx_targetcolumn` | Text | No | Set Visible / Set Required target; blank on a form-level Block |
| Value | `asx_valuebool` | Yes/No | No | Set Visible: show; Set Required: required |
| Apply Inverse When Not Fired | `asx_applyinversewhennotfired` | Yes/No | No | Reserved: not consumed by the current runtime and not shown in the visual editor |
| Message | `asx_message` | Multiline text | No | Show Message / Block text (default/fallback; see `asx_localizedmessage` for per-language overrides) |
| Severity | `asx_severity` | Choice → `asx_severity` | No | Notification level |
| Target Table | `asx_targettable` | Text | No | Create Record target |
| Target Node | `asx_targetnode` | Lookup → `asx_tableconfig` | No | Update / Delete Record target (see *Value nodes* below) |
| Field Mapping | `asx_fieldmapping` | Multiline text (JSON) | No | Create/Update value map |
| Order | `asx_order` | Whole Number | No | Execution order |
| Is Active | `asx_isactive` | Yes/No | No | Default Yes |

## Value nodes

`asx_comparisonvaluenode` (on a condition) and `asx_targetnode` (on an action) are
both lookups into the same `asx_tableconfig` tree the rule's conditions traverse.
Both must resolve to a **single-cardinality** node: the Root node (the triggering
record) or a Lookup node (one related record), never a Child node.

## Node filters

Node filters narrow which rows at a given `asx_tableconfig` node participate in
evaluation: for example, restricting a Row Count condition's child collection to
rows matching a criterion, or gating an "at least N related rows exist" check.

### Node Filter Group (`asx_nodefiltergroup`)

An AND/OR node in a node filter's tree (self-referential).

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Condition Group | `asx_conditiongroup` | Lookup → `asx_conditiongroup` | Yes | Scope |
| Table Config Node | `asx_tableconfignode` | Lookup → `asx_tableconfig` | No | Node targeted |
| Parent Filter Group | `asx_parentfiltergroup` | Lookup → `asx_nodefiltergroup` | No | Self-referential |
| Logical Operator | `asx_logicaloperator` | Choice → `asx_logicaloperator` | Yes | And / Or |
| Rule Condition | `asx_rulecondition` | Lookup → `asx_rulecondition` | No | Owning condition of a per-condition filter; null = legacy group-wide |
| Owning Criterion | `asx_owningcriterion` | Lookup → `asx_nodefiltercriterion` | No | Exists sub-filter root: this group is the collection's filter |

### Node Filter Criterion (`asx_nodefiltercriterion`)

A single leaf check inside a Node Filter Group.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Filter Group | `asx_filtergroup` | Lookup → `asx_nodefiltergroup` | Yes | Parent group |
| Criterion Type | `asx_criteriontype` | Choice → `asx_criteriontype` | No | Comparison / Exists; default Comparison |
| Collection Node | `asx_collectionnode` | Lookup → `asx_tableconfig` | No | Exists only: the child/lookup collection to count |
| Min Count | `asx_mincount` | Whole Number | No | Exists only: minimum matching rows (blank = 0) |
| Max Count | `asx_maxcount` | Whole Number | No | Exists only: maximum matching rows (blank = unlimited) |
| Field Name | `asx_fieldname` | Text | Yes | Column to filter on |
| Operator | `asx_operator` | Text | Yes | `eq`, `ne`, `like`, `not-like`, `null`, `not-null`, `contains`, `not-contains`, `gt`, `ge`, `lt`, `le` |
| Value | `asx_value` | Text | No | Literal comparison value |
| Comparison Value Source | `asx_comparisonvaluesource` | Choice → `asx_comparisonvaluesource` | No | Blank = Literal; Field Reference compares against another field |
| Comparison Value Node | `asx_comparisonvaluenode` | Lookup → `asx_tableconfig` | No | Field Reference right-hand node |
| Comparison Value Column | `asx_comparisonvaluecolumn` | Text | No | Field Reference right-hand column |

## Other tables

`asx_searchcriteriagroup` / `asx_searchcriterion` hold the in-memory filter used by
Row Count conditions. `asx_localizedmessage` holds per-language overrides of an
action's default message.
