# Ascentix Rules Engine Schema Reference

Authoritative reference for the Dataverse schema, kept in sync with `Ascentix.RulesEngine.Core/Schema/SchemaNames.cs`
and the deployment source. Existing schema is authored in Dataverse; published-revision
additions are provisioned by `pipelines/Configure-RuleAuthoring.ps1`. Local source does not
establish that these additions are already installed in an environment.

- **Publisher:** Ascentix · **Default prefix:** `asx` (configurable; names below use the
  default prefix and are qualified at runtime with the configured one).
- **Choices:** Global.
- **Criteria operators** (`asx_operator` on search/node-filter criteria) are **text**
  (`eq`, `ne`, `like`, `not-like`, `null`, `not-null`, `contains`, `not-contains`) to
  match the engine, rather than a choice.

> The engine enums map 1:1 to the integer choice values below. Do not renumber.

---

## 1. Global choices

| Schema name | Display | Values (label = value) |
|---|---|---|
| `asx_logicaloperator` | Logical Operator | And = 1, Or = 2 |
| `asx_tableconfigtype` | Table Config Type | Root Table = 1, Lookup Table = 2, Child Table = 3 |
| `asx_conditiontype` | Condition Type | Field Comparison = 1, Row Count = 2, Regex Match = 3, Calculation = 4 |
| `asx_comparisonoperator` | Comparison Operator | Equals = 1, Not Equals = 2, Greater Than = 3, Greater Than Or Equal = 4, Less Than = 5, Less Than Or Equal = 6, Contains = 7, Does Not Contain = 8, Is Null = 9, Is Not Null = 10 |
| `asx_severity` | Severity | Information = 1, Warning = 2, Error = 3 |
| `asx_actiontype` | Action Type | Set Visible = 1, Set Required = 2, Show Message = 3, Block = 4, Create Record = 5, Update Record = 6, Delete Record = 7, Deactivate Record = 8 |
| `asx_actionfireon` | Action Fire On | On Match = 1, On No Match = 2 |
| `asx_triggers` | Triggers | On Create = 1, On Form = 2, On demand = 3, On Update = 4, On Delete = 5 (**multi-select**). Value 3 was labelled "Manual"; the stored value is unchanged and API trigger strings accept both `OnDemand` and the old `Manual` alias |
| `asx_channel` | Channel | Standard = 1, Portal = 2 (**multi-select**). 3 "Application" was retired 2026-08-23; the engine reads a stored 3 as Standard |
| `asx_comparisonvaluesource` | Comparison Value Source | Literal = 1, Field Reference = 2, Template = 3, Date Expression = 4 |
| `asx_evaluationcontext` | Evaluation Context | User = 1, System = 2 |
| `asx_criteriontype` | Criterion Type | Comparison = 1, Exists = 2 |

---

## 2. Tables

Every table has the standard `asx_name` primary column.

### 2.1 Rule (`asx_rule`)
Top-level rule, scoped to a table. Parent of conditions and actions.

**Lifecycle** uses the out-of-box `statecode`/`statuscode` (no custom field): status reasons
**Draft** (1, Active), **Published** (753840000, Active), and **Archived** (2, Inactive). New
rules default to **Draft**. The engine enforces **only Published** rules (within the effective
window below). `asx_isactive` is retired.

Published rules retain their normalized graph or use a saved revision referenced
by `asx_publishedrevision`. **Edit rule** creates or reopens a separate normalized
working copy linked by `asx_draftof`; it does not modify the original graph.
Publishing a working copy switches the original rule's active snapshot and advances
its version. The working copy remains Draft. Changing a rule's business table is
prohibited after creation. Existing rules require no initialization operation.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text (100) | ✔ | Entity the rule applies to |
| Published Revision | `asx_publishedrevision` | Lookup → `asx_rulerevision` | | Current active revision |
| Published Version | `asx_publishedversion` | Integer | | Publication number advanced on publish |
| Publish Hash | `asx_publishhash` | Text (64) | | Retired validation token; no longer sent or checked |
| Working Draft Of | `asx_draftof` | Lookup → `asx_rule` | | Stable identity for a separate working copy |
| Draft Base Version | `asx_draftbaseversion` | Integer | | Active publication version on which this draft is based |
| Draft Stamp | `asx_draftstamp` | Text (36) | | Retired concurrency stamp; no longer advanced or checked |
| Triggers | `asx_triggers` | MultiSelect → `asx_triggers` | ✔ | At least one (editor-enforced) |
| Runs for | `asx_ondemandscope` | Choice (local) | | On demand only: **A record it's given** (1, default) or **All records that pass its execution conditions** (2). The Rule Builder shows it only when On demand is ticked; ignored for every other trigger and saved as the default when hidden |
| Channels | `asx_channels` | MultiSelect → `asx_channel` | | Empty ⇒ applies on all channels; gates which origin channel (Standard/Portal) a rule fires on |
| Effective From | `asx_effectivefrom` | DateTime (UTC) | | Not enforced before this; null ⇒ open start |
| Effective To | `asx_effectiveto` | DateTime (UTC) | | Not enforced after this; null ⇒ open end |
| Evaluation Context | `asx_evaluationcontext` | Choice → `asx_evaluationcontext` | | Selects whether the rule's business-data traversal evaluates in the caller's context (`User` = 1, default) or as system (`System` = 2); default User preserves caller-visibility behavior |
| Evaluation Time Zone | `asx_evaluationtimezone` | Text (100) | | Windows time zone id (e.g. `Eastern Standard Time`) that decides the calendar day and wall-clock time of an instant when a Date Only or Time Zone Independent column is compared, and the instant a value without an offset (a literal such as `2026-09-01`, or a Date Only / Time Zone Independent anchor) means when a User Local column is compared; blank ⇒ UTC |
| Root Table Config | `asx_roottableconfig` | Lookup → `asx_tableconfig` | ✔ | The rule's root node; the rule's table-config tree (shareable across rules) hangs off it via `asx_parenttable`. The editor loads the whole tree from here. |
| Trigger Columns | `asx_triggercolumns` | Multiline (4000) | | JSON array of **root-table** column logical names (`["sample_lineamount"]`). **OnUpdate only**: unioned into the update step's filtering attributes alongside condition columns, so the rule also fires when one of these changes (e.g. an action depends on a column no condition references). Blank ⇒ none. |

> **No rule-level severity.** Severity is set **per action** (`asx_ruleaction.asx_severity`,
> §2.9). A former `asx_rule.asx_severity` column was removed (the engine never read it; it only
> echoed into `asx_ReadRules`).

### 2.2 Table Config (`asx_tableconfig`)
Query tree from root to any target table. Self-referential.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text (100) | ✔ | Dataverse entity logical name |
| Table Config Type | `asx_tableconfigtype` | Choice → `asx_tableconfigtype` | ✔ | Drives traversal |
| Parent Table | `asx_parenttable` | Lookup → `asx_tableconfig` | | Self-ref |
| Lookup Column Logical Name | `asx_lookupcolumnlogicalname` | Text (100) | | LookupTable nodes |
| Child Link Field | `asx_childlinkfield` | Text (100) | | ChildTable nodes |
| Lookup Target Id Attribute | `asx_lookuptargetidattribute` | Text (100) | | LookupTable nodes only. Primary-id attribute name of the lookup target table; used to batch-load lookup targets via an IN-query. Required (enforced) on LookupTable nodes. |

### 2.3 Condition Group (`asx_conditiongroup`)
AND/OR group tree. Self-referential. Belongs to a rule.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | ✔ | Parent rule |
| Parent Condition Group | `asx_parentconditiongroup` | Lookup → `asx_conditiongroup` | | Self-ref |
| Logical Operator | `asx_logicaloperator` | Choice → `asx_logicaloperator` | ✔ | Combine children |
| Is Execution Condition | `asx_isexecutioncondition` | Yes/No | ✔ | Rule gate (evaluated before validation groups) |

### 2.4 Rule Condition (`asx_rulecondition`)
A single check within a group.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Condition Group | `asx_conditiongroup` | Lookup → `asx_conditiongroup` | ✔ | Parent group |
| Table Config | `asx_tableconfig` | Lookup → `asx_tableconfig` | ✔ | Node to evaluate against |
| Condition Type | `asx_conditiontype` | Choice → `asx_conditiontype` | ✔ | Default Field Comparison |
| Comparison Column | `asx_comparisoncolumn` | Text (100) | | Field to evaluate (also the target column for RegexMatch / format types) |
| Comparison Operator | `asx_comparisonoperator` | Choice → `asx_comparisonoperator` | | |
| Comparison Value | `asx_comparisonvalue` | Multiline | | FieldComparison literal / comma-sep ints for multi-select; **for RegexMatch this holds the regex pattern** |
| Min Expected Rows | `asx_minexpectedrows` | Whole Number | | RowCount only |
| Max Expected Rows | `asx_maxexpectedrows` | Whole Number | | RowCount only |
| Comparison Value Source | `asx_comparisonvaluesource` | Choice → `asx_comparisonvaluesource` | | Blank ⇒ Literal; FieldReference compares against another field; **Template** (3) and **DateExpression** (4) store their payload in `asx_comparisonvalue` (template text / dateexpr JSON) and reuse the node/column fields only for FieldReference |
| Comparison Value Node | `asx_comparisonvaluenode` | Lookup → `asx_tableconfig` | | FieldReference RHS node; blank ⇒ same record |
| Comparison Value Column | `asx_comparisonvaluecolumn` | Text (100) | | FieldReference RHS column |
| Condition Expression | `asx_conditionexpression` | Multiline (4000) | | **Calculation (Expression = 4) only**: the LHS `mathexpr` formula (may aggregate child collections + do arithmetic); compared by a numeric operator to the RHS (which reuses the comparison-value fields) |
| Expression Filters | `asx_expressionfilters` | Multiline (100,000) | | **Calculation only**: aggregate filters map `{ "<key>": <criteria-tree> }` for `filter:<key>` tokens in the expression; same format as a field-mapping mathexpr entry's `filters` |

> **Condition types.** `FieldComparison` uses column/operator/value(-source). `RowCount` (ChildTable
> node only) uses min/max + search criteria. `RegexMatch` tests `asx_comparisoncolumn` against the
> author-supplied pattern in `asx_comparisonvalue` (an invalid/empty pattern is an author error →
> runtime exception). **`Calculation`** (`Expression` = 4, UI label "Calculation") evaluates the
> `asx_conditionexpression` `mathexpr` formula once at rule level → decimal, and compares it by a
> **numeric** operator (`= ≠ > ≥ < ≤`) to the RHS resolved from the comparison-value fields; if the
> formula or RHS has no value (empty avg/min/max, null operand, divide-by-zero, missing RHS), the
> condition is **not satisfied**.

### 2.5 Search Criteria Group (`asx_searchcriteriagroup`)
AND/OR in-memory filtering for RowCount conditions. Self-referential.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Rule Condition | `asx_rulecondition` | Lookup → `asx_rulecondition` | ✔ | Parent condition |
| Parent Criteria Group | `asx_parentcriteriagroup` | Lookup → `asx_searchcriteriagroup` | | Self-ref |
| Logical Operator | `asx_logicaloperator` | Choice → `asx_logicaloperator` | ✔ | |

### 2.6 Search Criterion (`asx_searchcriterion`)

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Criteria Group | `asx_criteriagroup` | Lookup → `asx_searchcriteriagroup` | ✔ | Parent group |
| Field Name | `asx_fieldname` | Text (100) | ✔ | |
| Operator | `asx_operator` | Text (20) | ✔ | See operator list above |
| Value | `asx_value` | Text (4000) | | |

### 2.7 Node Filter Group (`asx_nodefiltergroup`)
AND/OR filters scoped to a condition group, targeting any node in the tree. Self-referential.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Condition Group | `asx_conditiongroup` | Lookup → `asx_conditiongroup` | ✔ | Scope |
| Table Config Node | `asx_tableconfignode` | Lookup → `asx_tableconfig` | | Node targeted |
| Parent Filter Group | `asx_parentfiltergroup` | Lookup → `asx_nodefiltergroup` | | Self-ref |
| Logical Operator | `asx_logicaloperator` | Choice → `asx_logicaloperator` | ✔ | |
| Rule Condition | `asx_rulecondition` | Lookup → `asx_rulecondition` | | Owning condition of a per-condition filter; null ⇒ legacy group-wide |
| Owning Criterion | `asx_owningcriterion` | Lookup → `asx_nodefiltercriterion` | | Exists sub-filter root (this group is the collection's filter); null ⇒ legacy or comparison-criterion |
| Rule Action | `asx_ruleaction` | Lookup → `asx_ruleaction` | | A set action's Rows filter: set on every group of the action's filter tree (root and nested). Such a group has no condition group and no condition; its `asx_tableconfignode` is the action's target node. Relationship `asx_ruleaction_nodefiltergroup`, delete Cascade |

> An EXISTS sub-filter inside a Rows filter hangs off its criterion (`asx_owningcriterion`) as elsewhere. An action owns at most one top-level group.

### 2.8 Node Filter Criterion (`asx_nodefiltercriterion`)

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Filter Group | `asx_filtergroup` | Lookup → `asx_nodefiltergroup` | ✔ | Parent group |
| Criterion Type | `asx_criteriontype` | Choice → `asx_criteriontype` | | Default Comparison; **Exists** = "collection has min..max rows matching the sub-filter (the nodefiltergroup owned by this criterion)" |
| Collection Node | `asx_collectionnode` | Lookup → `asx_tableconfig` | | Exists only: the child/lookup collection to count |
| Min Count | `asx_mincount` | Whole Number | | Exists only: minimum matching rows (null/blank ⇒ 0) |
| Max Count | `asx_maxcount` | Whole Number | | Exists only: maximum matching rows (null/blank ⇒ unlimited) |
| Field Name | `asx_fieldname` | Text (100) | ✔ | |
| Operator | `asx_operator` | Text (20) | ✔ | See operator list above; supports `eq`, `ne`, `like`, `not-like`, `null`, `not-null`, `contains`, `not-contains`, `gt`, `ge`, `lt`, `le` |
| Value | `asx_value` | Text (4000) | | |
| Comparison Value Source | `asx_comparisonvaluesource` | Choice → `asx_comparisonvaluesource` | | Blank ⇒ Literal; FieldReference compares against another field; **DateExpression** (4) holds a dateexpr JSON payload in `asx_value` (a field anchor with no node reads the filtered row; a null anchor, on the row or on the related record, makes the criterion false) |
| Comparison Value Node | `asx_comparisonvaluenode` | Lookup → `asx_tableconfig` | | FieldReference RHS node; blank ⇒ same record |
| Comparison Value Column | `asx_comparisonvaluecolumn` | Text (100) | | FieldReference RHS column |

### 2.9 Rule Action (`asx_ruleaction`)
The outcome layer. Child of `asx_rule`. The rule's conditions evaluate to **match /
no-match**; each action fires per `asx_fireon`. Columns not relevant to a given
`asx_actiontype` are left blank (the action dispatcher / editor enforces per-type
requirements at the application level).

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Rule | `asx_rule` | Lookup → `asx_rule` | ✔ | Parent rule |
| Action Type | `asx_actiontype` | Choice → `asx_actiontype` | ✔ | What to do |
| Fire On | `asx_fireon` | Choice → `asx_actionfireon` | ✔ | Match / No-Match |
| Target Column | `asx_targetcolumn` | Text (100) | | Form-action target (blank = form-level) |
| Value | `asx_valuebool` | Yes/No | | Value to apply (Visible: yes=show; Required: yes=required) |
| Apply Inverse When Not Fired | `asx_applyinversewhennotfired` | Yes/No | | Reserved: not consumed by the current runtime and not shown in the visual editor |
| Message | `asx_message` | Multiline | | ShowMessage / Block text (**default/fallback**); per-language overrides live in `asx_localizedmessage` |
| Severity | `asx_severity` | Choice → `asx_severity` | | Notification level / message severity |
| Target Table | `asx_targettable` | Text (100) | | CreateRecord target table |
| Target Node | `asx_targetnode` | Lookup → `asx_tableconfig` | | Update/Delete/Deactivate: a single-cardinality node (one record) or a collection node (every row, filtered by the Rows filter). Create Record: optional; a collection node means one record per filtered row. |
| Field Mapping | `asx_fieldmapping` | Multiline (JSON) | | Create/Update value map; Deactivate: `statuscode` only (see format below) |
| Order | `asx_order` | Whole Number | | Execution order |
| Is Active | `asx_isactive` | Yes/No | | Default Yes |
| Also Apply To Previous | `asx_applytoprevious` | Yes/No | | Update Record only: when the save changes the lookup above the target node, also apply the action to the record the lookup pointed to before the save. Default No |

> **Write actions (CreateRecord / UpdateRecord / DeleteRecord)** are executed by the **plugin**
> (enforcing adapter): synchronously, in the triggering operation's transaction (atomic: a write
> failure rolls everything back), only at `context.Depth == 1`, and under the rule's
> `asx_evaluationcontext` (User → caller, System → system). If any `Block` fires, the plugin throws
> and performs **no** writes (block wins). `asx_RunRules` **reports** the resolved write (see §3)
> but never executes it. An UpdateRecord targeting the root node on a Create/Update applies its
> values to the in-flight record in place. That in-place path does not cover
> `UpdateMultiple`/`DeleteMultiple`. A set action writes every filtered row; one record's writes
> are merged, unchanged rows skipped, and sent as creates, then updates, then deletes per table
> (see the guide's *Building Actions*).

**Field-mapping format (`asx_fieldmapping`)** is a JSON array, one entry per target column:

```jsonc
[
  { "target": "subject",     "source": "literal", "value": "Follow up" },
  { "target": "statuscode",  "source": "literal", "value": 2 },
  { "target": "regardingid", "source": "root",    "column": "accountid" },
  { "target": "ownerid",     "source": "node",    "node": "<tableconfig-guid>", "column": "manager" },
  { "target": "regardingobjectid", "source": "row", "column": "contactid" },
  { "target": "subject2",    "source": "template", "template": "Follow up: {root.name} — {node:<tableconfig-guid>.fullname}" },
  { "target": "followupby",  "source": "dateexpr", "anchor": { "kind": "now" }, "op": "add", "amount": 3, "unit": "days" }
]
```

`literal` values use the RecordJson encoding (see §3) and are coerced to the target column's CLR type
via attribute metadata; `root`/`node` copy a raw attribute value off the triggering record or a
single-cardinality related node. `row` (set actions only) copies a column of the current row; a
lookup target naming the row's own id column links to the row. DeleteRecord ignores `asx_fieldmapping`.

`template` (String/Memo targets only) renders literal text with `{root.<column>}` /
`{node:<tableconfig-guid>.<column>}` / `{row.<column>}` tokens (`{{`/`}}` escape braces); values format for humans
(option-set labels, lookup names, formatted values), null fields render empty, and malformed or
unknown tokens are configuration errors. `dateexpr` (DateTime targets only) computes
anchor ± amount unit (`minutes|hours|days|weeks|months|years`; weeks = 7 days; months/years clamp
at month end); the anchor is `{"kind":"now"}` (pipeline execution time, UTC) or
`{"kind":"field","node":null|"<tableconfig-guid>","column":"<col>"}` (null node ⇒ root record);
a null anchor field skips the column.

> **No out-of-the-box issue table.** Outcomes are returned to callers (via the
> `asx_RunRules` Custom API) and/or applied in place; persisting to a table is the
> opt-in `CreateRecord` action targeting the customer's own tables.

### 2.10 Localized Message (`asx_localizedmessage`)
Per-language message text for an action. The action's `asx_message` is the
default/fallback (org base language); the plugin renders the caller's UI language, falling
back to `asx_message` then the engine default.

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Rule Action | `asx_ruleaction` | Lookup → `asx_ruleaction` | ✔ | Parent action |
| Language Code | `asx_languagecode` | Whole Number | ✔ | LCID (e.g. 1033, 1036, 3084) |
| Message | `asx_message` | Multiline | ✔ | Localized text for that language |

> **Note:** there is no settings table in the shipped schema. A single-row `asx_enginesettings`
> table briefly existed for a pushdown mode switch and was removed; the engine has one supported
> behaviour and no implementation-mode toggles.

---

### 2.11 Rule Revision (`asx_rulerevision`)

Organization-owned saved configuration. Direct access uses Dataverse role privileges.
The authoring workflow creates revisions on publication and deletes them with the owning rule.

| Column | Type | Notes |
|---|---|---|
| `asx_rule` | Lookup → `asx_rule` | Owning stable rule identity; RemoveLink supports transactional rule cleanup |
| `asx_version` | Integer | Number within the rule |
| `asx_definition` | Memo (1,000,000) | Format 1 snapshot of typed configuration rows; maximum 10,000 rows |
| `asx_hash` | Text (64) | SHA-256 of serialized snapshot |
| `asx_publisher` | Lookup → `systemuser` | Publishing user, or author whose shared-model edit preserved existing behavior |
| `asx_publishedon` | DateTime | Snapshot creation time in UTC |

### 2.12 Publication Lock (`asx_publicationlock`)

Retired coordination table. The current runtime does not read, write, or acquire
this lock; existing schema components do not affect authoring behavior.

### 2.13 Rule Run (`asx_rulerun`)

User-owned. One row per **Run now** execution of an On demand rule, created by the starter
(hub / Rule Builder or a custom caller) and driven to completion by repeated calls to
`asx_ProcessRunPage` (§7). Deleting the owning rule cascades and deletes its runs.

| Column | Type | Notes |
|---|---|---|
| `asx_name` | Text (200, primary) | `"<rule name> – <started on>"` |
| `asx_rule` | Lookup → `asx_rule` | Required; delete cascade (deleting the rule deletes its runs) |
| `asx_scope` | Choice (local) | Set at start: **Given records** (1) when record ids are given, otherwise **All records** (2), which needs a rule scoped to All records |
| `asx_recordids` | Memo (20,000) | JSON array of Guids; given-records runs only; at most 250 |
| `asx_status` | Choice (local) | Queued (1), Running (2), Completed (3), Completed with failures (4), Failed (5), Cancelled (6) |
| `asx_evaluated` | Integer (min 0) | Running total of records evaluated |
| `asx_changed` | Integer (min 0) | Running total of records with at least one write applied |
| `asx_blocked` | Integer (min 0) | Running total of records that fired a Block action |
| `asx_failed` | Integer (min 0) | Running total of records that errored |
| `asx_skipped` | Integer (min 0) | Running total of records that did not pass the execution conditions |
| `asx_failures` | Memo (100,000) | JSON array of the first 50 `{recordId, kind: "Blocked"\|"Failed", message}` |
| `asx_bookmark` | Memo (100,000) | JSON: the page number, paging cookie and the ids already handled on that page (All records), or the next index (Given records); either scope also lists reported failed ids to skip. `offset` is kept for compatibility and always 0 |
| `asx_ruleversions` | Memo (4,000) | JSON array of the published revision ids used across pages |
| `asx_startedon` | DateTime (UserLocal) | Set when the run is created |
| `asx_lastpageon` | DateTime (UserLocal) | Set after each processed page |
| `asx_finishedon` | DateTime (UserLocal) | Set when the run reaches a terminal status |

**Lifecycle:** a synchronous pre-operation plug-in (`Ascentix.RulesEngine.Plugin.RuleRunPlugin`)
on Create sets the status to Queued, sets the Scope (Given records when record ids are given, All
records otherwise), validates the run (the rule is Published with On demand; the record ids parse
as a JSON array of ids, at most 250 of them, and are required for a rule scoped to **A record
it's given**; whether those records exist is checked per page, not here), clears the state
columns (`asx_bookmark`, `asx_failures`, `asx_ruleversions`, `asx_lastpageon`, `asx_finishedon`;
counts 0), and refuses the create if the same rule already has a Queued or Running run. A second
synchronous pre-operation plug-in (`Ascentix.RulesEngine.Plugin.RuleRunUpdatePlugin`) on Update
refuses every change made outside `asx_ProcessRunPage` except cancelling (setting `asx_status`
from Queued or Running to Cancelled, and nothing else) with `"Only cancelling a run is
allowed."`. `asx_ProcessRunPage` (§7) advances the run page by page.

### 2.14 Rule Schedule (`asx_ruleschedule`)

Organization-owned. At most one row per rule, driving the schedule that starts or continues its
Rule Runs. A synchronous pre-operation plug-in (`Ascentix.RulesEngine.Plugin.RuleSchedulePlugin`)
is registered on Create and Update. `asx_StartDueSchedules` (§9) reads and advances these rows,
driven from outside Dataverse on a timer.

The plug-in treats a Create without `asx_on` as On (the column's default), so validation and
`asx_nextrunon` always apply to a new schedule. It refuses a second schedule for the same rule
(`"This rule already has a schedule."`) and a schedule whose `asx_rule` is a draft row (one with
`asx_draftof` set): `"Schedules belong to the published rule."`. While On, the recurrence must
be valid, the rule (or its open draft) must be On demand with **All records** scope (`"Only On
demand rules that run for all records can be scheduled."`) and its time zone recognized (`"The
rule's time zone is not recognized."`). `asx_nextrunon`, `asx_lastrunon`, `asx_lastrun` and
`asx_lastoutcome` are dropped from any caller's Target outside `asx_StartDueSchedules`.

| Column | Type | Notes |
|---|---|---|
| `asx_name` | Text (200, primary) | |
| `asx_rule` | Lookup → `asx_rule` | Required; delete cascade (deleting the rule deletes its schedule) |
| `asx_on` | Boolean (default `true`) | Whether the schedule is currently active |
| `asx_pattern` | Choice (local) | Every N minutes (1), Every N hours (2), Daily (3), Weekly (4), Monthly (5) |
| `asx_every` | Integer (1–59) | The N in **Every N minutes** / **Every N hours** |
| `asx_timeofday` | Text (5) | `HH:mm`, used by Daily/Weekly/Monthly patterns |
| `asx_daysofweek` | Choice (local, **multi-select**) | Sunday (0) … Saturday (6); used by the Weekly pattern |
| `asx_dayofmonth` | Integer (1–31) | Used by the Monthly pattern |
| `asx_nextrunon` | DateTime (`TimeZoneIndependent`) | When the schedule is next due; compared as a wall-clock value regardless of the caller's time zone |
| `asx_lastrunon` | DateTime (UserLocal) | Set after the schedule last started or continued a run |
| `asx_lastrun` | Lookup → `asx_rulerun`, RemoveLink | The most recent Rule Run this schedule drove |
| `asx_lastoutcome` | Choice (local) | Started a run (1), Continued the active run (2), Rule not runnable (3) |

### 2.15 Scheduler Status (`asx_schedulerstatus`)

Organization-owned. Tracks the health of whatever calls `asx_StartDueSchedules` on a timer (for
example the scheduler add-on flow), for hub indicators; the engine does not read it.

| Column | Type | Notes |
|---|---|---|
| `asx_name` | Text (200, primary) | |
| `asx_lastseenon` | DateTime (UserLocal) | Last time a caller reported in |
| `asx_lastseenby` | Lookup → `systemuser`, RemoveLink | Identity of the last caller |
| `asx_callstoday` | Integer (min 0) | Calls made so far in the current day |

## 3. `asx_RunRules` Custom API

An **unbound (global) Dataverse Custom API** that evaluates the rules engine against a single
record on demand and returns every fired action plus a validity summary. It is **always
non-enforcing**: a fired `Block` action is reported, never thrown.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the record's table |
| `RecordId` | String | Yes | GUID of an existing record |
| `RecordJson` | String | Yes | Unsaved field values as a flat JSON object `{ "<logicalname>": <value> }` |
| `Triggers` | String | Yes | Single trigger name; default `Manual` |
| `IncludeDiagnostics` | Boolean | Yes | Opt in to the `Diagnostics` response property (default `false`). Ships in the product solution |

At least one of `RecordId` / `RecordJson` must be supplied (validated by the handler). Providing
both retrieves the persisted record and overlays the JSON fields on top.

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | True when no `Block` action fired |
| `FailedRuleCount` | Integer | Count of distinct rules with a fired `Block` action |
| `Results` | String | JSON array of every fired action (see shape below) |
| `Diagnostics` | String | Present only when `IncludeDiagnostics = true`: `RunDiagnostics` JSON (`Ascentix.RulesEngine.Core/Diagnostics/RunDiagnosticsSerializer.cs`) containing `totalMs`, `rulesLoaded`, `rulesEvaluated`, `rulesFired`, `retrieveCount`, `retrieveMultipleCount`, `rowsFetched`, `stages[{name,ms}]`, `nodes[{nodeId,table,retrieveCount,retrieveMultipleCount,rows}]` |

### RecordJson encoding

Attribute kinds decode as:

| Attribute kind | JSON encoding | CLR attribute |
|---|---|---|
| Lookup | `{ "id": "<guid>", "logicalname": "<table>" }` | `EntityReference` |
| Multi-select optionset | array of integers, e.g. `[1, 2]` | `OptionSetValueCollection` |
| Whole number / single-select optionset / status | integer | `int` |
| Decimal / money | fractional number | `decimal` |
| Boolean | `true` / `false` | `bool` |
| DateTime | ISO-8601 string | `string` |
| String / Memo | string | `string` |
| (any) `null` | `null` | attribute cleared/absent |

### Results JSON shape

`Results` is a JSON array, one element per **fired** action:

```json
[
  {
    "ruleId": "00000000-0000-0000-0000-000000000000",
    "actionType": "Block",
    "fireOn": "OnNoMatch",
    "targetColumn": null,
    "value": null,
    "message": "Localized message text",
    "severity": "Error",
    "targetTable": null
  }
]
```

Enums are serialized as string names (`"Block"`, `"OnMatch"`, `"Error"`). Fields irrelevant to
an action type are `null` (e.g. `targetColumn`/`value` for `Block`; `message`/`severity` for
`SetVisible`). `message` is already localized using the resolved language at evaluation time.

A fired action also carries `previousOf`: the id of the root-level lookup node when the action
fired for the previous value of a changed lookup (see *"Also apply to the previous"* under
Building Actions), absent for a normal-run action. It can only appear when the dry run evaluates
an Update — `Triggers` is `OnUpdate` and both `RecordId` and `RecordJson` are supplied (a
retrieve-and-overlay build), the only shape that carries a saved record to compare against the
overlay.

A fired **CreateRecord / UpdateRecord / DeleteRecord** action also carries a `write` object, the
fully-resolved write intent. It is **reported only** (`asx_RunRules` never executes it; the plugin does):

```json
{
  "actionType": "CreateRecord",
  "fireOn": "OnMatch",
  "write": {
    "operation": "Create",
    "targetTable": "task",
    "targetId": null,
    "values": { "subject": "Follow up", "statuscode": 2 }
  }
}
```

`operation` is `Create` / `Update` / `Delete`; `targetId` is set for Update/Delete (the resolved
target record), null for Create; `values` (omitted for Delete) is the resolved column map in the
RecordJson encoding. The `write` object is absent for non-write actions.

---

## 4. `asx_ReadRules` Custom API

A **read-only, unbound (global) Dataverse Custom API** (`IsFunction = true`) that returns the
rule definitions for a table: the assembled rule graph (triggers, condition-group tree, the
`tableconfig` nodes each condition binds to, and the actions) serialized to JSON. It evaluates
nothing.

It is modeled as a **Function**, rather than an Action like `asx_RunRules`, because it is a pure
read with no side effects, so the client can call it with an HTTP `GET`. It adds **no** columns,
choices, or tables; `SchemaNames.cs` is unchanged.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the table whose rules to return |
| `Triggers` | String | Yes | Single trigger name; default `OnForm` |

`asx_ReadRules` is record-agnostic: rule definitions depend only on the table, so there is no
`RecordId`/`RecordJson`. `Triggers` is parameterized so a future consumer can read, e.g.,
`Manual` rules; an unknown value is an argument error.

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `Rules` | String | JSON envelope: `{ tableLogicalName, languageId, rules: [...] }` (see shape below) |

`tableLogicalName` and `languageId` (the language the messages were localized to) travel inside
the envelope rather than as separate scalar out-params.

### Rule selection

`asx_ReadRules` returns only the rules a form would actually evaluate, applying the same
selection filters as the plugin and `asx_RunRules` (minus evaluation):

1. **Table**: `asx_tablelogicalname == TableName`.
2. **Status**: Published only (`statuscode == Published`).
3. **Trigger**: `asx_triggers` includes the requested trigger (default `OnForm`).
4. **Channel**: `ChannelFilter.Applies(rule, channel)` where `channel` is resolved from the
   execution context, exactly as `asx_RunRules` does.
5. **Effective dates**: `RuleScheduleFilter.IsInEffect(rule, DateTime.UtcNow)` (2H lifecycle).

When no rules match, the response is a well-formed envelope with `"rules": []`, not an error.

### Rules JSON shape

`Rules` is a JSON envelope. Field names are camelCase; enums are written as string names.

```jsonc
{
  "tableLogicalName": "account",
  "languageId": 1033,
  "rules": [
    {
      "ruleId": "00000000-0000-0000-0000-000000000000",
      "name": "Credit limit approver required for large accounts",
      "triggers": ["OnForm", "OnCreate"],
      "conditionGroups": [
        {
          "logicalOperator": "And",
          "isExecutionCondition": false,
          "hasNodeFilters": false,
          "conditions": [
            {
              "tableConfigId": "…node-guid…",
              "conditionType": "FieldComparison",
              "comparisonColumn": "creditlimit",
              "comparisonOperator": "GreaterThan",
              "valueSource": "Literal",
              "comparisonValue": "10000",
              "referencedTableConfigId": null,
              "referencedColumn": null,
              "minExpectedRows": null,
              "maxExpectedRows": null
            }
          ],
          "groups": []
        }
      ],
      "tableConfig": [
        {
          "tableConfigId": "…node-guid…",
          "tableLogicalName": "account",
          "tableConfigType": "RootTable",
          "parentTableConfigId": null,
          "lookupColumnLogicalName": null,
          "childLinkField": null
        }
      ],
      "actions": [
        {
          "actionType": "SetRequired",
          "fireOn": "OnMatch",
          "targetColumn": "creditlimitapprovedby",
          "value": true,
          "applyInverseWhenNotFired": true,
          "message": null,
          "severity": null,
          "order": 1
        }
      ]
    }
  ]
}
```

Write actions add `targetTable`, `targetNode`, and `fieldMapping` (each omitted when empty);
`actionType` serializes `"CreateRecord"` / `"UpdateRecord"` / `"DeleteRecord"`. Example action:

```jsonc
{
  "actionType": "CreateRecord",
  "fireOn": "OnMatch",
  "targetTable": "task",
  "fieldMapping": "[{\"target\":\"subject\",\"source\":\"literal\",\"value\":\"Hi\"}]",
  "order": 1
}
```

Notes:

- `tableConfig` is the node set this rule references (only the nodes `ExtractReferencedTableConfigs`
  collected: condition nodes + field-reference value-nodes), not the whole tree.
- `hasNodeFilters` is `true` on a group if that group has node-filter groups attached. Detail of
  node-filter and search-criteria rows is omitted; only the marker and `conditionType: "RowCount"`
  with `minExpectedRows`/`maxExpectedRows` appear.
- `valueSource: "FieldReference"` conditions carry `referencedTableConfigId` and `referencedColumn`;
  `Literal` conditions leave those fields `null`. A `FieldReference` condition with
  `referencedTableConfigId == null` is a **same-record** reference (the RHS column is read off
  the root record); a non-null value names the referenced node.
- Messages are pre-localized via `MessageResolver` using the envelope's `languageId`.

### Client classification predicate

The client form library classifies each rule after calling `asx_ReadRules` once per table.
A rule is **`RootOnly`** (evaluate in-browser) iff **all** hold:

1. Every condition's `tableConfigId` resolves (via the rule's `tableConfig` set) to a node with
   `tableConfigType == "RootTable"`.
2. No condition has `conditionType == "RowCount"`.
3. Every condition with `valueSource == "FieldReference"` either has `referencedTableConfigId
   == null` (a **same-record** reference, still on-form) **or** has a non-null
   `referencedTableConfigId` that resolves to a `"RootTable"` node.
4. No condition group (at any depth, execution or validation) has `hasNodeFilters == true`.

Otherwise the rule is **`NeedsExternal`** and the client delegates it to `asx_RunRules`.

The client form library that consumes both APIs is documented in
[`Client-Form-Library.md`](Client-Form-Library.md).

---

## 5. `asx_ValidateRule` Custom API

An **unbound (global) Dataverse Custom API Action** (`IsFunction = false`) that validates a
persisted `asx_rule` and returns a structured report. It is **always non-enforcing**: an invalid
rule is returned as report data, never thrown. The visual editor calls it for the authoritative
status badge and before allowing Publish.

**Registration:** `AllowedCustomProcessingStepType = None`; bound to plugin type
`Ascentix.RulesEngine.Plugin.ValidateRuleApi`. Both this API and the publish-gate step
(§5.1) go in the `AscentixRulesEngine` solution.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | String | No | GUID string of the `asx_rule` record to validate. Must be parseable as a Guid. |

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no Error-severity issue was found |
| `Issues` | String | JSON report (see shape below). Empty array `"issues":[]` when valid. |
| `DraftHash` | String | SHA-256 of the complete validated draft and referenced model configuration; publication independently validates the latest saved definition |

### Issues JSON shape

`Issues` is a JSON object with a top-level summary and the full issue list:

```json
{
  "isValid": true,
  "issues": [
    {
      "severity": "Error",
      "code": "STRUCT_NO_CONDITIONS",
      "message": "The rule has no conditions.",
      "target": {
        "kind": "Rule",
        "id": "00000000-0000-0000-0000-000000000000",
        "field": null
      }
    }
  ]
}
```

Field notes:

- `severity` is a string enum name, either `"Error"` or `"Warning"`. Only `Error` blocks publishing
  (`ValidationReport.IsValid` ignores warnings). Warnings include `STRUCT_ROWCOUNT_ON_CREATE`
  and `TRAV_PUSHDOWN`.
- `code` is a stable machine token the editor maps to inline UI. Vocabulary: `STRUCT_NO_CONDITIONS`,
  `STRUCT_NO_ACTIONS`, `STRUCT_EMPTY_GROUP`, `STRUCT_MISSING_FIELD`, `STRUCT_INVALID_REGEX`,
  `STRUCT_ROWCOUNT_RANGE`, `STRUCT_NODE_NOT_IN_TREE` (Error: a condition's `asx_tableconfig`
  binding is missing or names a node outside the rule's config tree; the engine would refuse to
  evaluate it), `TRAV_NODE_NOT_FOUND`, `TRAV_NODE_UNREACHABLE`,
  `TRAV_NOT_SINGLE_CARDINALITY`, `META_TABLE_NOT_FOUND`, `META_COLUMN_NOT_FOUND`,
  `META_COLUMN_NOT_READABLE`, `META_COLUMN_NOT_CREATABLE`, `META_COLUMN_NOT_UPDATABLE`,
  `META_OPERATOR_TYPE_MISMATCH`, `STRUCT_ROWCOUNT_ON_CREATE` (Warning: a min-rows Row Count on
  a structurally-empty-at-create collection combined with the On Create trigger can never pass
  during Create), `STRUCT_INVALID_DATEEXPR`, `STRUCT_EXPR_FILTER_MISSING`,
  `STRUCT_INVALID_EXPRESSION_FILTERS`, `STRUCT_INVALID_TIMEZONE`, `STRUCT_APPLY_PREVIOUS_TARGET` (Error: an action's
  "Also Apply To Previous" is ticked but the action is not an Update Record whose target is reached through
  lookups from the rule's record). Trusted Authors may publish System-context writes without
  holding privileges on the target business tables; see `docs/Security.md`.
- `kind` is a string enum name: `"Rule"`, `"Group"`, `"Condition"`, or `"Action"`.
- `field` is the logical-name fragment of the column the issue targets; omitted (`null`) when the
  issue targets the entity as a whole rather than a specific field.
- `IsValid = (isValid == true)` and `isValid = !issues.any(i => i.severity == "Error")`.

`Issues` is serialized via `DataContractJsonSerializer` (sandbox-safe, matching
`RunRulesResultSerializer`).

### Error handling

`asx_ValidateRule` returns rule validation issues as data. Bad input, unreadable
configuration and service faults can throw. Validation does not acquire a
coordination lock or change publication state.

---

### 5.1 `RulePublishPlugin` plugin step (publish gate)

A **pre-operation synchronous SDK step** on `asx_rule` **Update** that enforces the same
`RuleValidator` as a server-side gate. Every explicit Published status update
validates and captures the saved draft, including republishing an already-active rule.

**Registration details:**

| Property | Value |
|---|---|
| Plugin type | `Ascentix.RulesEngine.Plugin.RulePublishPlugin` |
| Message | `Update` |
| Primary entity | `asx_rule` |
| Stage | Pre-operation (20) |
| Mode | Synchronous (0) |
| Execution order | 20, after revision guard (1) and before registration reconciliation (30) |
| Pre-image | `PreImage` (alias `PreImage`, `imagetype=0`, `messagepropertyname="Target"`, attributes: `statuscode`) |

**Publication logic:** an explicit `Target.statuscode = 753840000` captures and
validates the latest saved graph. It creates a revision and supplies the new pointer and number on
Target. Invalid publication throws, rolling back the revision, pointer, and
registration changes. Other authored attributes must be saved before publishing.
Non-publication draft edits retain the old active revision.

### 5.2 Revision Custom APIs

All are unbound POST Actions, with no additional custom processing steps, implemented
by `Ascentix.RulesEngine.Plugin.RuleRevisionApi`.

| API | Inputs | Outputs | Gate |
|---|---|---|---|
| `asx_ReadPublishedRule` | `RuleId` String | `Definition` String | `prvReadasx_rule` |
| `asx_RestoreRuleDraft` | `RuleId` String | None | `prvWriteasx_rule` |
| `asx_OpenRuleDraft` | `RuleId` String | `DraftId` String | `prvWriteasx_rule` |
| `asx_CopyRule` | `RuleId` String | `NewRuleId` String | `prvCreateasx_rule` |
| `asx_DeleteRule` | `RuleId` String | None | `prvDeleteasx_rule` |

Open creates or reuses one working copy while the original stays active. Restore
accepts the working-copy ID, preserves active enforcement, and reclaims
unused private models. Read resolves either ID to the stable published rule.
`asx_tableconfig.asx_isprivate` is a Boolean, default false, identifying cloned
working models excluded from shared-model lists. The installation and acceptance
contract is in `docs/deployment/published-rule-revisions.md`.

---

## 6. `asx_ApplyRules` Custom API

An **unbound (global) Dataverse Custom API Action** (`IsFunction = false`) that evaluates one
**On demand** rule against one persisted record and, unlike `asx_RunRules`, **enforces** the
result: a fired Block throws, and every other fired write action runs inside the call's own
transaction.

**Registration:** bound to plugin type `Ascentix.RulesEngine.Plugin.ApplyRulesApi`;
`ExecutePrivilegeName = prvCreateasx_RuleRun` (the same gate as starting a Rule Run). No
additional custom processing steps. In the `AscentixRulesEngine` solution.

**Privileges:** `prvCreateasx_RuleRun` is the gate for both `asx_ApplyRules` and
`asx_ProcessRunPage`, but running rules from the Rule Builder or a flow needs more than Create
alone. On the Rule Run table (`asx_rulerun`): **Create** (the gate), **Read** (the Runs dialog,
reading a run back), **Append** (setting the run's Rule) and **Write** at owner (User) level or
wider (cancelling). On the Rule table (`asx_rule`): **Append To**. A small dedicated security
role holding exactly these is the simplest way to grant them.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | Guid | No | The On demand rule to evaluate; must be Published with the On demand trigger |
| `RecordId` | Guid | No | A persisted record of the rule's table, readable in the rule's evaluation context |

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | True when no Block action fired |
| `Results` | String | JSON array of every fired action, in the `asx_RunRules` Results shape (§3) |
| `WriteCount` | Integer | Number of write actions applied |

### Semantics

- Uses the RetrieveOnly root build (the persisted record, no overlay) and trigger `OnDemand`;
  channel restrictions are ignored (on-demand runs have no channel).
- The record must exist and be readable in the rule's evaluation context: as the caller for a
  User-context rule, as the system for a System-context rule. Otherwise the call throws
  `"Record <id> was not found in <table>, or you can't read it."`.
- A fired Block throws `InvalidPluginExecutionException` with the rendered block message and
  applies no writes.
- Otherwise every write intent runs inside the call's own transaction (synchronous, main
  operation). A root-targeted Update becomes a real, engine-tagged `Update` of the record rather
  than an in-flight `Target` change.
- Allowed for a rule with either **Runs for** value (§2.1); `asx_ondemandscope` only affects how
  `asx_ProcessRunPage` selects records for a Rule Run, not `asx_ApplyRules`.

---

## 7. `asx_ProcessRunPage` Custom API

An **unbound (global) Dataverse Custom API Action** (`IsFunction = false`) that processes the
next page of an existing Rule Run (§2.13), driven from **outside** Dataverse by repeated calls
so every page starts fresh at plug-in depth 1.

**Registration:** bound to plugin type `Ascentix.RulesEngine.Plugin.ProcessRunPageApi`;
`ExecutePrivilegeName = prvCreateasx_RuleRun`. No additional custom processing steps. In the
`AscentixRulesEngine` solution. Driving a run needs the privileges listed in §6
(**Privileges**), not Create alone.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RunId` | Guid | No | The Rule Run to process |
| `FailedRecordId` | Guid | Yes | The record named by the previous call's `record-failed` error (see **Failed writes**): the call only counts it Failed once and adds it to the skip list |
| `FailedMessage` | String | Yes | The message from that error, stored in `asx_failures`; default `"The write failed."` |

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `Done` | Boolean | True when the run has no further pages to process |
| `Status` | Integer | Current `asx_status` of the run |
| `Evaluated` | Integer | Running total of records evaluated |
| `Changed` | Integer | Running total of records that had at least one write applied |
| `Blocked` | Integer | Running total of records that fired a Block action |
| `Failed` | Integer | Running total of records that errored |
| `Skipped` | Integer | Running total of records that did not pass the execution conditions |

### Semantics

- If the run is not Queued or Running (already terminal), returns `Done = true` with the current
  status and does nothing.
- **Row lock:** before reading the run's state, each call updates the run's `asx_lastpageon`.
  The row lock that update takes holds until the call's transaction ends, so two callers driving
  the same run take turns (the second reads the state the first saved), and a cancel waits for
  the page in progress instead of racing its save.
- **Page budget:** stops after 500 records or 60 seconds of processing, whichever comes first.
  The time is checked before each chunk and after each record, so a page over budget stops after
  the record in hand, well inside the platform's two-minute limit.
- **Record selection:** an **All records** run reads the rule's table ordered by primary id, a page
  at a time, with the page number and paging cookie kept in the bookmark. A page cut short by the
  budget is resumed by re-reading the same page and skipping the ids already handled on it (kept
  in the bookmark), so rows deleted or inserted in the meantime can't make it skip or repeat a
  record. A **Given records** run walks the stored ids in order from the bookmark index. Records
  are evaluated in chunks of 25; a record that no longer exists, or isn't readable in the rule's
  evaluation context, counts as Failed (`"Record not found or not readable."`) and is never
  evaluated.
- **Evaluation context (reads):** records are read in the rule's evaluation context, the same one
  its traversal uses. For a User-context rule an **All records** run only pages over the rows the
  caller (the driver's identity) can read, and a given record the caller can't read counts Failed;
  a System-context rule reads as the system.
- **Failure messages** stored in `asx_failures` are cut to 1,000 characters.
- **Per record:** the same evaluation as `asx_ApplyRules`. A record that doesn't pass the rule's
  execution conditions counts Skipped; a Block counts Blocked (no writes, recorded in
  `asx_failures`); otherwise its writes are applied — at least one write counts Changed, none
  counts Evaluated only.
- **Failed writes:** a write that throws fails the whole call with
  `asx_ProcessRunPage:record-failed:<record guid>:<message>`, so the platform rolls the page back
  (no writes and no run update from that call are kept). The caller then calls again with
  `FailedRecordId = <record guid>` and `FailedMessage = <message>`. That call only records the
  failure: the record is counted Evaluated and Failed once, added to the bookmark's skip list, and
  the run is saved; no records are processed (`Done` is false unless the safety stop fired). The
  next call, without `FailedRecordId`, re-processes the page without the skipped records. Each
  report is committed on its own, so a page with several failing writes still converges. A
  repeated report of a record already in the skip list is not counted again. Send
  `FailedRecordId` only on the call right after a `record-failed` error.
- **Other errors:** a caller should stop on any other error. The run stays Running (or Queued, if no
  page has been saved yet) and can be resumed later by calling again.
- **Safety stop:** after 100 records, if every record so far failed, the run is set to Failed.
- **Rule no longer runnable:** if the rule is no longer published with the On demand trigger, the
  run is set to Failed with the failure `"The rule is no longer published with the On demand
  trigger."`.
- **Runs for no longer matches:** every page checks the run against its rule's published **Runs
  for**. An All records run needs a rule scoped to All records and no record ids; a Given records
  run needs record ids. Otherwise the run is set to Failed with the failure `"The run no longer
  matches its rule's Runs for setting."`.
- **Completion:** when the last page is consumed the run is Completed, or Completed with failures
  if anything was Blocked or Failed, and `asx_finishedon` is set.
- **After each page:** saves the counts, the bookmark, `asx_lastpageon`, the rule versions used
  (`asx_ruleversions`), and the first 50 failures (`asx_failures`). A Queued run becomes Running
  on its first page. If the run was Cancelled while the page ran, the counts are saved but the
  status stays Cancelled and `Done` is true.
- **Evaluation context:** User-context rules run as the caller (the driver's identity); System-
  context rules run as the system service.

---

## 8. `asx_SyncSteps` Custom API

An **unbound (global) Dataverse Custom API Action** (`IsFunction = false`) that mechanizes bulk
step maintenance: drift recovery, orphan cleanup, and pre-uninstall teardown of the generated
enforcement steps.

**Registration:** `AllowedCustomProcessingStepType = None`; bound to plugin type
`Ascentix.RulesEngine.Plugin.SyncStepsApi`; `ExecutePrivilegeName =
prvWriteSdkMessageProcessingStep` (System Administrator / System Customizer). The same privilege
is re-checked fail-closed in code for `InitiatingUserId` before any work. Step CRUD itself runs
as the system user, exactly like `RuleRegistrationPlugin`. In the `AscentixRulesEngine` solution.

### Request parameters

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `Mode` | String | Yes | `"Sync"` (default) or `"RemoveAll"`, case-insensitive; anything else is an argument error. |

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `TablesProcessed` | Integer | Distinct tables reconciled (Sync) or swept (RemoveAll) |
| `StepsCreated` | Integer | Steps recreated by Sync (0 for RemoveAll) |
| `StepsUpdated` | Integer | Filtering-attribute repairs (Sync only) |
| `StepsDeleted` | Integer | Orphans removed (Sync) / all engine-owned steps (RemoveAll) |
| `DeactivatedStepsFound` | Integer | Steps seen deactivated and deliberately left alone |
| `Details` | String | JSON per-table breakdown: `[{ "table", "created":[], "updated":[], "deleted":[], "deactivated":[] }]` (step names; no-op tables omitted) |

### Semantics

- **Sync** runs the same `StepPlanner` → `StepReconciler` path the registration plugin uses, over
  the union of tables named by any `asx_rule` row and tables parsed from existing engine-owned
  step names (that second set catches orphans). Engine-owned = registered to `RulesEnginePlugin`
  **and** named `Ascentix.RulesEngine: {table} {message}`, both conditions.
- **Deactivated steps are preserved and reported, never re-enabled** (the emergency-stop
  runbook's deactivation fallback survives a drift repair; see `docs/Plugin-Registration.md`).
- **RemoveAll** deletes every engine-owned step, deactivated included, for pre-uninstall cleanup.
  The registration plugin stays active, so any later rule write regenerates that table's steps.
  Run `RemoveAll` immediately before uninstalling.
- **Fail-fast:** both modes are idempotent; a mid-run fault throws and the call is re-run.

---

## 9. `asx_StartDueSchedules` Custom API

An **unbound (global) Dataverse Custom API Action** (`IsFunction = false`) that finds due Rule
Schedules (§2.14) and starts or continues each one's Rule Run, driven from **outside** Dataverse
by a caller on a timer (for example the scheduler add-on flow).

**Registration:** bound to plugin type `Ascentix.RulesEngine.Plugin.StartDueSchedulesApi`;
`ExecutePrivilegeName = prvCreateasx_RuleRun` (the same gate as `asx_ApplyRules`, §6, and
`asx_ProcessRunPage`, §7). No additional custom processing steps. In the `AscentixRulesEngine`
solution.

### Request parameters

None.

### Response parameters

| Parameter | Type | Notes |
|---|---|---|
| `RunIds` | String | JSON array of Rule Run ids (e.g. `["…","…"]`): the runs this call started, then the runs it continued, then any other Queued/Running run of a rule with an On schedule; each id once |
| `ScheduledCount` | Integer | Number of due schedules this call found (at most 50), including any the call budget left for the next call |

### Semantics

- **Heartbeat:** every call first writes `asx_schedulerstatus` (§2.15). It is part of the call's
  transaction, so a call that fails rolls its heartbeat back too.
- **Due schedules:** On, with `asx_nextrunon` at or before now, oldest first, at most **50** per
  call. For each: a rule that has an active (Queued/Running) run is **continued** (outcome 2,
  `asx_nextrunon` unchanged); otherwise a new all-records run is **started** (outcome 1) and
  `asx_nextrunon` advances. A rule that isn't runnable (not Published, not On demand + All
  records, unknown time zone) gets outcome 3 and advances, staying On; an invalid recurrence or a
  schedule without a rule is switched Off (outcome 3); a schedule whose rule has just been
  deleted is skipped (the delete cascade removes it).
- **Next run:** a missed occurrence is never queued: one run is started however far behind the
  schedule is. For **Every N minutes/hours** the next run is anchored on the schedule's previous
  `asx_nextrunon`: the first `previous + k·N` (k ≥ 1) strictly after now, so the rhythm doesn't
  drift with the caller's timing; without a previous value it is now + N. Daily, Weekly and
  Monthly take the next matching time of day in the rule's time zone after now.
- **Run ownership:** runs are created by the engine but owned by the **caller** (the identity
  that called the API), like a run started by hand.
- **Call budget:** once about **60 seconds** of wall-clock time have passed, the call takes no
  further due schedules; those not reached keep their `asx_nextrunon` and are taken by the next
  call. `RunIds` still lists every run to drive.
- **Ordering:** new runs come first in `RunIds`, so a long run that keeps being continued never
  starves the rules started after it; continued runs follow, then leftovers.
- **Concurrent callers:** a second call made while another is running waits on or collides with
  the first (both write the heartbeat row and may pick the same rule); if it fails, it fails as a
  whole (its writes roll back) and its caller simply tries again on its next wake-up. Nothing is
  lost.

---

## 10. Relationships (explicit schema names)

| Relationship | Parent (1) | Child (N), holds the lookup |
|---|---|---|
| `asx_rule_conditiongroup` | `asx_rule` | `asx_conditiongroup` |
| `asx_conditiongroup_conditiongroup` | `asx_conditiongroup` | `asx_conditiongroup` (self) |
| `asx_conditiongroup_condition` | `asx_conditiongroup` | `asx_rulecondition` |
| `asx_conditiongroup_nodefiltergroup` | `asx_conditiongroup` | `asx_nodefiltergroup` |
| `asx_tableconfig_tableconfig` | `asx_tableconfig` | `asx_tableconfig` (self) |
| `asx_rule_roottableconfig` | `asx_tableconfig` | `asx_rule` (each rule's root node; trees shareable) |
| `asx_condition_tableconfig` | `asx_tableconfig` | `asx_rulecondition` |
| `asx_condition_comparisonvaluenode` | `asx_tableconfig` | `asx_rulecondition` |
| `asx_condition_criteriagroup` | `asx_rulecondition` | `asx_searchcriteriagroup` |
| `asx_criteriagroup_criteriagroup` | `asx_searchcriteriagroup` | `asx_searchcriteriagroup` (self) |
| `asx_criteriagroup_criterion` | `asx_searchcriteriagroup` | `asx_searchcriterion` |
| `asx_nodefiltergroup_nodefiltergroup` | `asx_nodefiltergroup` | `asx_nodefiltergroup` (self) |
| `asx_nodefiltergroup_criterion` | `asx_nodefiltergroup` | `asx_nodefiltercriterion` |
| `asx_nodefiltergroup_tableconfig` | `asx_tableconfig` | `asx_nodefiltergroup` |
| `asx_rulecondition_nodefiltergroup` | `asx_rulecondition` | `asx_nodefiltergroup` |
| `asx_nodefiltercriterion_comparisonvaluenode` | `asx_tableconfig` | `asx_nodefiltercriterion` |
| `asx_nodefiltercriterion_collectionnode` | `asx_tableconfig` | `asx_nodefiltercriterion` |
| `asx_nodefiltergroup_owningcriterion` | `asx_nodefiltercriterion` | `asx_nodefiltergroup` |
| `asx_rule_ruleaction` | `asx_rule` | `asx_ruleaction` |
| `asx_ruleaction_localizedmessage` | `asx_ruleaction` | `asx_localizedmessage` |
| `asx_ruleaction_nodefiltergroup` | `asx_ruleaction` | `asx_nodefiltergroup` (Cascade) |

---

## 11. Test fixture schema (not shipped)

The live client suites (`client/test-dev`, `client/e2e`, `client/scripts/seed-*`) run against a
disposable **`sample_*` Order-domain model** that is **not part of the product**. It lives in the
`RulesEngineSampleApp` solution (publisher `ascentixsample`, prefix `sample`), never in
`AscentixRulesEngine` (see the solution-hygiene rule in `CONTRIBUTING.md`). `SchemaNames.cs` does
not reference it.

**The tables below are the complete fixture schema for a fresh org**: provision all of them
before running the live suites. Create them idempotently (check first on the logical name) against
whatever environment `DATAVERSE_URL` points at, and emit labels in the **org's base language**, so
the fixture also stands up on an org whose base language is not English.

| Table | Columns (beyond `sample_name` PK) | Lookups (1:N schema name) |
|---|---|---|
| `sample_customer` | `sample_email`, `sample_phone`, `sample_postalcode`, `sample_creditlimit` (Money), `sample_segments` (multi-select) | `sample_parentcustomerid` → `sample_customer` (`sample_customer_sample_customer`) |
| `sample_product` | `sample_unitprice` (Money), `sample_category` (choice), `sample_discontinued` (Yes/No) | None |
| `sample_order` | `sample_ordertotal` (Money), `sample_status` (choice), `sample_orderdate`, `sample_isexpedited` (Yes/No), `sample_ordertags` (multi-select), `sample_contactemail`, `sample_contactphone`, `sample_shippingpostalcode`, `sample_approvalnotes` (Memo), `sample_handlinginstructions` (Memo) | `sample_customerid` → `sample_customer` (`sample_customer_sample_order`) |
| `sample_orderline` | `sample_quantity` (Whole Number), `sample_lineamount` (Money), **`sample_notes`** (String 200, the pushdown-volume shape flag written by `client/scripts/seed-volume-fixture.mjs`; SchemaName is lowercase), `sample_duedate` (Date Only behavior), `sample_localtime` (date and time, Time Zone Independent behavior) | `sample_orderid` → `sample_order` (`sample_order_sample_orderline`), `sample_productid` → `sample_product` (`sample_product_sample_orderline`) |
| **`sample_shipment`** | `sample_isexpedited` (Yes/No), `sample_shipamount` (Money); PK `sample_name` is String **100** | `sample_orderid` → `sample_order` (`sample_order_sample_shipment`, Delete = RemoveLink) |

`sample_order` therefore has **two child collections**, `sample_orderline` and `sample_shipment`,
which the EXISTS predicate cases need (a sibling collection to count). The `sample_order` main
form's Shipments sub-grid is a DEV-only convenience and is not provisioned by the script.
