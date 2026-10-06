---
title: Custom APIs
section: Developer Reference
order: 402
slug: custom-apis
---

# Custom APIs

The engine exposes eight **unbound Dataverse Custom APIs** for integrating with rules
outside the built-in save enforcement and form behavior described in *How Rules Run*.
All eight are callable through the standard Dataverse Web API
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
enforcing anything. This is the **On demand** trigger's dry-run API described in
*How Rules Run*, and what the client form library round-trips to for every rule
it evaluates on a form. See *Client Form Library*. For the **enforcing**
on-demand path, see `asx_ApplyRules` below.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `TableName` | String | No | Logical name of the record's table |
| `RecordId` | String | Yes | GUID of an existing record |
| `RecordJson` | String | Yes | Unsaved field values as a flat JSON object `{ "<logicalname>": <value> }` |
| `Triggers` | String | Yes | Single trigger name; defaults to `Manual`. Both `OnDemand` and the older `Manual` name are accepted for trigger value 3 (*Triggers & Channels*) |
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
| `Outcomes` | String | JSON array of each rule outcome's value per record (see below) |
| `ChangeSet` | String | JSON object summarizing the writes this evaluation would make (see below) |
| `Diagnostics` | String | Only when `IncludeDiagnostics` was `true`: a JSON object describing the evaluation (see below) |

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

Enums serialize as string names; fields irrelevant to a given action type are
`null`. A fired `CreateRecord` / `UpdateRecord` / `DeleteRecord` / `DeactivateRecord` action
against a **single-record** target also carries a `write` object, the fully-resolved write intent
(`operation`, `targetTable`, `targetId`, `values`). `asx_RunRules` reports that intent; only the
server engine applies it, on Create/Update/Delete. See *Runtime Enforcement*. A create's
`targetId` is always `null`: the engine never reports the id it will assign, and nothing in the
same save can refer to a record created by it.

A fired action against a **set** target (a collection node) instead carries `writes` (the first
100 resolved rows, in the same shape as `write` above), `writeCount` (the total number of rows
this action resolved — **every** filtered row, including any already unchanged, not only the ones
that would actually be written), and `unchangedCount` (how many of those already hold the mapped
values, so nothing would change for them — a subset of `writeCount`, not additional to it). This
differs from `asx_ApplyRules`' top-level `WriteCount` below, which counts only rows actually
written.

```json
{ "ruleId": "…", "actionType": "UpdateRecord", "targetTable": "contact",
  "writes": [ { "operation": "Update", "targetTable": "contact", "targetId": "…", "values": { "donotbulkemail": true } } ],
  "writeCount": 12, "unchangedCount": 3 }
```

A fired action also carries `previousOf`: the id of the root-level lookup node when the action
fired for the previous value of a changed lookup ("Also apply to the previous"), absent
otherwise. It appears only when the dry run evaluates an Update — `Triggers` is `OnUpdate` and
both `RecordId` and `RecordJson` are supplied. `previousOf` doesn't apply to a set target: "Also
apply to the previous" is available only on a single-record target.

**`Outcomes`** reports the value of every outcome (top-level validation group) of every rule
evaluated, per record:

```json
[{ "recordId": "…", "ruleId": "…", "outcomeId": "…", "name": "High value", "value": true }]
```

`name` is the outcome's name and `value` is `true` or `false`. The values are those of the normal
run only. A rule held back by its execution conditions reports no outcomes. `Results` keeps its
shape. The Rule Builder's **Test** dialog lists the tested rule's outcomes from this output. The
`Outcomes` output is created by `pipelines/Configure-RuleAuthoring.ps1` when the deploy's Register
phase runs.

**`ChangeSet`** summarizes every write this evaluation would make, across every rule and action
that fired, after writes to the same record are merged (see *Building Actions* → *Writing a set of
rows*):

```json
{ "creates": 1, "updates": 12, "deletes": 0, "unchanged": 3 }
```

A record with a fired `Block` counts zero in every field (`IsValid` is `false`): enforcement
would write nothing for it. An update of the evaluated record itself counts as an update here,
although a form save applies it to the record in place rather than as a separate write.

This is the same summary the Rule Builder's **Test** dialog renders as "Change set: 1 create, 12
updates, 0 deletes · 3 unchanged".

**Diagnostics** (opt-in, `IncludeDiagnostics: true`) report what the evaluation cost,
for support conversations and your own sizing against the *Beta Limitations* budget:

```json
{
  "totalMs": 412,
  "rulesLoaded": 12, "rulesEvaluated": 12, "rulesFired": 1,
  "retrieveCount": 3, "retrieveMultipleCount": 4, "rowsFetched": 260,
  "stages": [ { "name": "ruleLoad", "ms": 40 }, { "name": "queryExecute", "ms": 310 }, { "name": "evaluate", "ms": 62 } ],
  "nodes":  [ { "nodeId": "…", "table": "sample_orderline", "retrieveCount": 0, "retrieveMultipleCount": 2, "rows": 240 } ]
}
```

`stages` are the engine's internal phases; the names may change between releases, so
treat them as labels, not an API. `nodes` is one entry per traversed configuration
node. The numbers are server-side evaluation cost only, not end-user save latency.

The enforcing paths report more. `asx_ApplyRules`, `asx_ProcessRunPage` and `asx_StartDueSchedules` return the same object when called with `IncludeDiagnostics: true`, and every form save the engine finishes evaluating writes it to the plug-in trace (*Troubleshooting*); a save that fails during evaluation, for example at the 25,000-row limit, writes none. There `totalMs` covers the whole call or save, and these fields appear when they aren't zero:

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

Their stages add `changeSetBuild`, `applyInPlace`, `dispatch:<operation>:<table>`, `pageSelect`, `pageEvaluate`, `pageWrite`, `bookmark`, `dueQuery`, `scheduleStart` and `heartbeat`; as above, treat stage names as labels.

## `asx_ApplyRules`: enforcing on-demand evaluation

Evaluates one **On demand** rule against one persisted record and, unlike
`asx_RunRules`, **enforces** the result: a fired `Block` throws, and every other
fired write action runs inside the call's own transaction. It's what a script or
a command button calls directly for a single record (see the recipe below).
**Run now** doesn't call it: Run now creates a Rule Run and drives it with
`asx_ProcessRunPage` (below), even for one record.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RuleId` | Guid | No | The On demand rule to evaluate; must be Published with the On demand trigger |
| `RecordId` | Guid | No | An existing record of the rule's table; for a User-context rule, one the caller can read |
| `IncludeDiagnostics` | Boolean | Yes | When `true`, the response also carries `Diagnostics`. Default `false` |

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `IsValid` | Boolean | `true` when no `Block` action fired |
| `Results` | String | JSON array of every fired action, in the `asx_RunRules` `Results` shape above |
| `WriteCount` | Integer | Number of rows written (rows skipped as unchanged don't count) |
| `Diagnostics` | String | Only when `IncludeDiagnostics` was `true`: timings and counts for this call (see the `asx_RunRules` Diagnostics above) |

Calling it requires the **Rule Run Create** privilege (`prvCreateasx_RuleRun`),
the same gate as starting a Rule Run; *Running Rules On Demand* lists the rest of
what running rules needs. A record that doesn't exist, or that a User-context
rule's caller can't read, is refused: "Record … was not found in …, or you can't
read it." The rule's **Runs for** setting doesn't restrict `asx_ApplyRules`: it's
allowed against a rule scoped either way, since it always targets exactly one
record.

## `asx_ProcessRunPage`: advance a Rule Run

Processes the next page of an existing Rule Run (`asx_rulerun`), driven from
**outside** Dataverse by repeated calls so every page starts fresh. **Run now**
and the **Runs** dialog (*Running Rules On Demand*) call this in a loop; a flow
or an integration can call it the same way (see the recipe below).

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `RunId` | Guid | No | The Rule Run to process |
| `FailedRecordId` | Guid | Yes | The record named by the previous call's record-failed error (see below); the call only counts it Failed once |
| `FailedMessage` | String | Yes | The message from that error, stored on the run; default `"The write failed."` |
| `IncludeDiagnostics` | Boolean | Yes | When `true`, the response also carries `Diagnostics`. Default `false` |

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `Done` | Boolean | `true` when the run has no further pages to process |
| `Status` | Integer | Current `asx_status` of the run: Queued (1), Running (2), Completed (3), Completed with failures (4), Failed (5), Cancelled (6) |
| `Evaluated` / `Changed` / `Blocked` / `Failed` / `Skipped` | Integer | Running totals as of this page (see *Running Rules On Demand*) |
| `Diagnostics` | String | Only when `IncludeDiagnostics` was `true`: timings and counts for this call (see the `asx_RunRules` Diagnostics above) |

If the run isn't Queued or Running (it already reached a terminal status, or was
Cancelled), the call returns `Done = true` with that status and does nothing.
Otherwise it processes up to **500 records** or **60 seconds**, whichever comes
first, then saves its progress and returns. Calling it needs the same privileges
as `asx_ApplyRules`. Two callers driving the same run take turns: each call locks
the run while it works, so the second one continues from what the first saved.

**Retrying a failed write.** A write that throws fails the whole call with an
error whose message contains the marker
`asx_ProcessRunPage:record-failed:<record guid>:<message>` (Dataverse may wrap it
in a longer message, so search for the marker rather than expecting it at the
start), and the platform rolls that call back — no writes and no run update from
it are kept. Call again with `FailedRecordId` and `FailedMessage` set from that
marker: that call **only** records the failure (the record is counted Evaluated
and Failed once, the message cut to 1,000 characters, and both kept among the
run's first 50 recorded failures) and returns, without processing further
records. The next call,
made **without** `FailedRecordId`, resumes normal processing, skipping the
records already reported this way. Send `FailedRecordId` only on the call right
after a record-failed error — any other error means stop and try again later;
the run stays Queued or Running and resumes from its bookmark.

When a batched group write fails, the id in the error may stand for the group rather than a record; send it back as `FailedRecordId` exactly as for a record — the next calls write that group one record at a time and report the record that fails.

```http
POST /api/data/v9.2/asx_ProcessRunPage
Content-Type: application/json

{"RunId":"00000000-0000-0000-0000-000000000000"}
```

```json
{ "Done": false, "Status": 2, "Evaluated": 500, "Changed": 210, "Blocked": 4, "Failed": 0, "Skipped": 286 }
```

### Recipe: a command button that runs a rule for the open record

A ribbon or command-bar button calling `asx_ApplyRules` against whatever record
is open, using `Xrm.WebApi.online.execute`:

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

A cloud flow that starts a Rule Run and drives it to completion:

1. **Create a row** — table `Rule Runs` (`asx_rulerun`), with `Rule`
   (`asx_Rule@odata.bind`, note the capital `R`) set to the rule, and — for a
   rule scoped to **a record it's given** — `Record Ids` (`asx_recordids`) set to
   a JSON array of the record ids to run it for.
2. **Initialize variable** `Done` = `false`.
3. **Do until** `Done` is `true`:
   1. **Perform an unbound action** — `asx_ProcessRunPage`, `RunId` = the row
      created in step 1. On failure, check whether the error message contains
      `asx_ProcessRunPage:record-failed:`; if it does, parse out the record guid
      and the message and call `asx_ProcessRunPage` again with `FailedRecordId`
      / `FailedMessage` set, then loop back to the top of **Do until** without
      setting `Done` (so the next iteration retries the page). Any other failure
      should end the flow — the run stays Queued or Running and can be resumed
      by running this flow (or **Resume** in the Runs dialog) again later.
   2. **Set variable** `Done` = the action's `Done` output.

## `asx_ApplyDataUpdates`: report or apply data updates

Reports the data updates a release carries, and applies the ones still pending. The Rule Builder
calls it to show the pending-update banner and to run **Apply now**; a script or pipeline can call it
the same way (the engine's own deploy pipeline does).

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `Mode` | String | No | `Status` reports; `Apply` applies. Anything else is refused |
| `Retry` | Integer | Yes | `Apply` only: the number of an update that completed with failures, to run again from the start |
| `FailedItem` | String | Yes | `Apply` only: the failed-item token from the previous call's item-failed error, sent back exactly as received (see below) |
| `FailedMessage` | String | Yes | `Apply` only: the message from that error; default `"The item failed."` |

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `Required` | Integer | The highest update number this release carries (`0` for none) |
| `Pending` | String | JSON array `[{"number":1,"title":"…"}]` of the updates still to apply |
| `Latest` | String | JSON `{"number","title","status","succeeded","failed","failures":[{"item","message"}]}` for the most recently touched update, or `null`. `status`: Running (1), Completed (2), Completed with failures (3) |
| `CanApply` | Boolean | `true` when the caller may apply |
| `Done` | Boolean | `true` when nothing is pending |

`Status` needs the **Rule Read** privilege (`prvReadasx_rule`), so anyone who can open the Rule Builder
can call it. `Apply` also needs `prvWriteSdkMessageProcessingStep` (System Administrator or System
Customizer); without it the call fails with "asx_ApplyDataUpdates: only a System Administrator or
System Customizer can apply data updates." The shipped roles grant nothing on the Data Update table.

An `Apply` call works for up to **60 seconds**, saves its progress, finishes at most one update, and
returns. **Call again until `Done` is `true`.** Two callers take turns: each call locks the update's
row while it works. The one exception is an update's very first `Apply`, which creates its row: if two
administrators start it at the same moment, one of them can fail with a duplicate-row error. Apply
again; it carries on from what the other saved.

**Retrying a failed item.** An item that throws fails the whole call with an error whose message
contains the marker `asx_ApplyDataUpdates:item-failed:<token>:<message>` (Dataverse may wrap it, so
search for the marker), and the platform rolls that call back. The token is `<number>/<item>`: which
update failed and on which item. Treat it as opaque and send it back exactly as received: call again
with `FailedItem` set to the token and `FailedMessage` set from the marker. That call only records the
failure against that update and returns (it records nothing if another caller has finished that
update meanwhile). The call after it, made without `FailedItem`, carries on and skips the item. Send
`FailedItem` only on the call right after an item-failed error; any other error means stop and try again later, because the update resumes
from its saved position. An update whose items all fail still finishes: it ends **Completed with
failures**, with every failure listed in `Latest`. Call with `Retry` set to its number to run it
again after fixing the cause.

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

Finds every currently-due **Rule Schedule** (`asx_ruleschedule`, *Schema Reference*)
and starts or continues each one's Rule Run, driven from **outside** Dataverse by a
caller on a timer — the shipped scheduler add-on's flow, or your own (*Administering →
Scheduling Rules*). It also records a heartbeat on **Scheduler Status**
(`asx_schedulerstatus`), which the hub reads for its status chip.

**Request**

| Parameter | Type | Optional | Notes |
|---|---|---|---|
| `IncludeDiagnostics` | Boolean | Yes | When `true`, the response also carries `Diagnostics`. Default `false` |

**Response**

| Parameter | Type | Notes |
|---|---|---|
| `RunIds` | String | JSON array of Rule Run ids (not a comma-separated list): the runs this call started, then the runs it continued, then any other active run of a scheduled rule left over from a previous wake-up; each id once |
| `ScheduledCount` | Integer | Number of due schedules this call found (at most 50) |
| `Diagnostics` | String | Only when `IncludeDiagnostics` was `true`: timings and counts for this call (see the `asx_RunRules` Diagnostics above) |

```http
POST /api/data/v9.2/asx_StartDueSchedules
Content-Type: application/json

{}
```

```json
{ "RunIds": "[\"00000000-0000-0000-0000-000000000000\"]", "ScheduledCount": 1 }
```

At most **50** due schedules are taken per call, and a call stops taking more once about
**60 seconds** have passed; whatever it didn't reach stays due and is picked up by
further calls (further wake-ups of the add-on's flow, on its own 15-minute interval).
Every **Every N minutes/hours** schedule keeps its rhythm: its next run is the next step
after its previous **Next run on**, not N from the moment of the call.

The runs it starts are **owned by the caller**, like a run started by hand. Calling it
requires the same run privileges as `asx_ApplyRules`/`asx_ProcessRunPage` (the gate is
**Rule Run Create**, `prvCreateasx_RuleRun`; *Administering → Scheduling Rules* lists the
full set). The caller needs no privileges on Rule Schedule or Scheduler Status: the
engine writes those itself.

Drive each returned id with `asx_ProcessRunPage` (above) the same way Run now does, in
the order given: new runs come first, so a long run that keeps being continued never
holds up the rules started after it. A schedule whose rule already has an active run is
reported as **continued**, not started again, so an id in `RunIds` may already be
partway through. A call that fails rolls back entirely, heartbeat included, and two
callers at the same moment may make one of them fail; simply call again on the next
interval — nothing is lost.

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
      "actions": [ /* actionType, targetColumn, value, message, severity, order, ... */ ]
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

## `asx_DeleteRule`: delete a rule and its owned configuration

The Rule Builder calls this unbound action when deleting a rule:

```http
POST /api/data/v9.2/asx_DeleteRule
Content-Type: application/json

{"RuleId":"00000000-0000-0000-0000-000000000000"}
```

`RuleId` is a required String. The caller needs the rule Delete privilege, enforced by the platform. The operation removes the rule, its working draft,
owned conditions/actions, revisions, and unused private models in one transaction.
Shared models are retained. Deleting only a working draft retains the published
original. An absent rule succeeds without changes. There are no response properties.

Native `DELETE asx_rules(id)` is also supported and removes the same owned graph
inside its transaction. The standard Dataverse Rules grid uses that path. The API
additionally offers idempotent deletion when the rule is already absent.
