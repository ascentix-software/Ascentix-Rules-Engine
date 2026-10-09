---
title: Schema Reference
section: Developer Reference
order: 401
slug: schema-reference
---

# Schema Reference

Rules are ordinary Dataverse records in `asx_`-prefixed tables (the default publisher prefix).
Every table also has the standard `asx_name` primary column. For what the objects mean, see *Core
Concepts*.

## Global choices

Global and single-select unless marked. Values are stable integers: match on the value, not the
label.

| Choice | Schema name | Values |
|---|---|---|
| Logical Operator | `asx_logicaloperator` | And = 1, Or = 2 |
| Table Config Type | `asx_tableconfigtype` | Root Table = 1, Lookup Table = 2, Child Table = 3 |
| Condition Type | `asx_conditiontype` | Field Comparison = 1, Row Count = 2, Regex Match = 3, Calculation = 4 |
| Comparison Operator | `asx_comparisonoperator` | Equals = 1, Not Equals = 2, Greater Than = 3, Greater Than Or Equal = 4, Less Than = 5, Less Than Or Equal = 6, Contains = 7, Does Not Contain = 8, Is Null = 9, Is Not Null = 10 |
| Severity | `asx_severity` | Information = 1, Warning = 2, Error = 3 |
| Action Type | `asx_actiontype` | Set Visible = 1, Set Required = 2, Show Message = 3, Block = 4, Create Record = 5, Update Record = 6, Delete Record = 7, Deactivate Record = 8 |
| Action Fire On | `asx_actionfireon` | On Match = 1, On No Match = 2 (retired; see *Rule Action*) |
| Triggers *(multi-select)* | `asx_triggers` | On Create = 1, On Form = 2, On demand = 3 (formerly Manual), On Update = 4, On Delete = 5 |
| Runs for | `asx_ondemandscope` | A record it's given = 1 (default), All records that pass its execution conditions = 2 |
| Channel *(multi-select)* | `asx_channel` | Standard = 1, Portal = 2 |
| Comparison Value Source | `asx_comparisonvaluesource` | Literal = 1, Field Reference = 2, Template = 3, Date Expression = 4 |
| Evaluation Context | `asx_evaluationcontext` | User = 1, System = 2 |
| Criterion Type | `asx_criteriontype` | Comparison = 1, Exists = 2 |

## Core tables

### Rule (`asx_rule`)

Lifecycle is the standard `statecode`/`statuscode` pair (*Rule Lifecycle*: Draft, Published,
Archived).

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
| Runs for | `asx_ondemandscope` | Choice (local) | No | On demand only: a record it's given (1, default) or all records that pass its execution conditions (2) |

### Table Config (`asx_tableconfig`)

A node in the traversal tree, self-referential through Parent Table.

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
| Name | `asx_name` | Text | No | Outcome name for a top-level validation group: required, unique in the rule |

A top-level validation group is an **outcome**; actions test outcomes to decide when to fire
(*Action Condition Group*).

### Rule Condition (`asx_rulecondition`)

A leaf check inside a Condition Group.

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

An action fires only when its *Fires when* tree holds (the next two tables); with no tree it never
fires. Columns that don't apply to the Action Type are blank.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | Parent rule |
| Action Type | `asx_actiontype` | Choice → `asx_actiontype` | Yes | What to do |
| Fire On | `asx_fireon` | Choice → `asx_actionfireon` | No | Retired: the engine doesn't read it; data update 1 converts and clears it (*Data Updates*); removed in the next release |
| Target Column | `asx_targetcolumn` | Text | No | Set Visible / Set Required target; blank on a form-level Block |
| Value | `asx_valuebool` | Yes/No | No | Set Visible: show; Set Required: required |
| Apply Inverse When Not Fired | `asx_applyinversewhennotfired` | Yes/No | No | Reserved: not consumed by the current runtime and not shown in the visual editor |
| Message | `asx_message` | Multiline text | No | Show Message / Block text (default/fallback; see `asx_localizedmessage` for per-language overrides) |
| Severity | `asx_severity` | Choice → `asx_severity` | No | Notification level |
| Target Table | `asx_targettable` | Text | No | Create Record target |
| Target Node | `asx_targetnode` | Lookup → `asx_tableconfig` | No | Update / Delete / Deactivate target: a single-cardinality node (one record) or a collection node (every row, filtered by the Rows filter). Create Record: optional; a collection node means one record per filtered row (see *Value nodes* below) |
| Field Mapping | `asx_fieldmapping` | Multiline text (JSON) | No | Create/Update value map; Deactivate Record: `statuscode` only |
| Order | `asx_order` | Whole Number | No | Execution order |
| Is Active | `asx_isactive` | Yes/No | No | Default Yes |
| Also Apply To Previous | `asx_applytoprevious` | Yes/No | No | Update Record only: when the save changes the lookup above the target node, also apply the action to the record the lookup pointed to before the save. Default No |

### Action Condition Group (`asx_actionconditiongroup`)

A node of an action's *Fires when* tree: outcome tests combined with ALL or ANY.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule Action | `asx_ruleaction` | Lookup → `asx_ruleaction` | Yes | The action the node belongs to. Every node carries it, not just the root. Deleting the action deletes its tree |
| Parent Group | `asx_parentgroup` | Lookup → `asx_actionconditiongroup` | No | Blank = the root. An action has at most one root |
| Logical Operator | `asx_logicaloperator` | Choice | Yes | ALL = 1 (every child must hold), ANY = 2 (at least one must hold) |
| Order | `asx_order` | Whole Number | No | Position among siblings |

A root ALL group with no children always holds ("Always, when the rule runs").

### Action Condition Test (`asx_actionconditiontest`)

A leaf of a *Fires when* tree: "this outcome is true" or "this outcome is false".

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Group | `asx_actionconditiongroup` | Lookup → `asx_actionconditiongroup` | Yes | The group the test is in. Deleting the group deletes its tests |
| Outcome | `asx_outcome` | Lookup → `asx_conditiongroup` | Yes | A top-level validation group of the same rule. Deleting the outcome removes the link, and publishing then reports an error |
| Expected | `asx_expected` | Yes/No | Yes | Yes = "is true" (default), No = "is false" |
| Order | `asx_order` | Whole Number | No | Position among siblings |

## Value nodes

`asx_comparisonvaluenode` (condition) and `asx_targetnode` (action) both point into the rule's
`asx_tableconfig` tree.

| Lookup | Accepts |
|---|---|
| `asx_comparisonvaluenode` | A **single-cardinality** node only: Root (the triggering record) or Lookup (one related record), never Child |
| `asx_targetnode` on Update, Delete or Deactivate Record | A single-cardinality node (writes that one record), or a **collection** node (a Child node, or any node below a Child step): writes **every** row that passes the Rows filter, a **set action** (*Building Actions* → *Writing a set of rows*) |
| `asx_targetnode` on Create Record | Optional. When set, a collection node: one record per filtered row |

## Node filters

Node filters narrow which rows at an `asx_tableconfig` node take part: for example, only some of a
Row Count condition's child rows, or an "at least N related rows exist" check.

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
| Rule Action | `asx_ruleaction` | Lookup → `asx_ruleaction` | No | A set action's Rows filter: set on every group of the action's filter tree (root and nested). Such a group has no condition group and no condition; its `asx_tableconfignode` is the action's target node |

An EXISTS sub-filter in a Rows filter hangs off its criterion (`asx_owningcriterion`), as
elsewhere. An action owns at most one top-level group.

### Node Filter Criterion (`asx_nodefiltercriterion`)

A leaf check inside a Node Filter Group.

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

- `asx_searchcriteriagroup` / `asx_searchcriterion`: the in-memory filter of Row Count conditions.
- `asx_localizedmessage`: per-language overrides of an action's message.

### Rule Run (`asx_rulerun`)

One row per run of an On demand rule, created by **Apply to records** (or a caller) and driven by
repeated `asx_ProcessRunPage` calls (*Custom APIs*). Deleting the rule deletes its runs.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | The rule this run is for |
| Scope | `asx_scope` | Choice (local) | No | Set at start: Given records (1) when Record Ids are given, otherwise All records (2), which needs a rule scoped to All records |
| Record Ids | `asx_recordids` | Multiline text (20,000) | No | JSON array of Guids; Given-records runs only; at most 250 |
| Status | `asx_status` | Choice (local) | No | Queued (1), Running (2), Completed (3), Completed with failures (4), Failed (5), Cancelled (6) |
| Evaluated / Changed / Blocked / Failed / Skipped | `asx_evaluated` / `asx_changed` / `asx_blocked` / `asx_failed` / `asx_skipped` | Whole Number | No | Running totals, updated after each processed page |
| Failures | `asx_failures` | Multiline text (100,000) | No | JSON array of the first 50 `{recordId, kind, message}` |

The engine maintains these columns. Once a run exists, the only change anyone else can make is
cancelling it (Status from Queued or Running to Cancelled). See *Running Rules On Demand*, and
`docs/Schema.md` (§2.13/§7) in the repository for the per-page state machine.

### Rule Schedule (`asx_ruleschedule`)

At most one per rule; it starts or continues the rule's Rule Runs (*Scheduling Rules*). Deleting
the rule deletes it.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | The rule this schedule drives |
| On | `asx_on` | Yes/No | No | Whether the schedule is currently active; default Yes |
| Pattern | `asx_pattern` | Choice (local) | No | Every N minutes (1), Every N hours (2), Daily (3), Weekly (4), Monthly (5) |
| Every | `asx_every` | Whole Number | No | The N in Every N minutes (15/30/45) / Every N hours (1–23) |
| Time Of Day | `asx_timeofday` | Text (5) | No | `HH:mm`, 24-hour; Daily/Weekly/Monthly |
| Days Of Week | `asx_daysofweek` | Choice (local, multi-select) | No | Sunday (0) … Saturday (6); Weekly only |
| Day Of Month | `asx_dayofmonth` | Whole Number | No | 1–31, clamped to the month's last day; Monthly only |
| Next Run On | `asx_nextrunon` | DateTime (Time Zone Independent) | No | When the schedule is next due, compared as a wall-clock value regardless of the caller's own time zone |
| Last Run On | `asx_lastrunon` | DateTime (User Local) | No | Set after the schedule last started or continued a run |
| Last Run | `asx_lastrun` | Lookup → `asx_rulerun` | No | The most recent Rule Run this schedule drove |
| Last Outcome | `asx_lastoutcome` | Choice (local) | No | Started a run (1), Continued the active run (2), Rule not runnable (3) |

`asx_nextrunon`, `asx_lastrunon`, `asx_lastrun` and `asx_lastoutcome` are engine-owned: a plug-in
recomputes or strips any value a caller supplies, so only `asx_StartDueSchedules` sets them.

### Scheduler Status (`asx_schedulerstatus`)

One organization-wide heartbeat row for whatever calls `asx_StartDueSchedules` (*Scheduling
Rules*). Only the hub's status chip reads it.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Last Seen On | `asx_lastseenon` | DateTime (User Local) | No | Last time a caller reported in |
| Last Seen By | `asx_lastseenby` | Lookup → `systemuser` | No | Identity of the last caller |
| Calls Today | `asx_callstoday` | Whole Number | No | Calls made so far in the current day |

### Rule Diagnostic (`asx_rulediagnostic`)

Opt-in save timings. While the **Capture diagnostics** environment variable
(`asx_CaptureDiagnostics`, Yes/No, default No) is Yes, every save the engine evaluates writes one
row per saved record (*Troubleshooting*). The engine never reads it.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text (100) | No | The saved record's table |
| Record Id | `asx_recordid` | Text (36) | No | The saved record's id |
| Message Name | `asx_messagename` | Text (100) | No | `Create`, `Update`, `Delete` or a `…Multiple` message |
| Correlation Id | `asx_correlationid` | Text (36) | No | The save's correlation id |
| Diagnostics | `asx_diagnostics` | Multiline text (1,048,576) | No | The save's full diagnostics JSON (see *Custom APIs*); `totalMs` is the whole save |
