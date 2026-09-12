# Edit rules without interrupting enforcement

Status: implemented locally as the replacement for the unpublish-to-edit workflow
in commit `adefe46`. Deployment and DEV acceptance remain pending. See
[deployment and acceptance](../deployment/published-rule-revisions.md) for ordering,
the persisted contract, local evidence, and remaining live checks.

## Required behavior

A rule has a stable identity, an editable draft, and an optional published revision.
Saving or validating the draft never changes enforcement. Publishing validates the
exact candidate and atomically makes it the published revision. Failure leaves the
previous revision active. Unpublish remains an explicit operation to stop a rule,
not a prerequisite for editing it.

The user confirmed that published rules must retain their data-model configuration
until each rule is republished. Publication therefore captures the complete rule
definition, including conditions, nested filters, actions, mappings, translations,
triggers, channels, schedule, evaluation context, and referenced data-model nodes.
Business records and permissions remain live; publication freezes configuration,
not the data being evaluated or the permissions of users executing the rule.

Repeated saves update one draft. They do not create a revision on every save.
Opening a published rule offers editing of its draft and viewing of its published
revision. The UI labels the editable workspace “Rule draft”, shows the published
version beside its status, and marks unsaved changes separately.
Discarding draft changes restores the published definition without interrupting it.

## Implementation boundaries

- `Core/Publication/RuleSnapshot.cs` captures the normalized draft and referenced
  configuration. `SnapshotService` supplies existing loaders from that snapshot.
- `RuleBuckets`, `ReadRulesApi`, and `TableRuleAnalyzer` read frozen configuration
  for runtime evaluation, form definitions, and enforcement registrations.
- `RulePublishPlugin` validates each explicit Published status write, including
  replacing an already-published revision.
- `RuleRevisionGuardPlugin` coordinates configuration mutations and protects
  revision rows and header publication metadata. `RuleRevisionApi` supports
  viewing, restoring, and initializing legacy revisions.

## Storage and publication design

Keep the existing normalized authoring graph as the mutable draft. Introduce an
immutable published-revision record containing a versioned, complete definition,
revision number, publisher, publication time, and definition hash. The stable rule
record references the current published revision and records whether enforcement
is enabled. Treat these as separate concepts from draft edit state.

Published revision writes and pointer changes must be server-controlled, with
guards covering API and classic-form access as well as the Rule Builder. Normal
authors can edit draft configuration; they cannot bypass validation by supplying
a published payload or changing a published revision directly.

Publication must:

1. Check caller authorization, the expected draft version, and expected current
   published revision. Coordinate all rule-child mutations with the draft version.
2. Assemble a consistent candidate, including all referenced shared configuration.
   Detect dependency changes during assembly and reject/retry instead of publishing
   a graph composed from different versions.
3. Validate that exact candidate and rerun publisher privilege checks.
4. Store the immutable revision, update enforcement registrations, and switch the
   published pointer within a transactional boundary. Any failure rolls back the
   switch; it must not require an intervening unpublish.

Use the published revision for server execution, form definitions, scheduling,
trigger/channel filtering, execution-context selection, and registration analysis.
Do not fall back to mutable draft children when a published payload is invalid.

Two rules may refer to the same original data-model node but publish at different
times. Their frozen copies must coexist. Runtime data structures and caches need
revision-scoped identity; a dictionary keyed only by the original node GUID cannot
merge different published configurations safely. Preserve the stable rule identity
for diagnostics and action coordination.

An evaluation already underway may finish on its selected revision. Every new
evaluation selects a complete published revision. Define client refresh behavior
explicitly: already-open forms can retain a previously fetched definition, while
the server remains authoritative for saves.

## Existing rules and deployment

Existing published rules need an initial revision capturing their currently
enforced definitions, including shared dependencies. This must not require users
to unpublish them. Make the conversion restartable and verify each captured graph
before switching the runtime read path. Coordinate concurrent configuration writes
during conversion. Retain the prior enforcement path until conversion is complete;
do not silently disable rules missing a snapshot.

The implementation includes an additive schema/deployment script, plugin
registrations, and client changes. A client-only build is insufficient. The plugin
CI deployment runs Schema → assembly update → Register → Backfill. Deploy the client
after the backend completes. No environment changes were performed during local
implementation, and `Solutions/` has not been exported or regenerated.

## Acceptance evidence required

- Publish v1, save an incompatible draft, and prove both server execution and form
  definitions still use v1.
- Change shared configuration used by two published rules; both retain their
  behavior. Republish only one and prove the other still uses its older copy.
- Change draft triggers, channels, actions, schedule, and execution context without
  altering live behavior or enforcement registrations.
- Reject invalid, unauthorized, stale, and concurrently modified publication
  candidates while keeping the prior revision active.
- Reject direct edits to immutable revision data and publication pointers.
- Verify failed registration reconciliation rolls back publication.
- Verify opening, saving repeatedly, reviewing, discarding, and recovering a draft
  never unpublishes the live revision.
- Convert existing published rules with equivalent results before and after the
  runtime switch; include restart after partial conversion.
- Run client, core, plugin, and registration tests, then DEV integration and E2E
  tests against the complete schema/backend/client deployment.

The message guidance, exact-time scheduling controls, and edit recovery from
`adefe46` remain useful. Replace its published-rule editing restriction and update
its lifecycle tests and documentation as part of this implementation.
