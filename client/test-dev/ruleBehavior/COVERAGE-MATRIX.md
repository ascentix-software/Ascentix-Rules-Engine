# Rule-behavior coverage matrix — the program rollup

This is the capstone map of the rule-behavior E2E program: every rule config dimension × execution
path → the documented outcome → the live test that proves it (or a labelled **GAP** with a reason).
All cited suites run against **live DEV** (`npm run test:dev` for server + report-only cases,
`npm run test:e2e` for the browser/client cases), author real `ZZ_RB_` rules + records, assert the
enforcing plugin's actual behavior, and self-clean. None run in CI (local-only, non-hermetic).

Oracle by path: **server Block** = a fired Block throws `InvalidPluginExecutionException` (400
"This record could not be saved:" + the rule's message) and rolls back; **server write** = the
engine's Create/Update/Delete is observed on the row; **client form** = the form applier's effect on
`Xrm.Page` / notifications; **report-only** = `asx_RunRules` returns which actions fired, never writes.

Suites: `ruleBehaviorBlock`, `formActions` + `formLibrary{Smoke,State,Notify}`,
`ruleBehaviorWrite`, `ruleBehaviorAggregate`, `ruleBehaviorDateTemplate`,
`ruleBehaviorTraversal`, `ruleBehaviorExists`, `ruleBehaviorInFlight`, `ruleBehaviorMultiTree`,
`ruleBehaviorChannel` +
`channelFormSave.e2e`, `ruleBehaviorMatrix`, `ruleBehaviorRunRules` (report-only).

## Action type × enforcement path

| Action (type) | Path | Documented outcome | Proving test |
|---|---|---|---|
| SetVisible (1) | client form | shows/hides a field on the form; no server effect | `formLibraryState.e2e` |
| SetRequired (2) | client form | toggles field requirement on the form | `formLibraryState.e2e` |
| ShowMessage (3) | client form | renders a form notification at the given severity | `formLibraryNotify.e2e` + `formActions` |
| Block (4) | server | throws + rolls back the write | `ruleBehaviorBlock`, `ruleBehaviorMatrix` |
| CreateRecord (5) | server write | engine creates the mapped record | `ruleBehaviorWrite` |
| UpdateRecord (6) | server write | engine updates the target (root-in-place / related) | `ruleBehaviorWrite` |
| DeleteRecord (7) | server write | engine deletes/nullifies the target (on Update) | `ruleBehaviorWrite` |

## Condition type

| Condition (type) | Documented outcome | Proving test |
|---|---|---|
| FieldComparison (1) | compares a column to a value/reference | `ruleBehaviorBlock`, `ruleBehaviorMatrix` |
| RowCount (2) | counts (optionally filtered) child rows vs min/max | `ruleBehaviorBlock`, `ruleBehaviorAggregate`, `ruleBehaviorTraversal` |
| RegexMatch (3) | tests a column against a pattern | `ruleBehaviorAggregate` |
| Expression/aggregate (4) | sum/avg/min/max/count + arithmetic vs a value | `ruleBehaviorAggregate`, `ruleBehaviorMatrix` empty-edge |

## Comparison operator (1–10)

| Operator | Proving test |
|---|---|
| Equals(1) NotEquals(2) GreaterThan(3) GreaterThanOrEqual(4) LessThan(5) LessThanOrEqual(6) | `ruleBehaviorBlock` (numeric matrix on Money) |
| Contains(7) | `ruleBehaviorMatrix` |
| DoesNotContain(8) | `ruleBehaviorMatrix` |
| IsNull(9) | `ruleBehaviorMatrix` — live-proven against DEV (engine fix `9f57f7b`: IsNull matches an absent/null column) |
| IsNotNull(10) | `ruleBehaviorMatrix` |

## Value source (condition RHS)

| Source | Proving test |
|---|---|
| Literal (1) | `ruleBehaviorBlock` |
| FieldReference (2), incl. 2-hop | `ruleBehaviorBlock`, `ruleBehaviorTraversal` |
| Template (3) — incl. `{node}` | `ruleBehaviorDateTemplate`; `{node}` un-skipped post-fix `aab6434` |
| DateExpression (4) | `ruleBehaviorDateTemplate` |

## Node filter ("only consider records where…")

| Filter kind | Proving test |
|---|---|
| Comparison criterion (self + ancestor, value-from-record) | `ruleBehaviorTraversal` |
| EXISTS criterion (min/max + sub-filter over a sibling collection) | `ruleBehaviorExists` — validator fix `95c2684` |

## Trigger

| Trigger | Proving test |
|---|---|
| OnCreate (1) | `ruleBehaviorBlock` |
| OnForm (2) | `formActions` + `formLibrary*.e2e` |
| Manual / report-only (3) | `ruleBehaviorRunRules`, `ruleBehaviorBlock` RowCount probe |
| OnUpdate (4) | `ruleBehaviorBlock`, `ruleBehaviorAggregate` |
| OnDelete (5) | `ruleBehaviorMatrix` — Block on delete blocks + row survives |

## Channel (asx_channels gate)

| Channel | Documented outcome | Proving test |
|---|---|---|
| Standard (1) | every non-portal origin — a human form save, the az user token, the SP app user — is gated Standard (the engine does not tell a human from an integration: DEV populated `InitiatingUserApplicationId` for a human's UCI save) | `channelFormSave.e2e` (C Part B) — a Standard-only rule blocks the form save AND the SP write; `ruleBehaviorChannel` (C Part A) — 5 cases (empty/Standard/multi/Update blocked for SP + az user; Portal-only excluded); settle-aware `expectBlocked`. **Live-proven post-deploy** on the Standard/Portal engine (main `1d90849`): the L2 run had `ruleBehaviorChannel` 5/5 (within 110/110); L3 `channelFormSave.e2e` 3/3 from the desktop (Standard-only blocks the form save AND the SP write; Portal-only blocks neither; empty = all) |
| Portal (2) | firing needs a real Power Pages call | **GAP** — firing untestable (no Power Pages site in DEV); `OriginResolver` portal branch + the plugin's Portal path are unit-tested against a faked `IPluginExecutionContext2`; a Portal-only rule's **exclusion** of both drivable callers IS proven (C Part A: SP allowed; C Part B: neither the form save nor the SP write is blocked) |
| legacy 3 ("Application", retired) | a stored 3 reads as Standard | L1 `ChannelFilterTests.Legacy_application_value_counts_as_Standard` — no live case (the DEV choice no longer offers 3) |

## Severity (of a Block)

| Severity | Documented outcome | Proving test |
|---|---|---|
| Error (3) | blocks | `ruleBehaviorBlock` |
| Warning (2) / Information (1) | still blocks — severity is a message level, not a block switch | `ruleBehaviorMatrix` (D, Warning) + A1 source assertion |

## FireOn

| FireOn | Proving test |
|---|---|
| OnNoMatch (2), Create + Update | `ruleBehaviorBlock` (every case) |
| OnMatch (1), Create | `ruleBehaviorBlock` |
| OnMatch (1), Update | `ruleBehaviorMatrix` |

## Editor-UI & client e2e expansion (pre-beta hardening)

Beyond the rule-behavior dimensions above, the Playwright layer now also proves the EDITOR and
form-library surfaces end-to-end (all `client/e2e`, local-only):

| Surface | Proving spec |
|---|---|
| New-rule dialog, both data-model modes (existing config / new config+table) | `hubActions.e2e` |
| Hub duplicate ("Copy of X"), delete-with-confirm, config in-use delete guard | `hubActions.e2e` |
| Author condition + action fully in the UI → save → validate → publish | `authorRuleUi.e2e` |
| Validation-failure surfaces (issues panel, Publish gating) | `authorRuleUi.e2e` |
| Optimistic-concurrency 412 → "changed elsewhere" banner, atomic no-write | `authorRuleUi.e2e` |
| Table-config editor: rename, Add related (live metadata), save, in-use node guard | `tableConfigEditor.e2e` |
| Help viewer: nav, search, deployed image resolution, prev/next | `helpViewer.e2e` |
| UpdateRecord authored via the Map-columns dialog (literal source) → server write | `writeActionUi.e2e` |
| ShowMessage rendering variants (severity banner, inline, off-form fallback, multi-action uid) | `formLibraryNotifyVariants.e2e` |
| Create (unsaved) form: rules apply with null recordId, before any save | `formLibraryCreateForm.e2e` |
| Graceful degradation: `asx_RunRules`/`asx_ReadRules` failure → form stays usable | `formLibraryDegradation.e2e` (page.route failure injection) |
| Rule inspector persistence: triggers/trigger-columns/effective window via UI | `ruleInspector.e2e` |
| Lookup condition via LookupPicker → RecordPickerDialog (GUID + name re-resolution) | `lookupCondition.e2e` |
| Editor boot failure (deep link to deleted rule) | `editorErrors.e2e` |
| Unsaved-changes guard (discard dialog, beforeunload) | `unsavedGuard.e2e` |
| Responsive: hub cards <900px, overlay inspector <1000px (focus contract) | `responsive.e2e` |
| Channels multiselect authored in the UI (Standard/Portal, "none = All", clearing to NULL) | `channelsUi.e2e` |
| RowCount / RegexMatch / Calculation conditions authored in the UI (incl. Insert-aggregate) | `conditionTypesUi.e2e` |
| Value sources authored in the UI: FieldReference / Template / DateExpression (+ kind gating) | `valueSourcesUi.e2e` |
| Action row controls: severity, fire-on, Active off, reorder (dense `asx_order`), delete; a localized message | `actionEditingUi.e2e` |
| Keyboard-only hub (automates the keyboard-only L3 manual check) and the pager/status filter in a real browser | `hubKeyboardPaging.e2e` |
| Node filters authored in the UI ("Only consider records where…") — criterion + OR round-trip | `nodeFilterUi.e2e` |
| Condition-group tree: validation band, And/Or, subgroup nesting, condition/group delete | `groupTreeUi.e2e` |
| CreateRecord (TablePicker + literal & from-this-record mappings) and DeleteRecord target gating | `writeActionTypesUi.e2e` |
| Record picker: saved view + Advanced filter (FetchXML merge) and the empty state | `recordPickerAdvanced.e2e` |
| Lookup node via the node inspector; rule → data-model navigation; config duplicate (deep copy) | `dataModelNavUi.e2e` |
| Unpublish releases enforcement; re-publish re-arms it; badge reflects an out-of-band unpublish (automates the unpublish-releases-enforcement L3 manual check). Runs in the `enforcement` project, which `playwright.config.ts` schedules before the rest of the suite — see the ordering note there | `ruleLifecycleUnpublish.e2e` |
| The Unpublish button: offered only for a Published rule, a confirm that names the consequence and really guards on Cancel, the persisted Draft status and badge after Confirm. **F4, live-proven** post-deploy (Client CI on `efa25aa`) | `unpublishUi.e2e` |
| Author → publish → ENFORCE entirely in the UI: a Block rule authored in the editor stops a real form save and admits a compliant one; publish-then-edit re-arms the new threshold (automates the author-to-enforce L3 manual check) | `authorToEnforce.e2e` |
| 5xx on save/publish in a real browser: banner, work stays dirty and recoverable, failed publish leaves the rule Draft | `serverFailureBanners.e2e` |
| SetVisible / SetRequired authored in the UI — incl. the untouched-switch "hide" default — honoured by the live form. **Defect F6, live-proven fixed** post-deploy | `formActionTypesUi.e2e` |
| Condition node binding: the UI happy path produces an ENFORCING rule, and `asx_ValidateRule` rejects a null/foreign binding (`STRUCT_MISSING_FIELD` / `STRUCT_NODE_NOT_IN_TREE`). **Defect F1, live-proven fixed** post-deploy (Client CI + Plugin CI on `c9c1bc0`) | `conditionNodeBinding.e2e` |
| Hub Duplicate deep-copies a rule and leaves the ORIGINAL's node-filter rows untouched. **Defect F5, live-proven fixed** post-deploy | `duplicateRuleIntegrity.e2e` |
| Non-money column types encoded live: a lookup, a choice, a date-time, a boolean and a multi-select set on the form reach `asx_RunRules` in the RecordJson contract shape and fire the rule — every `recordJson.ts` `encode()` branch against a real `Xrm` attribute | `formLibraryDataTypes.e2e` |
| `SetRequired` through a real save, both directions: an empty field the rule marked required blocks natively and a compliant record with the same field empty saves | `formLibraryDataTypes.e2e` |
| Apply-phase resilience: an `Xrm` throw inside `applier.apply` must be logged, must not wipe the previous cycle's state, and must not kill later cycles (a defect probe: it asserts the documented contract) | `formLibraryResilience.e2e` |
| Two published OnForm rules on one table coexist: both apply, one releasing does not release the other, and a banner from one rule plus an inline note from another do not overwrite each other | `formLibraryResilience.e2e` |

| A field-level Block STOPS a real form save client-side (and only for a violating record); the exact message the user reads; a form-level Block banners but does not block. Rules are `triggers:"2"` (OnForm only) so no server step exists and a BLOCKED verdict can only be the client. Also pins the two ShowMessage surfaces: a field-targeted one BLOCKS the save (inherent — only ERROR-level control notifications render, and ERROR blocks), while a form-level one banners and does not. | `formBlockClientSide.e2e` |
| `recordJson.encode()` against REAL Xrm attributes — lookup / optionset / datetime / boolean / multi-select — and `SetRequired` through an actual save in both directions | `formLibraryDataTypes.e2e` |
| Two published OnForm rules coexist and release independently; a banner and an inline note from different rules coexist. **Live-proven fixed** post-deploy: an applier throw is now logged and `apply()` is atomic (compute-then-commit), so a failed cycle no longer wipes the form | `formLibraryResilience.e2e` |
| ReadRules 403 + 200-with-no-Rules degrade cleanly (zero follow-up RunRules); two overlapping RunRules cycles resolve to the newest; an off-form condition column is omitted from RecordJson. **Live-proven fixed** post-deploy: a 200 with no `Results` is now rejected as a failure rather than coerced to an empty action list, so the form is no longer silently wiped | `formLibraryEdgeCases.e2e` |
| Aggregate functions authored from the Insert-aggregate menu: avg / min / max, and the distinct no-column `count` branch; saved and round-tripped (`min` was uncovered at every layer) | `aggregateFunctionsUi.e2e` |
| The aggregate CHIP ROW and `AggregateFilterDialog` ("Only rows where…") — a `filter:f1`-bearing mapping persisted and reloaded, plus in-place rewrite across the count arity boundary. Surface had zero coverage at any layer | `aggregateFiltersUi.e2e` |
| Field-mapping sources `ref` ("Link to a record") and `node` ("From related record") persisted and round-tripped, and the Apply-blocked validation half | `mappingSourcesUi.e2e` |
| A condition's right-hand side pointing at a related node — `BIND_NAV.conditionValueNode` emitted from a browser save on BOTH the create and update bind paths | `conditionValueNodeUi.e2e` |
| Condition literals for Choice / Yes-No / Multi-select persist the option VALUE not its label; a comparison-column KIND change clears the stale operator and value source. **Live-proven fixed** post-deploy: the right-hand column picker now resolves its table from `comparisonValueNodeId`, and a real table change clears a now-invalid column | `conditionValueKindsUi.e2e` |
| The five never-authored RowCount count modes persist the min/max pair their semantics require; Insert-field tokens splice at the caret in a message body and in a translation row | `countModesAndTokensUi.e2e` |
| **Drift guard**: the live `sample_order` form still matches `scripts/sample-app/build-order-form.py` — the expected attribute set, AND that `formxml` still carries the rules-engine web resource, the `Ascentix.RulesEngine.onLoad` handler and `passExecutionContext="true"`. Added after the form and the script were found to disagree twice over: the form carried a column the script did not know about, and the script did not emit the web-resource registration at all, so rebuilding the form destroyed it and every rule-dependent spec went red while the form still looked correct | `formLibrarySmoke.e2e` |
| Nested Insert menus inside the Map columns dialog stay in the accessibility tree at ALL THREE levels, by hover AND by keyboard: no focusable menu item sits under an `aria-hidden` ancestor, and `getByRole` sees the same count as a CSS attribute locator. **Live-proven fixed**. Level 3 matters specifically: the first version of the fix shared one mount node, which broke Fluent's virtual-parent chain and collapsed the menu on hover while keyboard still worked | `menuA11yInDialog.e2e` |

Added by the **form-library / aggregates pass** (+28 tests, 76 -> 104). Four defects
found plus one inherent-behaviour finding. **All four defects are fixed and live-proven
green post-deploy**; the inherent-behaviour finding shipped as a docs correction plus an
editor affordance. The red pins are
deliberate: each asserts documented behaviour the product violates, and each flips green on the
deployed fix.

Editor-side residual risks (re-reviewed after the e2e
expansion): ~~RowCount/Expression conditions and rich value sources
(FieldReference/Template/DateExpression) authored via UI~~ — closed by
`conditionTypesUi.e2e` + `valueSourcesUi.e2e`; ~~hub paging/filter dropdowns~~ — closed
by `hubFilterPaging.dom` (hub companion: search/table/status filters, pager,
page-size, truncation Callout) and re-proven in a real browser by
`hubKeyboardPaging.e2e`; ~~translations authored via UI~~ — authoring closed by
`actionEditingUi.e2e`, foreign-language RENDERING still open (resolver unit-tested; rendering
needs a second-language session); publish-then-edit semantics (recommend a dev-layer pin);
generic 5xx save/publish banners (jsdom).

Defects found by the second e2e coverage pass. All are **fixed and live-proven**
against DEV after the deploy that carries the fixes (Client CI + Plugin CI on `c9c1bc0`);
the four pins that were skipped pending that deploy are now un-skipped and green.

| Defect | Fix | Live proof (post-deploy) |
|---|---|---|
| **F1** A condition authored via the editor's default happy path carried NO table-config node binding. `asx_ValidateRule` returned `isValid:true`, publish succeeded, and every write to the table then threw `0x80040265`. Every existing spec missed it because they author with Manual-only triggers, so their rules never fire | Core `StructuralChecks.CheckCondition` flags an empty binding (`STRUCT_MISSING_FIELD`) or one outside the rule's tree (new `STRUCT_NODE_NOT_IN_TREE`); the editor defaults a new condition to the rule's root node | `conditionNodeBinding.e2e` — both halves **green**: the UI happy path now blocks a violating save and admits a compliant one, and the REST half proves Validate rejects an unbound condition |
| **F5** Hub Duplicate re-pointed the SOURCE rule's node-filter rows at the copy instead of cloning them, silently stripping the original's filter (a published rule filtered to "only lines where qty > 1" started counting every line) | `cloneRuleChildrenWithTempIds` deep-clones the filter tree — block root, nested group, leaf, and an exists node's own sub-group | `duplicateRuleIntegrity.e2e` — **green**; the source keeps its rows and the copy gets new ones |
| **F6** A SetVisible "hide" (the default-off switch, never toggled) persisted `asx_valuebool` NULL and the applier skipped it — the editor could not express "hide a field" at all. Show/required worked, because turning a switch on IS a toggle | The reducer seeds the boolean for SetVisible/SetRequired at creation and on a type change | `formActionTypesUi.e2e` — **green**; the field is hidden on the live form |
| **F2** The authoring form's RowCount subgrid show/hide was a permanent no-op: `applyMap` gated on `hasAttribute` and a subgrid has a control but no attribute. `mockXrm` keyed both off one dictionary, so L1 could not express the bug | Gate control visibility on `controlExists`; `mockXrm` models attribute-less controls | L1 red-before / green-after (no browser spec for the authoring web resource yet — see below) |
| **F3** `TableConfigApp.onReload` had no `catch`: a failed reload was an unhandled rejection with no banner and stale state — the reload-error fix never reached the table-config editor | Mirror `RuleEditorApp.onReload` | Covered by the same `page.route` mechanism as `serverFailureBanners.e2e`; browser case not yet written |

**F4 — closed.** The rule editor now has an **Unpublish** action beside Publish, enabled only for a Published rule and guarded by a confirm dialog that names the consequence; `webapi.ts` gained `unpublishRule`. Publish deliberately REMAINS available while Published, because re-publishing an edited rule is a real flow (`authorToEnforce.e2e`). The "unpublish releases enforcement" manual check is now performable inside the Rule Builder. Pinned by `unpublishUi.e2e` (skipped until the affordance deploys). The enforcement half of the contract was already proven by `ruleLifecycleUnpublish.e2e`.

Also still open (found by the same pass, not yet fixed): `ruleDeleteOps` emits no node-filter deletes (`save/operations.ts`), so deleting a rule through the UI likely orphans its filter rows; and every child update op ships `etag: null` (`save/diff.ts`), so concurrent edits to conditions/actions/nodes last-write-wins while `authorRuleUi`'s 412 test makes the save look protected.

Defects found by the earlier e2e expansion. All three are **fixed and live-proven** against
DEV after the deploy that carries the fixes (editor bundle first, then the plugin assembly);
the browser pins that were skipped pending that deploy are now un-skipped and green.

| Defect | Fix | Live proof (post-deploy) |
|---|---|---|
| A blank auto-seeded node-filter criterion persisted, passed Validate, then made every write to the table throw `400 0x80040265 "Node filter criterion has no operator configured."` | editor drops incomplete leaves (`isLeafComplete`); Core `StructuralChecks` flags a comparison criterion with no column/operator | `nodeFilterUi.e2e` — "an untouched seeded filter row is not persisted as a blank criterion" **green**. Core half proven separately against the deployed plugin: a hand-authored blank criterion now returns `isValid=false, STRUCT_MISSING_FIELD ×2` (column + operator) where it previously returned `isValid=true` |
| Row-count "Between N and M" collapsed to "Exactly N" while the Minimum was typed up to the Maximum, discarding the in-progress range | `CountModeFields` holds the chosen mode; `canExpress()` breaks the exactly/between overlap | `conditionTypesUi.e2e` — "'Between N and M' keeps both inputs while the minimum is typed up to the maximum" **green** |
| Fluent `<Field>` publishes its generated control id on a React *context* that every field-aware control adopts — portals included — so `label[for]` bound the wrong control: the record picker's "Advanced filter" checkbox announced as "Value" (WCAG 4.1.2), and two comboboxes shared one id | `<OutsideField>` barrier (`src/editor/ui/fieldScope.tsx`) at each dialog root and around each composite's secondary controls | `editorA11yIds.e2e` — "editor control ids are unique and labels bind to their own control" **green**, asserting BOTH zero duplicate ids across the whole editor frame and the checkbox's own accessible name |

## Run hygiene: the local e2e suite and the L2 pipeline SHARE the DEV org

**Never run `npm run test:e2e` while the L2 pipeline (`client-live.yml`) is running, and vice
versa.** Both author, publish and delete `ZZ_RB_` fixtures against the same org, and both call
`sweepRuleBehaviorOrphans()` — which deletes every `ZZ_RB_` row it finds, including the *other*
run's live fixtures.

Measured once: a merge to main auto-queued L2 (19:21:55–19:30:58Z). A local
`npm run test:e2e` was running 19:20–19:33Z. Both went red:

- **The L2 run: 29 failed / 81 passed**, 5 files. Causes: 71 × `0x80040217 "Entity
  'asx_tableconfig' … Does Not Exist"` (the other run's sweep deleted a fixture between its
  create and its use) and 5 × `0x80048105 "More than one concurrent Delete requests detected"`.
  No engine defect: zero validation-code failures, and the deployed change under test
  (`STRUCT_MISSING_FIELD`) never appears in the log.
- **The e2e run: 6 spurious failures**, including specs that were green minutes earlier. This was
  originally written up as "the run straddled the plugin deploy" — that was wrong. The deploys
  had finished; the collision with L2 is the real cause, and the timings above are the evidence.

Re-run either suite alone and both are green: **L2 — 110/110 tests, 21/21 files**
and e2e 64/64. The red run was commit `2337e68` and the green re-run `8d90a0a`; the two
differ ONLY in e2e specs and this file — no production code and nothing the L2 suite loads — so
the engine and bundle under test were identical across the red and the green. That is the proof
the 29 failures were concurrency and not the deployed change. Before starting a live run, check
`az pipelines runs list --status inProgress` — a merge to main queues L2 automatically, so the
window opens without anyone asking for it.

### A second way to break L2: start it mid-deploy

Same lesson, different mechanism — worth recording because the red lands on the commit that
shipped a Core validation change, so the obvious suspect is the wrong one.

**An L2 run on `c9c1bc0` failed: 1 file, `pushdownParity`.** It was queued manually at
**05:49:57Z**, while the deploys for that very commit were still running — Client CI finished
**05:50:05Z** and Plugin CI **05:52:22Z**. The run therefore straddled the plugin-assembly swap,
which is exactly when a publish (step registration) can 400. The failures read as
`publishRule failed (400)` and then, on the retry, `0x80040217 "Entity 'asx_tableconfig' … Does
Not Exist"` — the second being a knock-on of the first attempt's cleanup, not a second cause.

It was **not** the deployed change. `c9c1bc0` shipped `STRUCT_NODE_NOT_IN_TREE` + the empty-binding
check, so the natural suspicion is that L2's fixtures now fail validation. They do not:
`pushdownParity` authors its conditions with `nodeId: tc.line`, `authorRule` validates before it
publishes (`requireValid` defaults true), and validation PASSED — the failure came afterwards, at
the publish step. **Re-queued on `ccd0fa5`, L2 is green.**

So the pre-flight check before a live run is two questions, not one: is anything else running,
**and has the deploy for this commit finished?** `az pipelines runs list --top 40` and confirm the
Client CI *and* Plugin CI runs for the commit under test show `succeeded` before queueing L2 or
starting e2e. Note the run list lags by a minute or two — a run you cannot see yet may still be
in flight, so absence of evidence is not evidence of absence.

> The Core-half proof used a hand-authored fixture. Note for anyone repeating it: a node-filter
> group must bind BOTH `asx_RuleCondition` and `asx_conditiongroup` (see `save/diff.ts`) — binding
> only the condition makes the server-side validation loader skip the filter tree entirely, which
> reads as "the fix isn't live" when it is. A control case (a filter column that does not exist ->
> `META_FILTER_COLUMN_NOT_FOUND`) is what surfaced that.

The hub's `nextLink` handling is unit-pinned in `test/editor/hubData.test.ts`: multi-page
follow to exhaustion, the 50-page ceiling flagging `truncated` instead of looping, and
`loadHubData` surfacing truncation from any of its three queries. The hub-paging entry this
resolved has since been removed from the Beta Limitations page.

## Pushdown — parity + re-proof

- **Fixture-truth parity** — `pushdownParity` (test-dev): 15 boundary-pinned cases (money
  precision, string case/accent collation, widened numeric `ne` over null, datetime
  seconds/range, pushed+residual seam, collation refusals falling back in-memory) proving exact
  match counts through the pushed engine. Green live against the deployed
  collation-sound build, locally and in the release L2 pipeline run.
- **The harness's catches (both fixed pre-deploy):** top-K probe truncation before in-memory
  refinement (unsound under relaxed predicates — removed) and string-literal `ne`/range
  pushdown narrowing under accent-insensitive collation (refused; numeric/date literals still
  push). Root cause proven by direct FetchXML experiment, not inference.
- **Re-proof stamp:** full L2 suite green on the deploying commit (release pipeline run)
  — all rule-behavior families re-proven post-pushdown.
- **Volume proof** — `pushdownVolume` (test-dev) against the permanent `ZZ_VOL_` fixture
  (~26,020 lines under one order — deliberately ABOVE the 25k cap; seeded once by
  `scripts/seed-volume-fixture.mjs`, prefix outside every sweep). Green live:
  selective filter = 20 exact matches from 26k (pushdown provably fired — an unpushed fetch
  would trip the cap); paged variant = 6,000 exact across >1 fetch page; unfiltered rule trips
  the cap with the documented named error (fail, never truncate). **Verification bar:
  complete.**

## Tier C — fresh-org proof of the release artifact

| Release | Org | Result | Evidence |
|---|---|---|---|
| 1.0.0-beta.1 (release zip, sha `b51ee111…`) | a fresh trial org — French (1036), CSP on | **all scripted steps PASS**: import 1.0.0.1 → roles → import assertions → fixtures → action families (Write 6/6, IsNull, ShowMessage) → block → report-only → escalation 4/4 → cap trip 3/3 → unpublish → uninstall leg (dependency-blocked → RemoveAll → delete → clean in 16 s). The operator drill and the manual protocol are pending the maintainer's sitting | Tier-C evidence record |

## Lifecycle — asx_SyncSteps

| Mode | Documented outcome | Proving test |
|---|---|---|
| Sync (default) | recreates drifted steps, sweeps orphans, repairs filtering; deactivated steps reported, never re-enabled | `syncSteps` (test-dev) — real drift via out-of-band step delete → Sync → step back → blocked save proves enforcement |
| RemoveAll | deletes every engine-owned step (pre-uninstall teardown) | `syncSteps` (test-dev) — RemoveAll → zero engine steps → violating create succeeds → Sync → blocked again. The Tier-C uninstall leg proves the actual solution-delete sequence |
| Privilege gate | non-holder of `prvWriteSdkMessageProcessingStep` denied before any work | `syncSteps` (test-dev) — live-proven: the Author-only SP gets **403 from the platform layer** (`executeprivilegename`) before the plugin runs, steps untouched; the in-code fail-closed 400 backstop is unit-pinned (`SyncStepsApiTests`) |

## Open cells (deferred, not silently dropped)

- ~~SEC publish gate live proof~~ — **RESOLVED: `escalationGuard` (test-dev) green
  vs DEV post-deploy, all four legs** — (a) Author-only SP blocked with the Global-privilege
  message; (b) full-privilege principal publishes the same shape; (c) User-context rule
  publishes for the Author SP; (d) `SEC_SYSWRITE_REQ` surfaces to a privileged caller as a
  non-blocking warning. Run: 4 passed, 31.2s (post-deploy of the Create-mask fix). The suite's
  first two live runs each caught a real engine bug the 848-test unit suite could not see:
  (1) `privilegeobjecttypecodes.objecttypecode` is an **Int32 object type code** live — the
  string-name join threw server-side and the gate fail-closed against every publisher, admins
  included; (2) `privilege.accessright` uses the privilege table's **own bit values (Create=32)**,
  not the SDK `AccessRights` enum (32768) — the two enums agree on every bit except Create,
  which is why only Create-right gating was broken. Both regressions now fail in units
  (`PublisherPrivilegeProviderTests` seeds the live-observed shapes verbatim).

- **Portal firing** — untestable via the Web API (`IsPortalsClientCall` can't be set); the portal
  branch of `OriginResolver` is unit-tested; Portal-only *exclusion* is proven live (pass C).
- ~~Create-time RowCount on a structurally-empty child collection~~ — **RESOLVED
  (panel-decided):** literal evaluation, no special-casing — at Create the collection is
  empty, so min-rows + Block(OnNoMatch) + OnCreate blocks the create. Documented in
  `05-building-conditions.md` (Row Count), flagged at authoring time by the
  `STRUCT_ROWCOUNT_ON_CREATE` validator warning, and live-pinned in `ruleBehaviorBlock` (the
  case: blocked with OnCreate, allowed without).

## Engine bugs the program found (all fixed)

The E2E program found **five** real engine defects the unit suites missed (each because units seed
state the live platform never produces); a sixth was reported from use and proven the same way:

1. **Publish never registered enforcement steps** — pre-op registration re-queried `Published` and
   couldn't see its own in-flight publish. Fixed (a registration overlay); **deployed + live**.
2. **Condition value-source `{node}` refs not seeded** — Template/DateExpression node references lived
   only in the value string, never loaded. Fixed `aab6434`; **deployed + live**.
3. **Validator didn't seed node-filter/EXISTS collection nodes** — valid EXISTS rules rejected with a
   false `TRAV_NODE_NOT_FOUND`. Fixed `95c2684`; **deployed + live**.
4. **IsNull could never fire** — live Dataverse omits a null column from the Entity, and the
   absent-column guard shortcut IsNull to false. Fixed `9f57f7b`; **deployed + live** (un-skipped
   `ruleBehaviorMatrix` IsNull case green against DEV).
5. **Traversals read the trigger table as of before the save** — enforcement is pre-operation, so a
   rule whose traversal re-reads its own root table (sum over an order's lines, triggered by
   editing one of those lines) fetched the stale persisted row: an update's new value was ignored,
   a record being created was missing, a record being deleted still counted. Fixed
   (`InFlightReconciler`); **deployed + live**. The four cases are authored so a stale
   engine and a correct engine give opposite verdicts, and both directions were observed against
   DEV. **Pre-deploy: all four failed**, each in the predicted direction — the
   over-limit update was allowed (stale sum 30, real 520); the under-limit update was blocked
   (stale sum 150, real 60 — the reported symptom); the create was never blocked (new line
   invisible); the delete was never blocked (doomed line still counted). **Post-deploy:
   all four green**, `ruleBehaviorInFlight` 4/4 in 51.9s.
6. **Two configuration trees on one table fought** — the runner loads every evaluated rule's nodes
   into one dictionary, and `QueryExecutor` seeded the triggering record into only the FIRST Root
   Table node; the other tree's child collections fetched nothing, so its RowCount/EXISTS/filtered
   conditions read empty and blocked valid saves (or passed violating ones), the loser varying with
   dictionary order. Surfaced as failures that MOVED between the aggregate and
   traversal suites run to run once the sample app's "Orders" tree was published on DEV next to
   `ZZ_RB_TC_`; misread as flakes for a day until `asx_RunRules` diagnostics showed both lines
   visible while the filtered count read 0. Fixed (seed every root; `RootColumnCollector` treats
   all roots as root); **deployed + live**: `ruleBehaviorMultiTree` authors two trees on
   `sample_order` with a RowCount rule each — an order with one line allowed by both, a lineless
   order blocked with both messages — **green vs DEV post-deploy (1/1, 8.2s)**; the
   full L2 (110/110) green on the deployed fix. Harness companion: blocked/allowed
   update assertions now settle on the engine's own verdict and report per-node rows on failure.
