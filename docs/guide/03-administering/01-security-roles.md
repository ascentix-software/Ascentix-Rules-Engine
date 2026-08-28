---
title: Security Roles
section: Administering
order: 301
slug: security-roles
---

# Security Roles

Two solution-owned security roles control who can work with rules and their
configuration in Dataverse.

## The two roles

| Role | Tables | Privileges |
|---|---|---|
| **Rules Engine Author** | the 10 config tables (`asx_rule`, `asx_conditiongroup`, `asx_rulecondition`, `asx_tableconfig`, `asx_searchcriteriagroup`, `asx_searchcriterion`, `asx_nodefiltergroup`, `asx_nodefiltercriterion`, `asx_ruleaction`, `asx_localizedmessage`) | Create, Read, Write, Delete, Append, AppendTo |
| **Rules Engine Reader** | the same 10 config tables | Read |

Both roles are **additive**: Dataverse unions privileges across a user's
roles, so assign either one on top of whatever roles a user already has. All
privileges are at **Organization** depth, because rule configuration is
org-wide reference data.

## Who can author vs. publish

There is no separate "publisher" role. Moving a rule from **Draft** to
**Published** is a **Write** on `asx_rule`, so anyone holding **Rules Engine
Author** can both author and publish. What gates a rule from actually reaching
Published is not a security role but the rule **validator**: publishing is
blocked until the rule passes validation, regardless of who is doing the
publishing. See *Rule Lifecycle* for what Draft, Published, and Archived mean
at runtime.

Beyond the privileges in the table: Authors need no privileges on Dataverse
platform tables like `sdkmessageprocessingstep`, because the engine's own
registration plugin runs as the system user and handles step registration on
their behalf. Reader is for a user who needs to see rules without editing them.
No part of the engine's runtime requires it: the enforcement plugin,
`asx_RunRules` and `asx_ReadRules` all read configuration as system (see
below), so the client form library reaches configuration without it. The
component that reads configuration in the calling user's own context is the
Rule Builder, whose users hold Author.

## Rule-config reads run as system

`RulesEnginePlugin` loads the config tables (`asx_rule`, `asx_conditiongroup`,
`asx_rulecondition`, `asx_tableconfig`, `asx_ruleaction`, and the
search/node-filter tables) using the **system user** service, not the
calling user's. Without that, a caller lacking read access to `asx_rule` would
load zero rules and enforcement would silently not apply. Because the plugin
always reads config as system, a user's Reader/Author role assignment has no
bearing on whether rules are enforced for that user's writes. It only controls
whether *that user* can read or edit the configuration directly (through a
view, the Rule Builder, or the `asx_RunRules`/`asx_ReadRules` APIs).

The **business data** a rule's conditions traverse is a separate concern,
controlled per rule by the **Evaluation Context** setting rather than by these
two roles. See *Evaluation Context*.

## Administrative bypass

The engine has no on/off switch. To run a migration or bulk import without
rule enforcement, admins use platform-native mechanisms instead:

- An admin holding the `prvBypassCustomBusinessLogic` privilege can set
  **`BypassCustomPluginExecution`** on a request (from the SDK, Configuration
  Migration, or bulk import tooling) to skip custom plugins (including this
  engine) for that operation.
- **Channels** is not an integration bypass. Its only distinction is
  **Portal** versus **Standard**, because Dataverse does not reliably tell a
  human apart from an application user. See *Triggers & Channels*. Use
  `BypassCustomPluginExecution` to exempt an integration.
- A rule can be kept in **Draft** or **Archived**, or scheduled outside its
  effective window, to suppress it without deleting it. See *Rule
  Lifecycle*.
