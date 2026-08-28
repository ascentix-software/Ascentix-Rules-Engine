# Domain glossary: Ascentix Rules Engine

The names the code, docs and tests use. `docs/Schema.md` is the storage contract; this file is
the vocabulary. Architecture words (module, interface, seam, adapter, depth, leverage, locality)
follow the codebase-design glossary and are not redefined here.

## Rules

- **Rule.** A published unit of behaviour on one **root table**: triggers, channels, an
  evaluation context, condition groups, actions. Lives in `asx_rule`.
- **Condition.** One test inside a condition group: FieldComparison, RowCount, RegexMatch,
  Expression (mathexpr). Reads one **node** of the rule's configuration tree and may carry a
  **node filter**.
- **Action.** What fires when the group's verdict says so: Block, ShowMessage, SetVisible,
  SetRequired, CreateRecord, UpdateRecord, DeleteRecord. Fire on match or on no-match.
- **Trigger.** When a rule is evaluated: OnCreate, OnForm, Manual, OnUpdate, OnDelete.
- **Channel.** Where the save comes from: Standard (every non-portal origin: forms, the Web API,
  integrations, service principals, SYSTEM/async) or Portal (Power Pages, `IsPortalsClientCall`).
  Resolved by `OriginResolver`; empty = all channels. The engine cannot tell a human apart from
  an integration: Dataverse does not expose that reliably.
- **Evaluation context.** Whose privileges the traversal and write actions run under: User
  (the saving user) or System. Publishing a System-context rule with write actions is gated by
  `SEC_SYSWRITE_PRIV`.

## Configuration tree

- **Table Config tree.** The graph of tables a rule can traverse: one **Root Table** node and
  its **Lookup** and **Child** nodes (`asx_tableconfig`). A root table may have more than one
  tree; every rule is evaluated against its own tree, and all roots for the triggering table are
  seeded with the triggering record. Module: `TableConfigTree`
  (`Ascentix.RulesEngine.Core/Models`), a **forest** built once per load; depth, roots, parent
  chains, cardinality and ancestor queries all live there. The loader returns a **validated**
  tree (no root / cycle / missing parent throw at construction, so runtime walks never re-guard);
  the validator holds an **unvalidated** tree and *reports* a broken shape as an issue instead.
- **Node.** One table position in a tree. Conditions, node filters, EXISTS criteria, field
  mappings and message tokens reference nodes by id.
- **Node filter.** The "only consider records where…" clause on a node; an **EXISTS criterion**
  inside a filter counts rows of a related collection node.
- **Pushdown variant.** A node fetch with part of a node filter pushed into the Dataverse query,
  keyed per filter signature. The in-memory evaluator re-applies the full filter; pushdown only
  ever returns a superset. **Unfiltered** = the node fetched with no pushed predicate.
- **Traversal cap.** 25,000 rows per node per evaluation; exceeding it fails the save.

## Evaluation

- **In-flight batch.** The Create/Update/Delete still pending at pre-operation; every fetch of
  the triggering table is reconciled against it (`InFlightReconciler`).
- **Enforcement step.** The generated `SdkMessageProcessingStep` (`Ascentix.RulesEngine: <table> <message>`)
  that runs the engine for a table; created on publish, reconciled by `asx_SyncSteps`.
- **Verdict.** The outcome of one evaluation: which actions fired, for which rule, with rendered
  messages. `asx_RunRules` reports it; enforcement acts on it.
- **Rule reference set.** Everything a rule touches, computed once per mapped rule from its
  condition groups (node filters, EXISTS criteria and sub-filters included) and its **active**
  actions (targets, parsed field mappings, Message and LocalizedMessages). Module
  `RuleReferences` (`Ascentix.RulesEngine.Core/Engine/RuleReferences.cs`); its named answers:
  **nodesToLoad** (the required config-load seed), **optionalNodes** (message-token-only nodes,
  where a stale token degrades to raw text), **nodesToPlan** (extra nodes for the query plan),
  **hardReaders** (nodes whose consumers cannot be enumerated, always fetched unfiltered; built
  from its own kind list), **filterDerivedNodes** (filter targets, filter value nodes, EXISTS
  collections, sub-filter nodes; the pushdown planner proves their demand), **unpruneable** (hard
  readers ∪ filter-derived), **rootColumns** and **isRootOnly** (take the tree), and
  **referencesByKind** (provenance: which condition/action carries each reference). The runner,
  the validation loader, the pushdown planner, column pruning, the step analyzer and the rule
  serializer are adapters of these answers; nothing below the seam walks the rule again.
- **Result cache.** The per-evaluation store of fetched rows per node and variant
  (`QueryResultCache`). A read of a never-fetched entry is an engine planning fault, not an empty
  collection.
- **Evaluation stages.** `RulesEngineRunner.Run` composes three. **Gather** (needs Dataverse):
  `RuleBuckets` loads the in-effect rules and buckets them by evaluation context (User first,
  then System, though the bucket only decides the traversal service); `EvaluationGatherer` then
  reads, per bucket, the mapped groups and actions, the rule reference set, the config tree, the
  plan, the roots and every row each record needs (one result cache per record) into one
  **`EvaluationInput`** per bucket. **Evaluate** (`BucketEvaluator`, pure by type, with no
  service and metadata as interfaces): rules × records over that input alone; execution groups
  gate before main groups, actions fire in dispatcher order, write intents resolve and messages
  render; the answer is an **`EvaluationVerdict`** (fired actions per record). **Dispatch**
  (`RunOutcomeAssembler`): the verdicts become the `RuleEvaluationOutcome`. Stage timers
  (`ruleLoad`, `scheduleFilter`, `conditionMap`, `actionLoad`, `tableConfigLoad`, `planBuild`,
  `rootBuild`, `queryExecute`, `evaluate`) are owned by the stage that does the work.

## Verification vocabulary (tests and harness)

- **L1 / L2 / L3.** Hermetic unit tests; live contract suites over the Web API against a
  development environment (`client/test-dev`); browser suites (`client/e2e`) and the signed
  manual protocol a human performs once per release.
- **Tier A / B / C.** Per-PR CI; deploy-triggered live L2 and the release gate; the fresh-org
  install / upgrade / uninstall proof run against a clean environment before a release.
- **DevOrg.** The harness module that hands a test an org handle (url, token, Web API) for a
  named identity: `user` (az), `sp` or `authorSp`.
- **Settle.** Waiting for the platform to agree with the state a test just established: the
  **enforcement settle** (step cache propagation after publish) and the **data settle**
  (read-after-write visibility of just-created rows). Both are probes, not sleeps.
