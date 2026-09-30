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
| Action Type | `asx_actiontype` | Set Visible = 1, Set Required = 2, Show Message = 3, Block = 4, Create Record = 5, Update Record = 6, Delete Record = 7, Deactivate Record = 8 |
| Action Fire On | `asx_actionfireon` | On Match = 1, On No Match = 2 |
| Triggers *(multi-select)* | `asx_triggers` | On Create = 1, On Form = 2, On demand = 3 (formerly Manual), On Update = 4, On Delete = 5 |
| Runs for | `asx_ondemandscope` | A record it's given = 1 (default), All records that pass its execution conditions = 2 |
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
| Runs for | `asx_ondemandscope` | Choice (local) | No | On demand only: a record it's given (1, default) or all records that pass its execution conditions (2) |

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
| Target Node | `asx_targetnode` | Lookup → `asx_tableconfig` | No | Update / Delete / Deactivate target: a single-cardinality node (one record) or a collection node (every row, filtered by the Rows filter). Create Record: optional; a collection node means one record per filtered row (see *Value nodes* below) |
| Field Mapping | `asx_fieldmapping` | Multiline text (JSON) | No | Create/Update value map; Deactivate Record: `statuscode` only |
| Order | `asx_order` | Whole Number | No | Execution order |
| Is Active | `asx_isactive` | Yes/No | No | Default Yes |
| Also Apply To Previous | `asx_applytoprevious` | Yes/No | No | Update Record only: when the save changes the lookup above the target node, also apply the action to the record the lookup pointed to before the save. Default No |

## Value nodes

`asx_comparisonvaluenode` (on a condition) and `asx_targetnode` (on an action) are
both lookups into the same `asx_tableconfig` tree the rule's conditions traverse.

`asx_comparisonvaluenode` must resolve to a **single-cardinality** node: the Root node (the
triggering record) or a Lookup node (one related record), never a Child node.

`asx_targetnode` on an Update Record, Delete Record or Deactivate Record action accepts either
kind of node: a single-cardinality node (Root or Lookup — the action writes that one record, as
before), or a **collection** node (a Child node, or a node reached through a Child step further
down the tree) — the action then writes **every** row of that collection that passes its Rows
filter (a **set action**; see *Building Actions* → *Writing a set of rows*). Create Record's
`asx_targetnode` is optional; when set it must be a collection node, and the action creates one
record per filtered row instead of one record overall.

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
| Rule Action | `asx_ruleaction` | Lookup → `asx_ruleaction` | No | A set action's Rows filter: set on every group of the action's filter tree (root and nested). Such a group has no condition group and no condition; its `asx_tableconfignode` is the action's target node |

An EXISTS sub-filter inside a Rows filter hangs off its criterion (`asx_owningcriterion`) as
elsewhere. An action owns at most one top-level group.

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

### Rule Run (`asx_rulerun`)

One row per **Run now** / Rule Run started against an On demand rule, created by
Run now (or a caller) and driven to completion by repeated calls to
`asx_ProcessRunPage` (see *Custom APIs*). Deleting the owning rule deletes its
runs.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | Yes | The rule this run is for |
| Scope | `asx_scope` | Choice (local) | No | Set at start: Given records (1) when Record Ids are given, otherwise All records (2), which needs a rule scoped to All records |
| Record Ids | `asx_recordids` | Multiline text (20,000) | No | JSON array of Guids; Given-records runs only; at most 250 |
| Status | `asx_status` | Choice (local) | No | Queued (1), Running (2), Completed (3), Completed with failures (4), Failed (5), Cancelled (6) |
| Evaluated / Changed / Blocked / Failed / Skipped | `asx_evaluated` / `asx_changed` / `asx_blocked` / `asx_failed` / `asx_skipped` | Whole Number | No | Running totals, updated after each processed page |
| Failures | `asx_failures` | Multiline text (100,000) | No | JSON array of the first 50 `{recordId, kind, message}` |

The engine keeps these columns itself: once a run is created, the only change
anyone else can make is cancelling it (Status from Queued or Running to
Cancelled). See *Running Rules On Demand* for what these mean in practice, and
`docs/Schema.md` (§2.13/§7) in the repository for the full per-page state
machine.

### Rule Schedule (`asx_ruleschedule`)

At most one row per rule, driving the schedule that starts or continues its Rule Runs
(see *Scheduling Rules*). Deleting the owning rule deletes its schedule.

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

`asx_nextrunon`, `asx_lastrunon`, `asx_lastrun` and `asx_lastoutcome` are engine-owned:
a plug-in on Create/Update recomputes or strips them from any caller-supplied value, so
only the schedule itself (via `asx_StartDueSchedules`) ever sets them. See *Scheduling
Rules* for how the pattern, precision and catch-up behavior work in practice.

### Scheduler Status (`asx_schedulerstatus`)

A single, organization-wide heartbeat row for whatever calls `asx_StartDueSchedules` on
a timer (the scheduler add-on, or your own caller — *Scheduling Rules*), read by the
hub's status chip. The engine itself never reads it.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Last Seen On | `asx_lastseenon` | DateTime (User Local) | No | Last time a caller reported in |
| Last Seen By | `asx_lastseenby` | Lookup → `systemuser` | No | Identity of the last caller |
| Calls Today | `asx_callstoday` | Whole Number | No | Calls made so far in the current day |

### Rule Diagnostic (`asx_rulediagnostic`)

Opt-in timings for form saves. While the **Capture diagnostics** environment variable
(`asx_CaptureDiagnostics`, Yes/No, default No) is Yes, every save the engine evaluates
writes one row per saved record; see *Troubleshooting*. The engine itself never reads it.

| Column | Schema name | Type | Required | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text (100) | No | The saved record's table |
| Record Id | `asx_recordid` | Text (36) | No | The saved record's id |
| Message Name | `asx_messagename` | Text (100) | No | `Create`, `Update`, `Delete` or a `…Multiple` message |
| Correlation Id | `asx_correlationid` | Text (36) | No | The save's correlation id |
| Diagnostics | `asx_diagnostics` | Multiline text (1,048,576) | No | The save's full diagnostics JSON (see *Custom APIs*); `totalMs` is the whole save |
