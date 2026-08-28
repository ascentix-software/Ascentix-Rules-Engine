# Changelog

Notable changes to the Ascentix Rules Engine.

Beta releases ship as solution version `0.0.0.N`. Dataverse solution versions are numeric
only, so the version an administrator sees in their org can never carry the word "beta".
`1.0.0.0` is reserved for the first full release.

## Unreleased

Nothing yet.

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
