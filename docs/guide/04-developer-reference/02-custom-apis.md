---
title: Custom APIs
section: Developer Reference
order: 402
slug: custom-apis
---

# Custom APIs

The engine's **unbound Custom APIs** integrate with rules outside the save enforcement and form
behavior in *How Rules Run*. Call them through the Dataverse Web API (`Xrm.WebApi.online.execute`
from client code, or plain HTTP from a server). Results come back as JSON in the response
parameters.

| API | Does |
|---|---|
| `asx_ValidateRule` | Reports what's wrong with a saved rule |
| `asx_RunRules` | Dry run: what would fire for one record, writing nothing |
| `asx_ApplyRules` | Runs one On demand rule on one record, enforcing it |
| `asx_ProcessRunPage` | Advances a Rule Run by one page |
| `asx_ApplyDataUpdates` | Reports or applies a release's data updates |
| `asx_StartDueSchedules` | Starts or continues due schedules' runs |
| `asx_ReadRules` | Returns a table's rule definitions |
| `asx_SyncSteps` | Reconciles or removes the generated enforcement steps |
| `asx_DeleteRule` | Deletes a rule and the configuration it owns |

## `asx_ValidateRule`: validate a rule

Validates a **saved** rule. This is the check behind **Check for issues**, **Publish…** and the
Draft → Published gate (*Rule Lifecycle*). It never throws for an invalid rule; it throws only for
a missing or non-GUID `RuleId`, or a rule that doesn't exist.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | String | No | GUID of the `asx_rule` |

| Response | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no Error-severity issue was found |
| `Issues` | String | JSON report; `"issues":[]` when valid |

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

- `severity`: currently always `"Error"`. `"Warning"` is defined but no check in this version emits
  it.
- `code`: a stable machine token.
- `target.kind`: `"Rule"`, `"Group"`, `"Condition"` or `"Action"`. `target.field` names the column
  at fault, when there is one.

## `asx_RunRules`: on-demand evaluation

Evaluates the rules against one record (saved, unsaved, or both) and reports every action that
fired, **without writing or enforcing anything**. It's the **On demand** trigger's dry run (*How
Rules Run*) and what the client form library calls on every cycle (*Client Form Library*). For the
enforcing path, see `asx_ApplyRules`.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the record's table |
| `RecordId` | String | Yes | GUID of an existing record |
| `RecordJson` | String | Yes | Unsaved values as a flat JSON object `{ "<logicalname>": <value> }` |
| `Triggers` | String | Yes | One trigger name; default `Manual`. `OnDemand` and `Manual` are both accepted for trigger value 3 (*Triggers & Channels*) |
| `IncludeDiagnostics` | Boolean | Yes | `true` adds `Diagnostics`. Default `false` |
| `IncludeOutcomes` | Boolean | Yes | `true` fills `Outcomes`. Default `false` (`Outcomes` is then `[]`) |
| `DraftRuleId` | Guid | Yes | A draft `asx_rule` to preview in place of the live rule it's a draft of. Omitted or empty means no draft |

At least one of `RecordId` / `RecordJson` is required. With both, the saved record is read and the
JSON values are laid over it.

**`RecordJson` encoding:**

| Kind | Value |
|---|---|
| Lookup | `{ "id": "<guid>", "logicalname": "<table>" }` |
| Multi-select choice | Array of integers |
| Whole number, single-select choice, status | Integer |
| Decimal, money | Fractional number |
| Boolean | `true` / `false` |
| Date | ISO-8601 string |
| Clear / omit | `null` |

**`DraftRuleId`** previews what publishing a draft would do. The draft's saved rows (not unsaved
edits in an open editor) run in place of the live rule, or, for a rule never published, alongside
the published rules. Every other published rule runs as usual. The draft must be on `TableName`'s
table and readable by the caller. Its results and outcomes are reported under the **draft's** id.
Dataverse passes an omitted optional Guid as an empty Guid, which means no draft. The Rule
Builder's **Preview on a record** sets it when **Version** is **Draft**.

| Response | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no `Block` fired |
| `FailedRuleCount` | Integer | Distinct rules with a fired `Block` |
| `Results` | String | JSON array of every fired action |
| `Outcomes` | String | With `IncludeOutcomes: true`, each outcome's value per record; otherwise `[]` |
| `ChangeSet` | String | JSON summary of the writes this evaluation would make |
| `Diagnostics` | String | With `IncludeDiagnostics: true`, the evaluation's cost |

### `Results`

```json
[
  {
    "ruleId": "00000000-0000-0000-0000-000000000000",
    "actionType": "Block",
    "targetColumn": null,
    "value": null,
    "message": "Localized message text",
    "severity": "Error",
    "targetTable": null
  }
]
```

Enums are string names; fields that don't apply to the action type are `null`. Write actions
(`CreateRecord`, `UpdateRecord`, `DeleteRecord`, `DeactivateRecord`) add:

| Field | When | Meaning |
|---|---|---|
| `write` | Single-record target | The resolved write: `operation`, `targetTable`, `targetId`, `values`. A create's `targetId` is always `null`: the engine never reports the id it will assign, and nothing in the same save can refer to the new record |
| `writes` | Set target (a collection node) | The first 100 resolved rows, each shaped like `write` |
| `writeCount` | Set target | Every filtered row the action resolved, including unchanged ones |
| `unchangedCount` | Set target | How many of `writeCount` already hold the mapped values |
| `previousOf` | "Also apply to the previous" fired | The id of the root-level lookup node. Only in a dry run of an Update (`Triggers` = `OnUpdate`, with both `RecordId` and `RecordJson`), and never on a set target |

`asx_RunRules` only reports writes; the server engine applies them on Create/Update/Delete
(*Runtime Enforcement*). `writeCount` differs from `asx_ApplyRules`' `WriteCount`, which counts
only rows actually written.

```json
{ "ruleId": "…", "actionType": "UpdateRecord", "targetTable": "contact",
  "writes": [ { "operation": "Update", "targetTable": "contact", "targetId": "…", "values": { "donotbulkemail": true } } ],
  "writeCount": 12, "unchangedCount": 3 }
```

### `Outcomes`

The value of every outcome (top-level validation group) of every rule evaluated, per record:

```json
[{ "recordId": "…", "ruleId": "…", "outcomeId": "…", "name": "High value", "value": true }]
```

Values are from the normal run only; a rule held back by its execution conditions reports none.
The form library doesn't ask for outcomes. **Preview on a record** does, and lists them under
**OUTCOMES**.

### `ChangeSet`

Every write this evaluation would make, across all fired rules and actions, after writes to the
same record are merged (*Building Actions* → *Writing a set of rows*):

```json
{ "creates": 1, "updates": 12, "deletes": 0, "unchanged": 3 }
```

A record with a fired `Block` counts zero everywhere (`IsValid` is `false`): enforcement would
write nothing for it. An update of the evaluated record itself counts as an update, although a
form save applies it in place. **Preview on a record** shows this as "Change set: 1 create, 12
updates, 0 deletes · 3 unchanged".

### `Diagnostics`

What the evaluation cost, for support and for sizing against the *Beta Limitations* budget:

```json
{
  "totalMs": 412,
  "rulesLoaded": 12, "rulesEvaluated": 12, "rulesFired": 1,
  "retrieveCount": 3, "retrieveMultipleCount": 4, "rowsFetched": 260,
  "stages": [ { "name": "ruleLoad", "ms": 40 }, { "name": "queryExecute", "ms": 310 }, { "name": "evaluate", "ms": 62 } ],
  "nodes":  [ { "nodeId": "…", "table": "sample_orderline", "retrieveCount": 0, "retrieveMultipleCount": 2, "rows": 240 } ]
}
```

`nodes` has one entry per traversed configuration node. `stages` are internal phases whose names
can change between releases: treat them as labels, not an API. The figures are server-side
evaluation cost, not end-user save latency.

The enforcing paths return the same object: `asx_ApplyRules`, `asx_ProcessRunPage` and
`asx_StartDueSchedules` with `IncludeDiagnostics: true`, and every form save the engine finishes
evaluating, in the plug-in trace (*Troubleshooting*). A save that fails during evaluation (for
example at the 25,000-row limit) writes none. There `totalMs` covers the whole call or save, and
these fields appear when not zero:

| Field | Meaning |
|---|---|
| `writesSent` | Rows written (creates, updates, deletes) |
| `writesUnchanged` | Rows skipped because they already held the mapped values |
| `writesMerged` | Writes of the same row merged into one |
| `bulkRequests` / `singleRequests` | Bulk (`CreateMultiple`/`UpdateMultiple`) and single requests sent |
| `inPlaceWrites` | Updates of the record being saved, applied to the save itself |
| `pageRecords` / `pageChunks` / `pageBlocked` / `pageFailed` | What one `asx_ProcessRunPage` call handled |
| `schedulesStarted` / `schedulesContinued` / `schedulesSkipped` | What one `asx_StartDueSchedules` call did |
| `fetchesShared` | Reads answered from an earlier read in the same call or save |
| `fetchesWidened` | Shared reads fetched again with more columns; expected 0, so report any other value |

Their extra stages: `changeSetBuild`, `applyInPlace`, `dispatch:<operation>:<table>`,
`pageSelect`, `pageEvaluate`, `pageWrite`, `bookmark`, `dueQuery`, `scheduleStart`, `heartbeat`.

## `asx_ApplyRules`: enforcing on-demand evaluation

Runs one **On demand** rule against one saved record and **enforces** the result: a fired `Block`
throws, and every other fired write runs in the call's own transaction. Use it from a script or a
command button for a single record. **Apply to records** and **Run now** don't use it: they create
a Rule Run and drive it with `asx_ProcessRunPage`, even for one record.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | Guid | No | A Published rule with the On demand trigger |
| `RecordId` | Guid | No | A record of the rule's table; for a User-context rule, one the caller can read |
| `IncludeDiagnostics` | Boolean | Yes | `true` adds `Diagnostics`. Default `false` |

| Response | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no `Block` fired |
| `Results` | String | Fired actions, in the `asx_RunRules` `Results` shape |
| `WriteCount` | Integer | Rows written (unchanged rows don't count) |
| `Diagnostics` | String | With `IncludeDiagnostics: true` (see `asx_RunRules`) |

- Needs **Rule Run Create** (`prvCreateasx_RuleRun`), the same gate as starting a Rule Run.
  *Running Rules On Demand* lists the rest.
- A record that doesn't exist, or that a User-context rule's caller can't read, is refused:
  "Record … was not found in …, or you can't read it."
- The rule's **Runs for** setting doesn't restrict it, since it always targets exactly one record.

## `asx_ProcessRunPage`: advance a Rule Run

Processes the next page of a Rule Run (`asx_rulerun`). It's called repeatedly from **outside**
Dataverse, so every page starts fresh: **Apply to records** and the **Runs** dialog loop over it,
and a flow or integration can do the same (recipe below).

| Request | Type | Optional | Notes |
|---|---|---|---|
| `RunId` | Guid | No | The Rule Run |
| `FailedRecordId` | Guid | Yes | The record from the previous call's record-failed error; counted Failed once |
| `FailedMessage` | String | Yes | That error's message, stored on the run. Default `"The write failed."` |
| `IncludeDiagnostics` | Boolean | Yes | `true` adds `Diagnostics`. Default `false` |

| Response | Type | Notes |
|---|---|---|
| `Done` | Boolean | `true` when there are no more pages |
| `Status` | Integer | The run's `asx_status`: Queued (1), Running (2), Completed (3), Completed with failures (4), Failed (5), Cancelled (6) |
| `Evaluated` / `Changed` / `Blocked` / `Failed` / `Skipped` | Integer | Running totals (*Running Rules On Demand*) |
| `Diagnostics` | String | With `IncludeDiagnostics: true` (see `asx_RunRules`) |

- A run that isn't Queued or Running returns `Done = true` with its status and does nothing.
- Otherwise a call processes up to **500 records** or **60 seconds**, whichever comes first, saves
  its progress and returns.
- Same privileges as `asx_ApplyRules`.
- Two callers on one run take turns: each call locks the run, and the second continues from what
  the first saved.

**Retrying a failed write.** A write that throws fails the call with an error containing
`asx_ProcessRunPage:record-failed:<record guid>:<message>` (Dataverse may wrap it, so search for the
marker), and the whole call rolls back.

1. Call again with `FailedRecordId` and `FailedMessage` from the marker. That call **only** records
   the failure: the record counts as Evaluated and Failed once, the message is cut to 1,000
   characters, and both are kept among the run's first 50 failures.
2. The next call, **without** `FailedRecordId`, resumes and skips the records reported this way.

Send `FailedRecordId` only on the call right after a record-failed error. For any other error,
stop and try later: the run stays Queued or Running and resumes from its bookmark. When a batched
group write fails, the id may stand for the group; send it back the same way, and the next calls
write that group one record at a time and report the record that fails.

```http
POST /api/data/v9.2/asx_ProcessRunPage
Content-Type: application/json

{"RunId":"00000000-0000-0000-0000-000000000000"}
```

```json
{ "Done": false, "Status": 2, "Evaluated": 500, "Changed": 210, "Blocked": 4, "Failed": 0, "Skipped": 286 }
```

### Recipe: a command button that runs a rule for the open record

```javascript
async function runRuleForRecord(ruleId, recordId) {
  const request = {
    RuleId: ruleId,
    RecordId: recordId,
    getMetadata: () => ({
      boundParameter: null,
      parameterTypes: {
        RuleId: { typeName: "Edm.Guid", structuralProperty: 1 },
        RecordId: { typeName: "Edm.Guid", structuralProperty: 1 },
      },
      operationType: 0, // Action
      operationName: "asx_ApplyRules",
    }),
  };
  try {
    const response = await Xrm.WebApi.online.execute(request);
    const result = await response.json();
    console.log(`Applied: ${result.WriteCount} write(s).`);
  } catch (error) {
    // A fired Block throws here with the rendered block message.
    Xrm.Navigation.openAlertDialog({ text: error.message });
  }
}
```

### Recipe: a flow that runs a rule for every matching record

1. **Create a row** in `Rule Runs` (`asx_rulerun`): `Rule` (`asx_Rule@odata.bind`, capital `R`) set
   to the rule, and, for a rule that runs for **a record it's given**, `Record Ids`
   (`asx_recordids`) set to a JSON array of record ids.
2. **Initialize variable** `Done` = `false`.
3. **Do until** `Done` is `true`:
   1. **Perform an unbound action** `asx_ProcessRunPage` with `RunId` = the row from step 1.
      If it fails with `asx_ProcessRunPage:record-failed:` in the message, parse out the guid and
      message, call again with `FailedRecordId` / `FailedMessage`, and loop without setting `Done`.
      Any other failure ends the flow; the run can be resumed later by this flow or **Resume** in
      the Runs dialog.
   2. **Set variable** `Done` = the action's `Done` output.

## `asx_ApplyDataUpdates`: report or apply data updates

Reports a release's data updates and applies the pending ones. The Rule Builder uses it for the
pending-update bar and **Apply now**; a script or pipeline can call it the same way.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `Mode` | String | No | `Status` or `Apply`. Anything else is refused |
| `Retry` | Integer | Yes | `Apply` only: the number of an update that completed with failures, to run again from the start |
| `FailedItem` | String | Yes | `Apply` only: the token from the previous call's item-failed error, sent back exactly as received |
| `FailedMessage` | String | Yes | `Apply` only: that error's message. Default `"The item failed."` |

| Response | Type | Notes |
|---|---|---|
| `Required` | Integer | The highest update number this release carries (`0` for none) |
| `Pending` | String | JSON array `[{"number":1,"title":"…"}]` of updates still to apply |
| `Latest` | String | JSON `{"number","title","status","succeeded","failed","failures":[{"item","message"}]}` for the most recently touched update, or `null`. `status`: Running (1), Completed (2), Completed with failures (3) |
| `CanApply` | Boolean | `true` when the caller may apply |
| `Done` | Boolean | `true` when nothing is pending |

- **Privileges.** `Status` needs **Rule Read** (`prvReadasx_rule`). `Apply` also needs
  `prvWriteSdkMessageProcessingStep` (System Administrator or System Customizer); otherwise it fails
  with "asx_ApplyDataUpdates: only a System Administrator or System Customizer can apply data
  updates." The shipped roles grant nothing on the Data Update table.
- **Pending.** An update is pending while it's running, or before it has started if it has
  something to convert. An update with nothing to convert is never pending.
- **One call, one slice.** An `Apply` call works for up to **60 seconds**, saves its progress,
  finishes at most one update, and returns. **Call again until `Done` is `true`.**
- **Two callers** take turns: each call locks the update's row. The exception is an update's very
  first `Apply`, which creates the row: two administrators starting at the same moment can get a
  duplicate-row error. Apply again; it carries on from what the other saved.

**Retrying a failed item.** An item that throws fails the call with an error containing
`asx_ApplyDataUpdates:item-failed:<token>:<message>` (Dataverse may wrap it, so search for the
marker), and the call rolls back. The token is `<number>/<item>`; treat it as opaque.

1. Call again with `FailedItem` = the token and `FailedMessage` from the marker. That call only
   records the failure against that update (nothing, if another caller finished the update
   meanwhile) and returns.
2. The next call, without `FailedItem`, carries on and skips the item.

Send `FailedItem` only on the call right after an item-failed error; for any other error, stop and
try later, since the update resumes from its saved position. An update whose items all fail still
finishes, as **Completed with failures** with every failure in `Latest`. Call with `Retry` = its
number to run it again after fixing the cause.

```json
{ "Required": 1, "Pending": "[]", "Latest": "{\"number\":1,\"title\":\"…\",\"status\":2,\"succeeded\":120,\"failed\":0,\"failures\":[]}", "CanApply": true, "Done": true }
```

### Recipe: apply every pending data update

```javascript
async function applyDataUpdates() {
  let failed = null;
  for (;;) {
    const params = { Mode: "Apply" };
    if (failed) { params.FailedItem = failed.token; params.FailedMessage = failed.message; }
    let response;
    try {
      response = await callAction("asx_ApplyDataUpdates", params); // your own POST to the Web API
      failed = null;
    } catch (error) {
      const m = /asx_ApplyDataUpdates:item-failed:([^:\s]+):([\s\S]*)$/.exec(error.message);
      if (!m) throw error;          // any other error: stop and try again later
      failed = { token: m[1], message: m[2] }; // the token goes back unchanged
      continue;                     // the next call reports the item
    }
    if (response.Done) return JSON.parse(response.Latest);
  }
}
```

## `asx_StartDueSchedules`: drive due Rule Schedules

Finds every due **Rule Schedule** (`asx_ruleschedule`) and starts or continues its rule's Rule
Run. A caller on a timer drives it from **outside** Dataverse: the scheduler add-on's flow, or your
own (*Scheduling Rules*). It also records a heartbeat on **Scheduler Status**
(`asx_schedulerstatus`) for the hub's status chip.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `IncludeDiagnostics` | Boolean | Yes | `true` adds `Diagnostics`. Default `false` |

| Response | Type | Notes |
|---|---|---|
| `RunIds` | String | JSON array (not a comma-separated list) of Rule Run ids, each once: runs started, then runs continued, then other active runs of scheduled rules left from earlier calls |
| `ScheduledCount` | Integer | Due schedules this call found (at most 50) |
| `Diagnostics` | String | With `IncludeDiagnostics: true` (see `asx_RunRules`) |

```http
POST /api/data/v9.2/asx_StartDueSchedules
Content-Type: application/json

{}
```

```json
{ "RunIds": "[\"00000000-0000-0000-0000-000000000000\"]", "ScheduledCount": 1 }
```

- A call takes at most **50** due schedules and stops taking more after about **60 seconds**. The
  rest stay due for the next call.
- **Every N minutes/hours** schedules keep their rhythm: the next run is the next step after the
  previous **Next run on**, not N from the call.
- A rule that already has an active run is **continued**, not started again, so a returned run may
  be partway through.
- Drive each id with `asx_ProcessRunPage` in the order given: new runs come first, so a long
  continued run never holds up the rules started after it.
- Runs it starts are **owned by the caller**. It needs the same run privileges as
  `asx_ApplyRules` (gate: **Rule Run Create**, `prvCreateasx_RuleRun`; *Scheduling Rules* lists the
  set), and nothing on Rule Schedule or Scheduler Status.
- A failed call rolls back entirely, heartbeat included. Two callers at the same moment can make
  one fail; call again next interval, and nothing is lost.

## `asx_ReadRules`: runtime projection

Returns a table's rule definitions as JSON: triggers, the condition-group tree, the Table Config
nodes each condition uses, and the actions. It evaluates **nothing**: `asx_RunRules` answers "what
fired for this record?", `asx_ReadRules` answers "what are this table's rules?". It's a Dataverse
**Function**, callable with `GET`. The form library calls it once per table on form load.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the table |
| `Triggers` | String | Yes | One trigger name; default `OnForm` |

It returns only rules that would apply: **Published**, with the requested trigger, a matching
Channel (*Triggers & Channels*), and within the effective window (*Rule Lifecycle*). With no
match, the envelope has an empty `rules` array, not an error.

| Response | Type | Notes |
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
      "actions": [ /* actionType, targetColumn, value, message, severity, order, ... */ ]
    }
  ]
}
```

Field names are camelCase and enums are string names. `message` is localized to the caller's UI
language (`languageId`). Write actions add `targetTable`, `targetNode` and `fieldMapping`.

## `asx_SyncSteps`: reconcile or remove the generated steps

Manual control over the generated enforcement steps (*Plugin Registration*), for what automatic
reconciliation doesn't cover: drift, and clearing up before an uninstall. The **calling** user
needs `prvWriteSdkMessageProcessingStep`; the step changes themselves run as the system user.

| Request | Type | Optional | Notes |
|---|---|---|---|
| `Mode` | String | Yes | `Sync` (default when omitted or empty) or `RemoveAll`, case-insensitive. Anything else fails |

- **`Sync`** reconciles every table that has rules: registers missing steps, widens narrow ones,
  and deletes ones no rule needs. Use it after a step was edited or removed by hand. To repair one
  table, deactivate and reactivate any rule on it.
- **`RemoveAll`** deletes every step the engine owns, before an uninstall (*Installing, Verifying
  & Uninstalling*). Enforcement stops at once, so on a live environment treat it as an outage.
  Publishing a rule, or a later `Sync`, regenerates the steps.
- Neither mode re-enables a step an administrator deactivated: it's counted, reported and left
  alone (*Troubleshooting*).

| Response | Type | Notes |
|---|---|---|
| `TablesProcessed` | Integer | Tables examined |
| `StepsCreated` | Integer | Steps registered |
| `StepsUpdated` | Integer | Existing steps widened or corrected |
| `StepsDeleted` | Integer | Steps removed |
| `DeactivatedStepsFound` | Integer | Deactivated steps seen and left alone |
| `Details` | String | JSON array, one entry per table where something changed; empty when everything was already correct |

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

## `asx_DeleteRule`: delete a rule and its owned configuration

```http
POST /api/data/v9.2/asx_DeleteRule
Content-Type: application/json

{"RuleId":"00000000-0000-0000-0000-000000000000"}
```

`RuleId` is a required String; the caller needs the rule Delete privilege. In one transaction it
removes the rule, its working draft, its conditions and actions, its revisions, and private data
models no other rule uses. Shared models stay. Deleting only a working draft keeps the published
rule. A rule that doesn't exist succeeds without changes. There are no response properties. The
Rule Builder uses it to delete rules.

A native `DELETE asx_rules(id)` (what the standard Rules grid uses) removes the same graph in its
transaction; the API adds idempotent deletion of an already-absent rule.
