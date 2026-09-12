# Plugin registration (bootstrap)

The engine ships one signed assembly with enforcement, authoring, and Custom API
implementations:

- **`RulesEnginePlugin`**: evaluates and enforces rules. Its steps on **customer tables**
  are generated at runtime by the registration plugin (below), so they are NOT shipped.
- **`RuleRegistrationPlugin`**: keeps those generated steps in sync with rule config.
- **`RulePublishPlugin`**: validates and snapshots every publication, including replacing
  an active revision. See `docs/Schema.md` §5.1.
- **`RuleRevisionGuardPlugin`**: serializes configuration edits, advances draft versions,
  and protects immutable revision data and publication pointers.

## Shipped (bootstrap) steps: register once, ship in the solution

Register `RuleRegistrationPlugin` (pre-operation, synchronous) on:

| Table | Messages | Pre-image ("PreImage") columns |
|---|---|---|
| `asx_rule` | Create, Update, Delete | `asx_tablelogicalname`, `asx_triggers`, `statuscode` |
| `asx_ruleaction` | Create, Update, Delete | `asx_rule`, `asx_actiontype`, `asx_isactive` |

Plus one publish-gate step: `RulePublishPlugin` on `asx_rule` Update, `PreImage` carrying
`statuscode`.

Add the assembly and these seven steps (with the pre-images) to the unmanaged solution.
The revision deployment also adds synchronous pre-operation guards on Create/Update/Delete
for all ten configuration tables and `asx_rulerevision`, plus `asx_rule` SetState.
Global Associate/Disassociate guards reject configuration relationship changes
through those messages; use record Update so lifecycle/version checks run.
Execution order is guard 1 → publisher 20 → registration 30. No filtering attributes
on these steps. Add all guards and the three revision APIs to the managed package.

`pipelines/Deploy-RuleRevisions.ps1` provisions additive metadata and registrations;
`pipelines/plugin-ci.yml` orders Schema, assembly deployment, Register, and Backfill.
See [revision deployment](deployment/published-rule-revisions.md) before deploying
the client or packaging a managed release. Existing published rules stay enabled.

## Generated steps

`RuleRegistrationPlugin` creates/updates/deletes `RulesEnginePlugin` steps on customer tables,
named `Ascentix.RulesEngine: {table} {message}`, in the **default solution**, where the Plug-in
Registration Tool shows them. Removing the engine = delete these.

## Reconciliation

`RuleRegistrationPlugin` reconciles a table's steps against the **effective post-commit
state**: it overlays the triggering change (Target + pre-image) onto the committed rule/
action set, so a pre-operation reconcile accounts for its own in-flight change. A rule
published via a `statuscode` Update registers its enforcement step within that same
transaction. Unpublishing and deleting reconcile likewise. Draft action edits use
the frozen published definition and cannot remove or narrow enforcement. Internal
backfill, draft-stamp, restore, and delete-cleanup writes skip intermediate
reconciliation; the outer publication/delete operation reconciles its final state.

Drift repair is the **`asx_SyncSteps` Custom API**. Its modes, its gating privilege, its response
shape, the fact that admin-deactivated steps are never re-enabled, and the single-table fallback
are all in *Custom APIs* in the guide. One behaviour that page understates: `Mode = Sync` runs the
reconciliation above over every table with rules **and** over every table that still has
engine-owned steps, so orphans are cleaned up too (see `docs/Schema.md` §6).

The pre-uninstall `Mode = RemoveAll` call, and why the uninstall is dependency-blocked without it,
are in *Installing, Verifying & Uninstalling* in the guide.

## Real-org verification (required once)

FakeXrmEasy validates the registration *logic* but not Dataverse SDK semantics. Before
release, in a real environment: create an `OnUpdate` `Block` rule on a test table, confirm a step
named `Ascentix.RulesEngine: <table> Update` appears with the expected filtering attributes,
confirm a save that violates the rule is blocked, then delete the rule and confirm the step is
gone.
