---
title: Plugin Registration
section: Developer Reference
order: 404
slug: plugin-registration
---

# Plugin Registration

The server-side enforcement described in *Runtime Enforcement* is implemented as a
Dataverse plugin, but you don't register that plugin against your tables by hand.

## Two plugins that matter for enforcement registration

The engine ships one signed plugin assembly.

- **`RulesEnginePlugin`**: the evaluator and enforcer (see *Runtime Enforcement*).
  Its steps against your own tables are **generated at runtime**, not shipped as part
  of the solution.
- **`RuleRegistrationPlugin`**: keeps those generated steps in sync with your rule
  configuration. This is the one piece that *is* shipped and registered up front.

## Shipped bootstrap steps

`RuleRegistrationPlugin` is registered once, as pre-operation synchronous steps, on
the engine's own configuration tables:

| Table | Messages |
|---|---|
| `asx_rule` | Create, Update, Delete |
| `asx_ruleaction` | Create, Update, Delete |

These six `RuleRegistrationPlugin` steps travel with the solution, as does the
publish gate and the revision guards described below. No filtering
attributes are applied to the six: every create, update, and delete against a
rule or an action passes through `RuleRegistrationPlugin`.

## Generated steps

Whenever you create, edit, activate, or delete a rule, `RuleRegistrationPlugin`
reconciles the corresponding `RulesEnginePlugin` step on **your** table: creating it
if it doesn't exist, updating its filtering/message registration if the rule
changed, or removing it when the rule no longer targets that message. Delete every
rule on a table and that table's generated steps go with them.

Generated steps are named `Ascentix.RulesEngine: {table} {message}` (for example,
`Ascentix.RulesEngine: account Update`) and are visible like any other step in the
Plug-in Registration Tool. Where the environment supports it, they also cover
Dataverse's bulk `CreateMultiple` / `UpdateMultiple` messages.

## Publish gate

A rule only enforces once it's **Published** (see *Rule Lifecycle*). A shipped step
on `asx_rule` runs the same validation as *Validating & Publishing* and blocks the
Draft → Published transition if the rule is invalid.

Every explicit publication, including republishing a live rule, captures the saved
draft and its data model. Configuration guards execute first (order 1), the
publisher next (20), and registration reconciliation last (30), all synchronously
in pre-operation. Guards cover Create/Update/Delete of the ten configuration tables
and revision table, plus legacy SetState on rules. Draft edits preserve the
registrations required by the published snapshot.

## Drift repair

If steps drift out of sync with your rules (for example, if rules were edited while
the registration plugin was temporarily disabled), deactivate and then reactivate any
one rule on the affected table. Reconciliation is table-scoped, so that single save
re-syncs every generated step for the whole table. To reconcile every table in one
call instead, use `asx_SyncSteps` with `Mode = "Sync"` (see *Custom APIs*).
