---
title: Security Roles
section: Administering
order: 301
slug: security-roles
---

# Security Roles

The solution ships two roles for working with rules.

| Role | Privileges | On |
|---|---|---|
| **Rules Engine Author** | Create, Read, Write, Delete, Append, Append To | The 12 configuration tables |
| **Rules Engine Reader** | Read | The same 12 tables |

The 12 tables are `asx_rule`, `asx_conditiongroup`, `asx_rulecondition`, `asx_tableconfig`,
`asx_searchcriteriagroup`, `asx_searchcriterion`, `asx_nodefiltergroup`, `asx_nodefiltercriterion`,
`asx_ruleaction`, `asx_localizedmessage`, `asx_actionconditiongroup` and `asx_actionconditiontest`.

- Both roles are **additive**: assign them on top of a user's existing roles.
- All privileges are at **Organization** depth, since rule configuration is org-wide.
- **Authors can publish.** Publishing is a Write on `asx_rule`; what stops a rule going live is
  validation, not a role (*Rule Lifecycle*). Authors need nothing on platform tables such as
  `sdkmessageprocessingstep`: the engine registers steps itself.
- **Reader** is for people who look at rules without editing them. Nothing at runtime needs it.

## Enforcement doesn't depend on these roles

The engine reads rule configuration as the system user, so rules apply to every user's saves
whatever roles they hold. The roles only control who can read or edit the configuration in views,
the Rule Builder and the `asx_RunRules` / `asx_ReadRules` APIs.

The business data a rule reads is controlled per rule by its **Evaluation Context**, not by these
roles (*Evaluation Context*).

## Privileges the roles don't include

Grant these separately, for example with a small role on top:

| To | Grant |
|---|---|
| Run rules (Run now, Apply to records, `asx_ApplyRules`, `asx_ProcessRunPage`) | Create, Read, Append, Write on **Rule Run** (`asx_rulerun`); Append To on **Rule** |
| Set schedules | Create, Read, Write, Append on **Rule Schedule** (`asx_ruleschedule`); Append To on **Rule** |
| Apply a data update | System Administrator or System Customizer |

- Without Read on Rule Schedule, the Schedule section shows "You don't have access to rule
  schedules. Ask an administrator." With Read but not Create or Write, saving a schedule fails.
- The account that drives schedules (the scheduler add-on's connection, or your own caller) needs
  only the run privileges.
- Everyone who can open the Rule Builder sees a pending data update; only an administrator can apply
  it (*Data Updates*).

See *Running Rules On Demand* and *Scheduling Rules*.

## Skipping enforcement

The engine has no on/off switch. To skip it, use what the platform provides:

- For a migration or bulk import, an admin with `prvBypassCustomBusinessLogic` sets
  **`BypassCustomPluginExecution`** on the requests. That skips custom plug-ins, this engine
  included.
- **Channels** isn't a way to exempt an integration: it only tells **Portal** from **Standard**
  (*Triggers & Channels*).
- To pause one rule without deleting it, unpublish it, archive it, or set its active period
  (*Rule Lifecycle*).
