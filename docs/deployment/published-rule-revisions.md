# Published rule revisions: deployment and acceptance

## Behavior and storage

The normalized rule graph remains one mutable draft. Publishing captures its full
configuration in `asx_rulerevision`: rule identity, revision number, serialized
definition, SHA-256, publisher, and publication time. The header keeps
`asx_publishedrevision` and `asx_publishedversion`; status still enables or disables
enforcement. Saving does not allocate revisions. Every successful publication does.

The snapshot includes conditions, filters, actions, mappings, localized messages,
triggers, channels, schedule, evaluation context, and referenced data-model nodes.
Business records, metadata, and user permissions remain live. Removing a business
column can therefore still invalidate execution; this is configuration versioning,
not a copy of the Dataverse schema or data.

Server execution, form definitions, and registration analysis read the same frozen
configuration. Each rule is gathered separately so different versions of the same
original model-node GUID cannot collide. This adds per-rule reads and traversal
work compared with the previous context-wide gathering. Representative volume and
latency checks are required before release. Already-open forms retain their fetched
definitions until reloaded; each new server evaluation selects a published snapshot.

The editor offers an editable draft, a read-only published view, and an explicit
restore confirmation. Restoring replaces saved and unsaved draft changes with a
private clone of the published model and remaps configuration references. Shared
models used by other drafts are not rolled back. Private copies are ordinary
authoring data; restoring repeatedly can leave unused models for administrative
cleanup. Neither restore nor save changes the publication pointer.

## Transaction and authorization contract

Synchronous configuration guards acquire a shared database-row lock before any
draft or shared-model mutation. Validation and publication use the same lock.
The coordination row is upserted by fixed ID and is created automatically if absent
after a managed import. A failed first-use race aborts the request; it must be retried.

Owned child edits update `asx_draftstamp`, advancing the rule's ETag. The editor's
publication PATCH supplies its original `If-Match` and the `DraftHash` returned by
validation. Shared-model edits invalidate that hash even when the rule ETag is
unchanged. The publisher captures and revalidates the candidate, checks publisher
privileges, creates a revision, and updates the pointer in the same transaction as
enforcement-step reconciliation. Any failure must roll back the complete operation.

Raw callers may publish with a saved-draft status PATCH without a prior hash, but
cannot bypass the server capture, validator, or publisher privilege checks. Create
as Draft first. A publish PATCH cannot include other authored fields; save them in
a separate request. Explicitly setting Published on an already-published rule creates
a new revision. Legacy `SetState` is rejected; use Update.
Global Associate/Disassociate guards also reject changes involving configuration
records. Change configuration lookups through Update so the same guards apply;
unrelated business-record relationships are unaffected.

Revision Create/Update/Delete and publication-pointer/version/stamp writes are
guarded. Only nested operations from the server's publication transaction may
write them. Internal SDK requests carry a tag bound to the originating transaction,
registered handler, operation, and target identity, covering platforms that omit
mutable parent shared variables. A tag without valid registered ancestry grants
no authority. Deleting a rule removes its revisions in that transaction. The new
read API checks rule Read access; restore also checks rule Write access and the
expected version. Authors need no direct CRUD rights on revision or lock tables.

The transaction approach uses Dataverse's documented
[pre-operation transaction](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework)
and [database-lock lifetime](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/scalable-customization-design/database-transactions).
FakeXrmEasy tests do not establish real locking or rollback semantics.

## DEV deployment order

Run the existing plugin CI with DEV deployment enabled. It now performs:

1. `pipelines/Deploy-RuleRevisions.ps1 -Phase Schema`: add the two tables and rule
   columns to `AscentixRulesEngine`, publish schema, and seed the coordination row.
2. Existing `Deploy-PluginAssembly.ps1`: update the signed assembly and plugin types.
3. `Deploy-RuleRevisions.ps1 -Phase Register`: add guards and APIs; order the guard,
   publisher, and registration steps at 1, 20, and 30 respectively.
4. `Deploy-RuleRevisions.ps1 -Phase Backfill`: initialize published rules in batches
   of ten until `Remaining` is zero.
5. Deploy the client web resources, then run live L2 and browser E2E sequentially.

Each script phase requires the existing `EnvUrl` and `AccessToken` parameters. The
CI masks its token. Keep authoring and configuration integrations paused during
the assembly/registration changeover; runtime enforcement can continue. Enable all
required guards before reopening authoring. Do not run the independent client
deployment ahead of the backend when promoting this change for the first time.

If registration fails with `Attribute 'description' cannot be NULL`, use the
updated deployment script that supplies descriptions for the Custom APIs and
their request parameters and response properties. Rerun plugin CI from the repaired
commit; completed schema and registration components are reused. No deletion of
partially registered components is required. Keep authoring paused until registration
and backfill complete, then deploy the client and run the live suites.

Backfill is restartable: only Published rules with no pointer are captured. Until
conversion, those legacy rules retain their existing runtime read path. Once guards
are installed, a configuration mutation first captures outstanding legacy rules;
if more than twenty remain, it rejects the edit and asks for the deployment
backfill. It never asks the author to unpublish. A corrupt referenced revision
fails closed and never falls back to draft children. Investigate a failed backfill
and rerun it; do not clear pointers or disable guards to continue.

## Managed packaging and rollback

These local changes do not update `Solutions/` or an existing downloadable release.
After DEV acceptance, use the established export/package workflow to include the
additive metadata, new plugin types, guards, and APIs. The coordination row is data
and does not travel with the solution; automatic initialization covers fresh imports.
For upgrades with existing published rules, an administrator must run
`asx_InitializeRuleRevisions` repeatedly until `Remaining` is zero before authoring.

Do not downgrade to an assembly that reads mutable draft configuration after authors
have started using revisions. It would enforce saved drafts. Prefer a forward fix
that preserves the snapshot read path. Taking an environment backup before upgrade
and restoring it as a whole is a separate operational recovery decision.

## Verification

`pwsh -NoProfile -File tests/pipelines/Test-RuleRevisionRegistration.ps1` runs the
Register phase against an in-memory Web API. It checks required descriptions and
length limits, API parameter contracts, and retries after partial and completed
registration. Plugin CI runs it before deployment; it does not replace live verification.

Local coverage includes snapshot round-trips, draft/runtime and form isolation,
different frozen link fields sharing a node GUID, unchanged step analysis, stale
publication rejection, raw-write guards, bounded/restartable backfill, restore access
and version checks, and private restoration preserving literal values.
Client coverage includes editing while published, publication, viewing a frozen
definition without losing unsaved work, and restoring after confirmation.

`client/test-dev/ruleRevisions.dev.test.ts` exercises invalid and stale publication
against actual server evaluation. `client/e2e/authorPublish.e2e.spec.ts` exercises
publish → save draft while live → view published → republish through the editor.
Both require the complete DEV deployment and have not been run for this change.

Before release, also verify concurrent author/shared-model writes, simultaneous
publication, raw/bulk configuration mutations, rollback after failed registration,
partial-conversion restart, two-rule shared-model behavior, and representative
runtime/authoring latency in Dataverse. Local test success is not that acceptance.
