---
title: Custom APIs
section: Developer Reference
order: 402
slug: custom-apis
---

# Custom APIs

The engine exposes four **unbound Dataverse Custom APIs** for integrating with rules
outside the built-in save enforcement and form behavior described in *How Rules Run*.
All four are callable through the standard Dataverse Web API
(`Xrm.WebApi.online.execute` from client code, or a plain HTTP request from a
server-side integration), and none requires a custom output table. Results come back
as JSON in the response parameters.

## `asx_ValidateRule`: validate a rule

Validates a **persisted** rule and returns a structured report of what, if anything,
is wrong with it. This is the check behind the Rule Builder's status badge and the
gate on the Draft → Published transition (see *Rule Lifecycle*). It is **always
non-enforcing**: an invalid rule comes back as report data, never as an exception. It
throws only on bad input: a missing or non-GUID `RuleId`, or a rule that doesn't
exist.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | String | No | GUID of the `asx_rule` record to validate |

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no Error-severity issue was found |
| `Issues` | String | JSON report (see below); `"issues":[]` when valid |

```json
{
  "isValid": false,
  "issues": [
    {
      "severity": "Error",
      "code": "STRUCT_NO_CONDITIONS",
      "message": "The rule has no conditions.",
      "target": { "kind": "Rule", "id": "00000000-0000-0000-0000-000000000000", "field": null }
    }
  ]
}
```

`severity` is currently always `"Error"`; the `"Warning"` value is defined in the
model but no check in this version emits it. `code` is a stable machine token;
`target.kind` is one of `"Rule"`, `"Group"`, `"Condition"`, or `"Action"`, and
`target.field` names the specific column at fault when the issue targets one.

## `asx_RunRules`: on-demand evaluation

Evaluates the rules engine against a single record (saved, unsaved, or a mix of
both) and reports back every action that fired, without writing anything or
enforcing anything. This is the **Manual** trigger's API described in *How Rules
Run*, and what the client form library round-trips to for every rule it
evaluates on a form. See *Client Form Library*.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the record's table |
| `RecordId` | String | Yes | GUID of an existing record |
| `RecordJson` | String | Yes | Unsaved field values as a flat JSON object `{ "<logicalname>": <value> }` |
| `Triggers` | String | Yes | Single trigger name; defaults to `Manual` |
| `IncludeDiagnostics` | Boolean | Yes | When `true`, the response also carries `Diagnostics` (timings and fetch counts for this evaluation). Default `false` |

At least one of `RecordId` / `RecordJson` is required. Supplying both retrieves the
persisted record and overlays the JSON fields on top of it.

`RecordJson` values are encoded per attribute kind: a lookup is
`{ "id": "<guid>", "logicalname": "<table>" }`; a multi-select choice is an array of
integers; a whole number, single-select choice, or status is a plain integer; a
decimal or money value is a fractional number; a boolean is `true`/`false`; a date is
an ISO-8601 string; and `null` clears/omits the attribute.

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no `Block` action fired |
| `FailedRuleCount` | Integer | Count of distinct rules with a fired `Block` action |
| `Results` | String | JSON array of every fired action |
| `Diagnostics` | String | Only when `IncludeDiagnostics` was `true`: a JSON object describing the evaluation (see below) |

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

Enums serialize as string names; fields irrelevant to a given action type are
`null`. A fired `CreateRecord` / `UpdateRecord` / `DeleteRecord` action also carries
a `write` object, the fully-resolved write intent (`operation`, `targetTable`,
`targetId`, `values`). `asx_RunRules` reports that intent; only the server engine
applies it, on Create/Update/Delete. See *Runtime Enforcement*.

**Diagnostics** (opt-in, `IncludeDiagnostics: true`) report what the evaluation cost,
for support conversations and your own sizing against the *Beta Limitations* budget:

```json
{
  "totalMs": 412,
  "rulesLoaded": 12, "rulesEvaluated": 12, "rulesFired": 1,
  "retrieveCount": 3, "retrieveMultipleCount": 4, "rowsFetched": 260,
  "stages": [ { "name": "loadRules", "ms": 40 }, { "name": "queryExecute", "ms": 310 }, { "name": "evaluate", "ms": 62 } ],
  "nodes":  [ { "nodeId": "…", "table": "sample_orderline", "retrieveCount": 0, "retrieveMultipleCount": 2, "rows": 240 } ]
}
```

`stages` are the engine's internal phases; the names may change between releases, so
treat them as labels, not an API. `nodes` is one entry per traversed configuration
node. The numbers are server-side evaluation cost only, not end-user save latency.

## `asx_ReadRules`: runtime projection

Returns the assembled rule definitions for a table, serialized to JSON: triggers,
the condition-group tree, the Table Config nodes each condition binds to, and the
actions. It performs **no evaluation**: where `asx_RunRules` answers "what fired for
this record?", `asx_ReadRules` answers "what are the rules for this table?". It is
modeled as a Dataverse **Function**, so it is callable with an HTTP `GET`. The client
form library calls it once per table on form load to discover which columns to watch
and which rules to evaluate.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the table whose rules to return |
| `Triggers` | String | Yes | Single trigger name; defaults to `OnForm` |

`asx_ReadRules` is record-agnostic, so there's no `RecordId`/`RecordJson` parameter.
It returns only the rules that would actually apply: **Published** status, the
requested trigger, a matching Channel (see *Triggers & Channels*), and within the
rule's effective window (see *Rule Lifecycle*). When nothing matches, the response is
a well-formed envelope with an empty `rules` array, not an error.

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `Rules` | String | JSON envelope: `{ tableLogicalName, languageId, rules: [...] }` |

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
        /* logicalOperator, isExecutionCondition, conditions[], groups[]. Each condition's
           conditionType is one of FieldComparison / RowCount / RegexMatch / Calculation, and
           valueSource is one of Literal / FieldReference / Template / DateExpression
           (illustrative, not exhaustive; see Schema Reference for the authoritative list) */
      ],
      "tableConfig": [ /* the Table Config nodes this rule references */ ],
      "actions": [ /* actionType, fireOn, targetColumn, value, message, severity, order, ... */ ]
    }
  ]
}
```

Field names are camelCase, enums are string names, and `message` text is already
localized to the caller's UI language (`languageId` in the envelope). Write actions
add `targetTable`, `targetNode`, and `fieldMapping`.

## `asx_SyncSteps`: reconcile or remove the generated steps

`asx_SyncSteps` is the manual control over the generated enforcement steps (see
*Plugin Registration*), for the two cases the automatic reconciliation does not
cover: recovering from drift, and clearing up before an uninstall.

It is gated on the **calling** user holding `prvWriteSdkMessageProcessingStep`. The
step changes themselves are made as the system user, the same as during a publish.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `Mode` | String | Yes | `Sync` (the default when omitted or empty) or `RemoveAll`. Case-insensitive. Any other value fails the call |

`Mode = "Sync"` walks every table that has rules and reconciles its steps against the
current rule configuration: it registers what is missing, widens what is too narrow,
and deletes steps the rules no longer call for. Use it after a drift-inducing change,
such as a step edited or removed by hand. To repair a single table instead, deactivate
and reactivate any one rule on it (see *Plugin Registration*).

`Mode = "RemoveAll"` deletes every step the engine owns. This is the pre-uninstall
step: the solution cannot be removed while its generated steps still reference it
(see *Installing, Verifying & Uninstalling*). Enforcement stops immediately, so on a
live environment treat it as an outage rather than routine maintenance. Publishing a
rule, or a later `Sync`, regenerates the steps.

Neither mode re-enables a step an administrator deactivated. Deactivated steps are
counted, reported, and left as they are, so a repair does not restore enforcement
that was deliberately suspended (*Troubleshooting*).

**Response**

| Property | Type | Notes |
|---|---|---|
| `TablesProcessed` | Integer | Tables examined |
| `StepsCreated` | Integer | Steps registered |
| `StepsUpdated` | Integer | Existing steps widened or corrected |
| `StepsDeleted` | Integer | Steps removed |
| `DeactivatedStepsFound` | Integer | Deactivated steps seen and deliberately left alone |
| `Details` | String | JSON array, one entry per table where something actually changed |

`Details` names the steps rather than only counting them:

```json
[
  {
    "table": "sample_order",
    "created": ["Ascentix.RulesEngine: sample_order Create"],
    "updated": [],
    "deleted": [],
    "deactivated": ["Ascentix.RulesEngine: sample_order Update"]
  }
]
```

Tables where nothing changed are omitted, so an empty array means everything was
already correct.
