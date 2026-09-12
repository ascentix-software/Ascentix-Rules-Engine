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

Configuration mutations, opening a draft, validation, publication, and restore
acquire the same database-row lock. The lock record is created automatically on
first use. Opening a draft is idempotent under this lock. Owned graph edits advance
the draft ETag. Publication checks the optional validation hash, reruns validation
and publisher privilege checks, and compares the draft's base publication version.
Restore checks the draft ETag and resets its base to the current publication.

Server-owned writes use Dataverse's documented
[selective step exclusion](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bypass-custom-business-logic#bypassbusinesslogicexecutionstepids).
Each request selects only matching message/table lifecycle steps from this signed
assembly. Customer plugins remain enabled. The actual publication pointer switch
runs registration reconciliation in the same transaction. Direct revision writes,
publication metadata writes, and authored changes to published records are rejected.
The APIs check record access against the original rule before creating or changing
its draft. Server-owned copies retain the original owner.

## Maintainer packaging

`pipelines/Configure-RuleAuthoring.ps1` maintains the additive schema, shipped view
filters, lifecycle ordering, and current authoring API registrations in the source
DEV environment. Plugin CI runs Schema, assembly deployment, then Register. These
are package preparation operations; they do not backfill customer rule records.
The API registrations owned by the authoring handler are reconciled to the current
contract. No historical migration handler is shipped.

The exported managed solution must include the rule/draft fields, private-model
field, revision and coordination tables, all guard steps, Open/Read/Restore APIs,
the Copy API (source Read access and Create-rule privilege),
validation hash output, views, and updated web resources. Do not hand-edit the
unpacked `Solutions/` mirror. The release workflow regenerates it from the export.

Duplicating a published rule copies its active definition and model into a new
unpublished rule owned by the caller. Rule deletion removes its working copy,
owned child rows, and revision history in the server transaction.

## Acceptance

Local unit tests cover stable identity, existing rules without snapshots, repeated
open/restore, draft saves, immutable guards, selective step matching, private-model
cleanup, and shared-model preservation without touching unrelated rules. The
registration test covers fresh API creation and retry after partial registration.

Local tests cannot prove Dataverse nested-request execution, transaction rollback,
registration propagation, or managed import behavior. Before release, run the live
revision suite and browser draft flow against the deployed build, then verify both
a fresh managed install and an upgrade from the previous beta containing published
rules. Neither environment may require initialization commands. Verify old behavior
before and during draft edits, new behavior after publication, and unchanged active
behavior after a rejected publication. Include representative rule/model volume in
latency acceptance; preservation and private-model reclamation traverse configuration.
