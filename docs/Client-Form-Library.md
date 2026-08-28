# Client Form Library (`asx_rulesengine.js`)

A TypeScript-authored, esbuild-bundled JavaScript **web resource** that runs on model-driven
forms. For authoring the engine's own `asx_` config tables, see [`docs/Authoring-Forms.md`](Authoring-Forms.md). On form load it fetches the table's `OnForm` rule definitions via `asx_ReadRules`,
evaluates them by round-tripping to `asx_RunRules`, and applies the resulting **client
actions** (`SetVisible` / `SetRequired` / `ShowMessage`) to the form, surfacing `Block`
actions as validation.

---

## 1. What the library does

The load sequence (read the rules once, snapshot a baseline, register an `OnChange` handler on
each dependency column, no `OnSave` handler) and the evaluate→apply cycle are described in
*Client Form Library* in the guide. Two implementation details that page does not carry:

- The **dependency-column set** is derived from the root conditions' `comparisonColumn` /
  `referencedColumn`. The **action universe** is every target column plus the form-level
  block/message any action governs; the baseline snapshot covers exactly that universe.
- The round-trip is
  `asx_RunRules(TableName, RecordId?, RecordJson, "OnForm")` → `Results` (all fired actions)
  + `IsValid`, with `RecordJson` carrying only the root dependency columns.

**Action mapping:**

| `actionType` | Form effect | Blocks save? |
|---|---|---|
| `SetVisible` | `control.setVisible(value)` | no |
| `SetRequired` | `attribute.setRequiredLevel("required"` or `"none")` | empty required field blocks natively |
| `ShowMessage` (field-targeted) | `control.addNotification(...)`, inline on the field | **yes** (see the note below) |
| `ShowMessage` (form-level / no field) | `ui.setFormNotification(message, level, uid)`, banner | no (informational at any severity) |
| `Block` (field-level) | `control.addNotification(...)`, inline on the field only | **yes** (client), and the server enforces too |
| `Block` (form-level / no field) | `ui.setFormNotification(message, "ERROR", uid)`, banner | no (client); the server enforces |
| `CreateRecord` | ignored: server-only (phase 2) | n/a |

The client only *surfaces* rule outcomes:

- A **field-targeted** `Block` shows **only** an inline `control.addNotification` on the field: on
  save the platform rolls that notification up to the form header itself (prefixed with the field
  label and a colon, e.g. `Order Total: …`) and blocks the save at its validation stage, so a form
  banner would *duplicate* the roll-up. *(A top-of-form banner during editing, for awareness of an
  error on another tab, was considered and deferred: it can't be de-duplicated, because `OnSave`
  runs at the bottom of the pipeline, after validation.)*
- A **form-level / no-field** `Block` shows a form banner: with no field to attach to there is
  nothing for the platform to roll up, so the banner is its sole indicator.

The **server plugin is the authoritative enforcer** of `Block` on Create/Update. A field-level
`Block`'s `ERROR` control notification also stops that form save client-side at validation, leaving
the server as the backstop for non-form writes. Pinned by
`client/e2e/formBlockClientSide.e2e.spec.ts` T2, which blocks a violating save and admits a
compliant one.

### Any message on a FIELD stops the save. This is a platform constraint, not a choice.

A `ShowMessage` that targets a column blocks the save exactly as a field-level `Block` does, until
the condition that raised it stops matching. The action's `severity` does not change this. Measured
against a live form, adding a control notification directly and then saving:

| `notificationLevel` | `actions` array | save | inline message rendered? |
|---|---|---|---|
| (none added) | n/a | saves | n/a |
| `ERROR` | no | **blocked** | **yes** |
| `RECOMMENDATION` | no | saves | **no** |
| `RECOMMENDATION` | yes | saves | **no** |

The only level that **renders** an inline message on a field is `ERROR`, and `ERROR` blocks.
**There is therefore no such thing as a visible, non-blocking inline field message on a
model-driven form**; routing `ShowMessage` through `RECOMMENDATION` would make it invisible, not
friendly.

**To show a message that does not block, leave the target column empty.** It renders as a
form-level banner, which is informational at any severity. The rule editor says so beside the
target-column picker. Pinned by `formBlockClientSide.e2e.spec.ts` T4 (field-targeted blocks) and
T5 (form-level banner does not).

---

## 2. Build

The project lives in `client/`. Prerequisites: Node.js. Install dependencies once with
`npm ci`, which respects the committed lockfile.

```
cd client
npm run build
```

Output: `client/dist/asx_rulesengine.js`, an esbuild IIFE bundle, ES2015 target, exposing
the `Ascentix.RulesEngine` global namespace. The `client/dist/` directory is git-ignored;
build on demand before deployment.

Run the tests:

```
cd client
npm test
```

---

## 3. Deployment

### 3.1 Build the bundle

```
cd client
npm run build
```

### 3.2 Author the web resource into the solution

Upload `client/dist/asx_rulesengine.js` as the JScript web resource
`asx_/rulesengine/asx_rulesengine.js`, display name **Ascentix Rules Engine (form library)**,
into the `AscentixRulesEngine` solution, and publish it via `PublishXml`. The step is
idempotent: create the web resource if it is missing, otherwise update its content, and add it
to the solution either way. Repeat after every `npm run build`.

### 3.3 Wire the library onto each target form

Add the web resource (`asx_rulesengine`) as a **form library** and register the single `OnLoad`
handler. The exact event, function and "pass execution context" setting are in *Client Form
Library* in the guide.

Nothing else is registered by hand: from inside `onLoad` the library self-registers `OnChange`
handlers at runtime, on the dependency columns it discovers from `asx_ReadRules`, and it registers
no `OnSave` handler.

---

## 4. Evaluation is a server round-trip

Every `OnForm` rule is delegated to `asx_RunRules`: the rule classifier is a stub that always
returns `NeedsExternal`. The rest of the client (wiring, the `asx_ReadRules` cache, the round-trip,
the action applier, and the test harness) is complete and tested against that.

The classification predicate that would let a root-only rule be evaluated in the browser instead is
specified in `docs/Schema.md`, but no in-browser evaluator implements it. Should one be added, it
sits behind the same applier and wiring.

---

## 5. Graceful degradation

The server plugin enforces validation authoritatively, so the client must never break or freeze
the form on its own failure:

- When **`asx_ReadRules` fails on load** (network error, caller lacks the Rules Engine Reader role,
  or the API is not deployed), the library logs to `console.error`, skips all wiring (no
  `OnChange` handlers registered), and leaves the form usable as-is. No end-user error banner.
- **`asx_RunRules` fails mid-cycle** (network error, non-2xx): the library logs the error and
  retains the last successful cycle's state. It does not wipe the form, does not fabricate block
  notifications, and does not call `preventDefault` on save for a transient error.
- **`asx_RunRules` returns 200 with no `Results`** is treated as a **failure**, not as "nothing
  fired", and handled exactly as the case above. An empty action list is a legitimate, successful
  answer that the applier acts on by clearing everything, so silently coercing an absent payload
  into one would wipe the user's blocking message and restore every governed control while logging
  nothing at all. `readRules` has always rejected the equivalent shape; `runRules` now does too.
- **The applier itself throws while applying** (a control disappears mid-cycle, `Xrm` misbehaves):
  the failure is logged, and applying is **atomic**, so the previous cycle's notifications and
  control state survive a failed apply rather than the form being left half-applied. Later cycles
  continue to work.

The invariant behind all four: **this library fails closed, never open.** Anything that cannot be
applied leaves the last known-good state in place, because a user reads a clean form as "my data
is fine".

These four paths are pinned by `client/e2e/formLibraryEdgeCases.e2e.spec.ts` and
`client/e2e/formLibraryResilience.e2e.spec.ts`, which inject each failure against a live form.

---

## 6. Module overview

| Module | Responsibility |
|---|---|
| `contract.ts` | TypeScript types mirroring the `asx_ReadRules` envelope and `asx_RunRules` results shape. |
| `xrm.ts` | Thin adapter over the `Xrm` form API, the only module that touches `Xrm`; defined as an interface so tests use a mock. |
| `api.ts` | Calls `asx_ReadRules` (once, cached) and `asx_RunRules` via `Xrm.WebApi.online.execute`. |
| `classifier.ts` | Stub: always returns `NeedsExternal`, so every rule round-trips to the server. |
| `recordJson.ts` | Serializes current form values for root dependency columns into the `RecordJson` encoding (`docs/Schema.md` §3). Pure (takes the `xrm` interface). |
| `applier.ts` | Maps fired actions to form effects; reset-to-baseline then apply each cycle. |
| `engine.ts` | Orchestrator: OnLoad bootstrap, OnChange handlers, evaluate→apply cycle, sequence guard, degradation. |
| `index.ts` | Entry point exposing `Ascentix.RulesEngine.onLoad`; esbuild bundles to `dist/asx_rulesengine.js`. |
