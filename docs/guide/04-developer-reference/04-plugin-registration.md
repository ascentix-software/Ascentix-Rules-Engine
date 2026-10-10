---
title: Plugin Registration
section: Developer Reference
order: 404
slug: plugin-registration
---

# Plugin Registration

Server-side enforcement (*Runtime Enforcement*) is a Dataverse plugin, but you never register it
against your tables by hand. The one signed assembly has two plugins that matter here:

| Plugin | Role | Registered |
|---|---|---|
| **`RulesEnginePlugin`** | Evaluates and enforces rules | Its steps on your tables are **generated at runtime** |
| **`RuleRegistrationPlugin`** | Keeps those generated steps in sync with your rules | Shipped with the solution |

## Shipped bootstrap steps

`RuleRegistrationPlugin` runs as pre-operation synchronous steps on the engine's own tables, with
no filtering attributes, so every create, update and delete of a rule or action passes through it:

| Table | Messages |
|---|---|
| `asx_rule` | Create, Update, Delete |
| `asx_ruleaction` | Create, Update, Delete |

## Generated steps

When you create, edit, activate or delete a rule, `RuleRegistrationPlugin` reconciles the
`RulesEnginePlugin` step on **your** table: it creates it, updates its message and filtering when
the rule changed, or removes it when no rule needs it.

Generated steps are named `Ascentix.RulesEngine: {table} {message}` (for example
`Ascentix.RulesEngine: account Update`). Where the environment supports them, they also cover
`CreateMultiple` / `UpdateMultiple`.

## Publish gate

A rule enforces only once **Published** (*Rule Lifecycle*). A shipped step on `asx_rule` runs the
same validation as *Validating & Publishing* and blocks Draft → Published for an invalid rule.

- Every publish, including republishing a live rule, captures the saved draft and its data model.
- All steps run synchronously in pre-operation: configuration guards first (order 1), then the
  publisher (20), then registration reconciliation (30).
- Guards cover Create/Update/Delete on the twelve configuration tables, plus legacy SetState on
  rules. Revision-table access uses platform permissions.
- A native rule Delete captures ownership in PreValidation and cleans up in
  PreOperation/PostOperation, inside the delete transaction. Both the Rules grid and the Rule
  Builder can delete.
- Draft edits keep the registrations the published snapshot needs.

## Drift repair

If steps drift from your rules (for example, rules edited while the registration plugin was
disabled), call `asx_SyncSteps` with `Mode = "Sync"` (*Custom APIs*). It reconciles the steps
without unpublishing rules or changing their published definitions.
