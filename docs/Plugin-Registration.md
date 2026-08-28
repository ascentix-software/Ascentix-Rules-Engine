# Plugin registration (bootstrap)

The engine has three plugins in one signed assembly, plus the four Custom API
implementations:

- **`RulesEnginePlugin`**: evaluates and enforces rules. Its steps on **customer tables**
  are generated at runtime by the registration plugin (below), so they are NOT shipped.
- **`RuleRegistrationPlugin`**: keeps those generated steps in sync with rule config.
- **`RulePublishPlugin`**: the publish gate, blocking a Draft to Published transition on an
  invalid rule. See `docs/Schema.md` §5.1.

## Shipped (bootstrap) steps: register once, ship in the solution

Register `RuleRegistrationPlugin` (pre-operation, synchronous) on:

| Table | Messages | Pre-image ("PreImage") columns |
|---|---|---|
| `asx_rule` | Create, Update, Delete | `asx_tablelogicalname`, `asx_triggers`, `statuscode` |
| `asx_ruleaction` | Create, Update, Delete | `asx_rule`, `asx_actiontype`, `asx_isactive` |

Plus one publish-gate step: `RulePublishPlugin` on `asx_rule` Update, `PreImage` carrying
`statuscode`.

Add the assembly and these seven steps (with the pre-images) to the unmanaged solution
so they travel in the managed build. No filtering attributes on these steps.

## Generated steps

`RuleRegistrationPlugin` creates/updates/deletes `RulesEnginePlugin` steps on customer tables,
named `Ascentix.RulesEngine: {table} {message}`, in the **default solution**, where the Plug-in
Registration Tool shows them. Removing the engine = delete these.

## Reconciliation

`RuleRegistrationPlugin` reconciles a table's steps against the **effective post-commit
state**: it overlays the triggering change (Target + pre-image) onto the committed rule/
action set, so a pre-operation reconcile accounts for its own in-flight change. A rule
published via a `statuscode` Update registers its enforcement step within that same
transaction; unpublishing, deleting, or adding/removing a Block action reconciles likewise.

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
