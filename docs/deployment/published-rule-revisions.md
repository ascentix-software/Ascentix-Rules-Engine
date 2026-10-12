# Published rules and working drafts

## Customer upgrade and editing contract

Import the managed solution and continue using existing rules. There is no data
initialization API, customer migration command, or customer pipeline step.
Existing published normalized graphs remain supported runtime definitions.

The Rule Builder creates or reopens one separate working draft when **Edit rule**
is selected. The public rule ID and its published graph remain unchanged. Drafts
and their private data-model copies are excluded from the hub and shipped views.
Saving or restoring a draft does not stop enforcement. Publishing validates the
saved draft, captures its complete definition, and switches the original rule's
active revision atomically. The working draft remains available for further edits.
Unpublishing stops enforcement but keeps that working draft. A previously published
rule whose draft was deleted reopens from its latest revision. Publishing the old
original record directly is rejected; the Rule Builder publishes its working draft.

Snapshots contain rule configuration, referenced models, filters, mappings, and
translations. Business records, Dataverse metadata, and caller permissions remain
live. A business-column deletion can still invalidate a rule; this feature does
not version the environment's schema.

## Shared configuration

Before a shared model changes, the configuration guard preserves the definitions
of affected published rules that do not yet have snapshots. It discovers references
from raw authored graphs before loading model trees, so an unrelated invalid rule
does not prevent the edit. Preservation leaves publication status and version
unchanged. The first explicit publication advances version zero to one.

A working draft starts with a private copy of the active published model. Authors
can edit that copy or select a shared model in the draft. Shared-model changes
become live only when a rule using that model is explicitly republished. Restoring
replaces the draft with the active definition; unused private copies are reclaimed,
while models referenced elsewhere are retained.

## Transactions and authorization

Dataverse security roles control authoring privileges. Publication validates the
latest saved definition, then switches the active revision in the same transaction.
Opening reuses an existing working draft. Restore replaces its contents with the
current published definition. Saves, publication, and restore do not compare client
versions or acquire a separate coordination lock.

Server-owned writes use Dataverse's documented
[selective step exclusion](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bypass-custom-business-logic#bypassbusinesslogicexecutionstepids).
Each request selects only matching message/table lifecycle steps from this signed
assembly. Customer plugins remain enabled. The actual publication pointer switch
runs registration reconciliation in the same transaction. Authored changes to
published records use the working-draft workflow. Revision and publication metadata
writes use platform permissions. The APIs require the corresponding platform rule
privilege without additional record-access checks. Server-owned working copies
retain the original owner.

## Maintainer packaging

`pipelines/Configure-RuleAuthoring.ps1` maintains the additive schema, shipped view
filters, lifecycle ordering, and current authoring API registrations in the source
DEV environment. Plugin CI runs Schema, assembly deployment, then Register. These
are package preparation operations; they do not backfill customer rule records.
The API registrations owned by the authoring handler are reconciled to the current
contract. No historical migration handler is shipped.

The exported managed solution must include the rule/draft fields, private-model
field, revision and coordination tables, all guard steps, Open/Read/Restore APIs,
the Copy API (Create-rule privilege), the Delete API,
validation hash output, views, and updated web resources. Do not hand-edit the
unpacked `Solutions/` mirror. The release workflow regenerates it from the export.

Duplicating a published rule copies its active definition and model into a new
unpublished rule owned by the caller. Rule deletion removes its working copy,
owned child rows, and revision history in the server transaction.

Rule Builder deletion calls `asx_DeleteRule` with a string `RuleId`. This synchronous
Custom API requires the platform rule Delete privilege and removes the working copy, owned children, revision history, and
unused private models before issuing the final rule Delete. Shared models remain.
Deleting a working draft alone preserves its published original. An already absent
rule is a successful no-op. Any failure rolls back the transaction.

Native `DELETE asx_rules(id)` is also supported, including the standard Dataverse
Rules grid. PreValidation captures ownership without writing anything. PreOperation
removes owned children and the working copy. PostOperation removes revision
history and unused private models after the header is gone. All writes occur in the
native Delete transaction. Platform unlink updates for captured rows are treated as part of deletion; unrelated rules and shared models keep
their normal guards.

Schema changes the draft, revision-owner, and published-revision relationships from
Restrict to RemoveLink. Register installs all three synchronous rule Delete stages
(10, 20, 40). Deploy Schema, the assembly, Register, and the Rule Builder bundle
together. Deletion is available directly from both lists without opening a rule.

L2 checks native and API deletion of model-linked drafts and published rules with
working copies, incomplete nested filters, empty drafts, shared-model retention,
and rollback when a later operation in the same changeset fails.

## Direct DEV iteration

A pipeline run is not required for the development loop. Use the existing deployment
scripts locally against the configured DEV environment, with a token obtained through
`devOrg("sp")` and held only in process memory:

1. Rebuild the plugin in Release with `-t:Rebuild /p:SigningKeyFile=<release-key-path>`. Confirm
   the assembly public-key token matches the registered release identity
   `67f2dcfd2e8488af`; the development key cannot replace that assembly.
2. Run `Configure-RuleAuthoring.ps1 -Phase Schema`, `Deploy-PluginAssembly.ps1`, then
   `Configure-RuleAuthoring.ps1 -Phase Register`.
3. Build the client and use `Deploy-WebResources.ps1` to publish the changed resources.
   For a deletion-only update, a temporary manifest can select just the Rule Builder
   bundle. Reload the browser to pick up the published resource.
4. Inject `DATAVERSE_TOKEN` into the local runner, run `seed-dev-fixtures.mjs`, then
   `vitest run --config vitest.config.dev.ts test-dev/ruleRevisions.dev.test.ts --retry=0`
   from `client`. Run broader L2 and browser suites sequentially; they share fixtures.

Keep assembly, registration, client, and test changes together in the PR. Direct DEV
validation does not replace managed-install or managed-upgrade acceptance.

## Acceptance

Local unit tests cover stable identity, existing rules without snapshots, repeated
open/restore, draft saves, workflow validation, selective step matching, private-model
cleanup, and shared-model preservation without touching unrelated rules. The
registration test covers fresh API creation and retry after partial registration.
L2 runs the lifecycle contract first in the full suite; CI stops after a failure
instead of repeating setup against a broken deployment. No test is excluded.

Local tests cannot prove Dataverse nested-request execution, transaction rollback,
registration propagation, or managed import behavior. Before release, run the live
revision suite and browser draft flow against the deployed build, then verify both
a fresh managed install and an upgrade from the previous beta containing published
rules. Neither environment may require initialization commands. Verify old behavior
before and during draft edits, new behavior after publication, and unchanged active
behavior after a rejected publication. Include representative rule/model volume in
latency acceptance; preservation and private-model reclamation traverse configuration.

## Trusted-author policy

Authoring uses platform role privileges. The publisher-relative System-write gate,
extra handler access checks, revision/metadata vetoes, and stale-version/hash checks
have been removed. Register removes obsolete revision-table guard steps and requires
rule Write on Open/Restore; Delete still requires rule Delete. Restore accepts only
RuleId; registration removes its obsolete ExpectedVersion parameter. DraftHash and
version columns are not concurrency gates. Editor PATCH requests use `If-Match: *`
to update existing records with last-save-wins behavior, without recreating deleted
records. Working-draft workflow and validation of the latest saved definition remain.

## DEV verification — 2026-09-20

The directly deployed assembly, schema, API registration, and editor passed all
121 L2 tests across 21 suites from the local machine, with retries disabled
(616.93 seconds). The lifecycle suite includes native/API deletion, owned-row
cleanup, shared-model retention, rollback, valid publication, and RuleId-only restore.

Chrome extension checks deleted draft and published rules from the Rule Builder
list and deleted a draft and published rule together from the native Rules grid.
Independent API reads confirmed absence of all four headers and their captured
owned rows, while shared models remained. A browser save after an external edit
also persisted successfully with last-save-wins behavior. All disposable fixtures
were cleaned up. These checks do not establish managed-install/upgrade acceptance
or completion of the entire browser suite.
