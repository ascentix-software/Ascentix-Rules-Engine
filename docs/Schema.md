# Ascentix Rules Engine Schema Reference

Authoritative reference for the Dataverse schema, kept in sync with `Ascentix.RulesEngine.Core/Schema/SchemaNames.cs`
and the live environment (schema is authored directly in the environment, not by a deploy tool).

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
| `asx_actiontype` | Action Type | Set Visible = 1, Set Required = 2, Show Message = 3, Block = 4, Create Record = 5, Update Record = 6, Delete Record = 7 |
| `asx_actionfireon` | Action Fire On | On Match = 1, On No Match = 2 |
| `asx_triggers` | Triggers | On Create = 1, On Form = 2, Manual = 3, On Update = 4, On Delete = 5 (**multi-select**) |
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

| Column | Schema name | Type | Req | Notes |
|---|---|---|---|---|
| Table Logical Name | `asx_tablelogicalname` | Text (100) | ✔ | Entity the rule applies to |
| Triggers | `asx_triggers` | MultiSelect → `asx_triggers` | ✔ | At least one (editor-enforced) |
| Channels | `asx_channels` | MultiSelect → `asx_channel` | | Empty ⇒ applies on all channels; gates which origin channel (Standard/Portal) a rule fires on |
| Effective From | `asx_effectivefrom` | DateTime (UTC) | | Not enforced before this; null ⇒ open start |
| Effective To | `asx_effectiveto` | DateTime (UTC) | | Not enforced after this; null ⇒ open end |
| Evaluation Context | `asx_evaluationcontext` | Choice → `asx_evaluationcontext` | | Selects whether the rule's business-data traversal evaluates in the caller's context (`User` = 1, default) or as system (`System` = 2); default User preserves caller-visibility behavior |
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
| Comparison Value Source | `asx_comparisonvaluesource` | Choice → `asx_comparisonvaluesource` | | Blank ⇒ Literal; FieldReference compares against another field |
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
| Target Node | `asx_targetnode` | Lookup → `asx_tableconfig` | | Update/Delete target record: a single-cardinality node (root = triggering record; lookup = one related record) |
| Field Mapping | `asx_fieldmapping` | Multiline (JSON) | | Create/Update value map (see format below) |
| Order | `asx_order` | Whole Number | | Execution order |
| Is Active | `asx_isactive` | Yes/No | | Default Yes |

> **Write actions (CreateRecord / UpdateRecord / DeleteRecord)** are executed by the **plugin**
> (enforcing adapter): synchronously, in the triggering operation's transaction (atomic: a write
> failure rolls everything back), only at `context.Depth == 1`, and under the rule's
> `asx_evaluationcontext` (User → caller, System → system). If any `Block` fires, the plugin throws
> and performs **no** writes (block wins). `asx_RunRules` **reports** the resolved write (see §3)
> but never executes it. An UpdateRecord targeting the root node on a Create/Update applies its
> values to the in-flight record in place. That in-place path does not cover
> `UpdateMultiple`/`DeleteMultiple`.

**Field-mapping format (`asx_fieldmapping`)** is a JSON array, one entry per target column:

```jsonc
[
  { "target": "subject",     "source": "literal", "value": "Follow up" },
  { "target": "statuscode",  "source": "literal", "value": 2 },
  { "target": "regardingid", "source": "root",    "column": "accountid" },
  { "target": "ownerid",     "source": "node",    "node": "<tableconfig-guid>", "column": "manager" },
  { "target": "subject2",    "source": "template", "template": "Follow up: {root.name} — {node:<tableconfig-guid>.fullname}" },
  { "target": "followupby",  "source": "dateexpr", "anchor": { "kind": "now" }, "op": "add", "amount": 3, "unit": "days" }
]
```

`literal` values use the RecordJson encoding (see §3) and are coerced to the target column's CLR type
via attribute metadata; `root`/`node` copy a raw attribute value off the triggering record or a
single-cardinality related node. DeleteRecord ignores `asx_fieldmapping`.

`template` (String/Memo targets only) renders literal text with `{root.<column>}` /
`{node:<tableconfig-guid>.<column>}` tokens (`{{`/`}}` escape braces); values format for humans
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
  (`ValidationReport.IsValid` ignores warnings). Two checks emit `Warning`: `STRUCT_ROWCOUNT_ON_CREATE`
  and `SEC_SYSWRITE_REQ`.
- `code` is a stable machine token the editor maps to inline UI. Vocabulary: `STRUCT_NO_CONDITIONS`,
  `STRUCT_NO_ACTIONS`, `STRUCT_EMPTY_GROUP`, `STRUCT_MISSING_FIELD`, `STRUCT_INVALID_REGEX`,
  `STRUCT_ROWCOUNT_RANGE`, `STRUCT_NODE_NOT_IN_TREE` (Error: a condition's `asx_tableconfig`
  binding is missing or names a node outside the rule's config tree; the engine would refuse to
  evaluate it), `TRAV_NODE_NOT_FOUND`, `TRAV_NODE_UNREACHABLE`,
  `TRAV_NOT_SINGLE_CARDINALITY`, `META_TABLE_NOT_FOUND`, `META_COLUMN_NOT_FOUND`,
  `META_COLUMN_NOT_READABLE`, `META_COLUMN_NOT_CREATABLE`, `META_COLUMN_NOT_UPDATABLE`,
  `META_OPERATOR_TYPE_MISMATCH`, `STRUCT_ROWCOUNT_ON_CREATE` (Warning: a min-rows Row Count on
  a structurally-empty-at-create collection combined with the On Create trigger can never pass
  during Create), plus the **publisher-relative** `SEC_*` family:
  `SEC_SYSWRITE_PRIV` (Error: a System-context rule with write actions requires the publishing
  user to hold the matching privilege at Global depth on each target table) and
  `SEC_SYSWRITE_REQ` (Warning: informational statement of that requirement, always emitted for
  gated actions regardless of the caller's own privileges). Unlike the rule-intrinsic families,
  `SEC_*` results depend on *who asks*: `asx_ValidateRule` evaluates them for the caller; the
  authoritative check runs against the actual publisher at publish time (see `docs/Security.md`).
- `kind` is a string enum name: `"Rule"`, `"Group"`, `"Condition"`, or `"Action"`.
- `field` is the logical-name fragment of the column the issue targets; omitted (`null`) when the
  issue targets the entity as a whole rather than a specific field.
- `IsValid = (isValid == true)` and `isValid = !issues.any(i => i.severity == "Error")`.

`Issues` is serialized via `DataContractJsonSerializer` (sandbox-safe, matching
`RunRulesResultSerializer`).

### Error handling

`asx_ValidateRule` throws `InvalidPluginExecutionException` **only on bad input** (missing or
non-GUID `RuleId`; rule not found).

---

### 5.1 `RulePublishPlugin` plugin step (publish gate)

A **pre-operation synchronous SDK step** on `asx_rule` **Update** that enforces the same
`RuleValidator` as a server-side gate. It blocks the **Draft → Published** transition of an
invalid rule, so publishing via the raw form (not just the editor) is gated too.

**Registration details:**

| Property | Value |
|---|---|
| Plugin type | `Ascentix.RulesEngine.Plugin.RulePublishPlugin` |
| Message | `Update` |
| Primary entity | `asx_rule` |
| Stage | Pre-operation (20) |
| Mode | Synchronous (0) |
| Pre-image | `PreImage` (alias `PreImage`, `imagetype=0`, `messagepropertyname="Target"`, attributes: `statuscode`) |

**Transition logic:** reads `old = PreImage["statuscode"]`, `new = Target["statuscode"] ?? old`.
Runs the validator **only when `old != Published && new == Published`**. On an invalid rule throws
`InvalidPluginExecutionException` with the `Error` messages joined. The platform rolls back,
blocking the publish. Drafts, Archived transitions, and non-status edits pass untouched.

---

## 6. `asx_SyncSteps` Custom API

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

## 7. Relationships (explicit schema names)

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

---

## 8. Test fixture schema (not shipped)

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
| `sample_orderline` | `sample_quantity` (Whole Number), `sample_lineamount` (Money), **`sample_notes`** (String 200, the pushdown-volume shape flag written by `client/scripts/seed-volume-fixture.mjs`; SchemaName is lowercase) | `sample_orderid` → `sample_order` (`sample_order_sample_orderline`), `sample_productid` → `sample_product` (`sample_product_sample_orderline`) |
| **`sample_shipment`** | `sample_isexpedited` (Yes/No), `sample_shipamount` (Money); PK `sample_name` is String **100** | `sample_orderid` → `sample_order` (`sample_order_sample_shipment`, Delete = RemoveLink) |

`sample_order` therefore has **two child collections**, `sample_orderline` and `sample_shipment`,
which the EXISTS predicate cases need (a sibling collection to count). The `sample_order` main
form's Shipments sub-grid is a DEV-only convenience and is not provisioned by the script.
