# Changelog

Notable changes to the Ascentix Rules Engine.

Beta releases ship as solution version `0.0.0.N`. Dataverse solution versions are numeric
only, so the version an administrator sees in their org can never carry the word "beta".
`1.0.0.0` is reserved for the first full release.

## Unreleased

### Added

- **Data updates.** A release that needs existing rules converted now ships a numbered data
  update. The Rule Builder shows a banner while one is pending; a System Administrator or System
  Customizer applies it with **Apply now** (others see the Rule Builder read-only, and publishing
  is refused until it has run). Progress and failed items are recorded in the new **Data Update**
  table (`asx_dataupdate`) and reported by the new `asx_ApplyDataUpdates` Custom API. This release
  carries no data updates. See *Administering → Data Updates*.
- **On demand runs.** An On demand rule can now be run outside the editor: **Run now** (in the
  hub and the Rule Builder) evaluates and enforces it against the records you choose (up to
  250), or against every record that passes its execution conditions, depending on the rule's
  new **Runs for** setting (`asx_rule.asx_ondemandscope`). Each run is tracked as a **Rule Run**
  (new table `asx_rulerun`) and driven page by page via the new `asx_ProcessRunPage` Custom API,
  with a **Runs** dialog to see a rule's runs, cancel one that hasn't finished, and resume one
  an abandoned browser tab left behind. A single record can also be run directly through the
  new `asx_ApplyRules` Custom API. Running rules needs its own privileges on the Rule Run table.
  See *Administering → Running Rules On Demand*.
- **Relative dates in filters.** Collection filters, "has related rows" sub-filters and
  aggregate filters accept a date expression ("now minus 12 months", or a date on the row plus
  N days). Filters anchored on "now" are still applied in the Dataverse query.
- **Filtered totals in Calculation conditions.** A Calculation condition's aggregates can each
  carry a filter, as field-mapping calculations already could. New column
  `asx_rulecondition.asx_expressionfilters`.
- **Anchored date filters run in the query.** A date comparison (equals, not equals, and the
  before/after operators) in a collection filter whose date expression is based on a date of
  the rule's own record or of a record it looks up is now applied in the Dataverse query, so it
  no longer raises `TRAV_PUSHDOWN`. This applies when that record is outside the filtered
  collection's own branch.
- **Time zone for dates.** A rule can name the time zone its date comparisons use (rule
  properties → Time zone for dates; new column `asx_rule.asx_evaluationtimezone`). It decides
  which day and which clock time "now" is for Date Only and Time Zone Independent columns, and
  how a date without a time zone is read against a User Local column: `createdon` on or after
  `2026-09-01` means midnight in the rule's zone, and so does a Date Only or Time Zone
  Independent date used as a date expression's anchor. Default: UTC. An unknown zone is rejected
  at publish (`STRUCT_INVALID_TIMEZONE`).
- **Also apply to the previous record.** When a save changes a lookup on the record (an opportunity
  moves to another contact), an Update Record action can also be applied to the record the lookup
  pointed to before, in the same save. New column `asx_ruleaction.asx_applytoprevious`. An action
  whose target this option can't apply to is rejected at publish (`STRUCT_APPLY_PREVIOUS_TARGET`).
- **Rule schedules.** A Published On demand rule scoped to all records can run on a recurring
  schedule (every 15/30/45 minutes, every 1–23 hours, daily, weekly, or monthly, in the rule's own
  time zone) instead of only on demand: the Rule Builder's new **Schedule** section starts or
  continues a Rule Run the same way **Run now** does, within about 15 minutes of the scheduled
  time. New table `asx_ruleschedule` (at most one per rule) and a new unbound Custom API,
  `asx_StartDueSchedules`, that a caller on a timer drives — the optional **scheduler add-on**
  (a separate solution, `AscentixRulesEngineScheduler`, shipping one cloud flow) calls it every 15
  minutes and drives every returned run with `asx_ProcessRunPage`. A new table,
  `asx_schedulerstatus`, tracks a heartbeat for whatever calls `asx_StartDueSchedules`, shown as a
  status chip in the hub alongside a clock icon on scheduled rules. See *Administering →
  Scheduling Rules*.
- **Actions on a set of records.** Update, Delete and the new **Deactivate Record** action can
  target a related collection and write every row that passes the action's **Rows** filter;
  Create Record can create one record **for each row** of a collection, with values from the
  **Current row** (`row` source, `{row.<column>}` tokens). One record's writes are merged, rows
  that already hold the values are skipped, and the rest are sent in bulk (creates, then updates,
  then deletes). New column `asx_nodefiltergroup.asx_ruleaction`, action type 8, and the
  `asx_RunRules` output `ChangeSet`. The Rule Builder's new **Test** runs a published rule
  against a record without saving. Writes now go out in that order rather than one at a time in
  action order; only other plug-ins reacting to each write can observe the difference.

### Changed

- The **Manual** trigger is now labelled **On demand**. The stored choice value (3) is unchanged,
  and the API trigger name `Manual` is still accepted alongside the new `OnDemand`.
- Every rule evaluated by one save uses the same "now".
- `STRUCT_EXPR_FILTER_UNSUPPORTED` is replaced by `STRUCT_EXPR_FILTER_MISSING` (a filter key
  used in the expression but not defined).
- On Create, a date expression based on `createdon` or `modifiedon` of the record being
  created uses the time of the save.
- A filter date expression based on a related record that is missing or has no date matches no
  rows instead of failing the save.
- Date comparisons follow the column's behavior: Date Only columns compare calendar dates
  (so "on or after yesterday" includes all of yesterday), Time Zone Independent columns compare
  clock times, User Local columns compare exact moments. Existing rules that compare a Date
  Only column with a date that has a time of day can change result.
- Collection filters on date columns are sent to Dataverse exactly, in the rule's time zone,
  instead of widened by a day, for every comparison operator (equals and not equals included),
  whether the value is a literal date, "now" or a date expression. A Date Only comparison is
  sent as a whole-day range, so it also holds for a stored value that carries a time of day. A
  Row Count condition's own search criteria compare dates as text and keep the widened form:
  before/after comparisons are applied in the query, equals and not equals after the rows are
  loaded.
- Writes of the same table in one evaluation are sent in bulk. An existing rule whose fired
  actions create, or update, two or more records of the same table in one save (two Create
  Record actions on task, or updates of two different contacts through two lookups) now sends
  them as one `CreateMultiple` / `UpdateMultiple` where the table supports it, instead of one
  request each; deletes are still sent one at a time. A plug-in registered on the bulk message
  sees one execution for them. A failed bulk request names the operation and the table rather
  than the action, for example `UpdateMultiple contact: <error>`; a single request reads
  `Update contact (action "<action name>"): <error>`.
- A Create Record action that already holds a collection target (`asx_targetnode` pointing at a
  child-collection node, which only the API could set; the Rule Builder never did) becomes a
  **Create per row** on upgrade: it creates one record for each row of that collection instead
  of one record. A target on a single-record node (the record itself or a lookup) is still
  ignored by Create Record. Before upgrading, look for `asx_ruleaction` rows with
  `asx_actiontype` 5 and an `asx_targetnode`, and clear the target on any that should keep
  creating one record.

### Fixed

- A literal date filter without a time zone (e.g. `2026-09-01`) could drop rows for users
  outside UTC; it now matches the same rows for every user.
- A record moved to another parent in the same save is no longer counted in its previous
  parent's related rows.

## 0.0.0.1 (2026-08-28)

The first public release. Everything below describes the product as it stands at that release
rather than what changed to get there.

### Added

- **Rules as configuration.** A rule is scoped to a table, declares a tree of conditions (WHEN)
  and a set of actions (THEN), and is authored in the Rule Builder rather than in code. Rules are
  Draft until published, and only published rules are enforced.
- **Server-side enforcement.** Rules run in a Dataverse plug-in, so they apply to form saves, the
  Web API, integrations and bulk imports alike. Unpublishing takes effect in the same transaction,
  which is the supported emergency stop.
- **Traversal through a Table Config tree.** Conditions and action targets can reach lookup
  records and child collections, not just the triggering record. A tree is defined once and shared
  across rules.
- **Condition types:** Field Comparison, Row Count (minimum and maximum over a child collection),
  Regex Match, and Calculation (aggregates over a child collection plus arithmetic). Conditions
  nest in ALL·AND and ANY·OR groups to any depth.
- **Action types:** Set Visible, Set Required, Show Message, Block, Create Record, Update Record
  and Delete Record. Each fires On Match or On No Match and carries its own severity. On the
  server, severity is a message level rather than a block switch: what blocks is the Block
  action.
- **Dynamic message text.** Block and Show Message support `{root.column}` and
  `{node:<node>.<column>}` tokens, with per-language translations.
- **Form behaviour without JavaScript.** The client form library drives field visibility, required
  state and messages on a form. It is added as a form library with one `OnLoad` handler; the
  server plug-in remains the authoritative enforcer for anything that does not go through a form.
- **Four Custom APIs.** `asx_RunRules` reports what a rule would do for a record, saved or unsaved,
  without writing anything, optionally with per-stage diagnostics. `asx_ReadRules` returns rule
  definitions to the client library. `asx_ValidateRule` reports whether a rule is publishable.
  `asx_SyncSteps` reconciles or removes the generated enforcement steps.
- **Two security roles** shipped with the solution, one for authoring and one for read access.
- **Privilege gate on System-context write rules.** Publishing a rule that writes as the system
  user requires the publishing user to hold the matching privilege at organization depth on every
  write target, so a rule never lets its publisher exceed what they could do directly.
- **A traversal row cap.** Traversal fails rather than silently truncating when a node exceeds the
  documented row limit.
- **No telemetry.** Nothing in the product phones home, and the Rule Builder loads no scripts,
  styles or fonts from outside the environment.

### Known limitations

The beta is intended for non-production environments. The supported envelope is roughly 100
published rules per environment and 5,000 traversed related rows per save. Rules re-evaluate on
root-table writes only. There is no supported rule transport between environments, and browser
support is verified on Chromium-class browsers only.

The complete list is in
[Beta Limitations](https://ascentix.ca/power-platform/rules-engine/beta-limitations),
which is maintained as the authoritative disclosure rather than summarised here.
