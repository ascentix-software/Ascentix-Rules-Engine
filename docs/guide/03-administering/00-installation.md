---
title: Installing, Verifying & Uninstalling
section: Administering
order: 300
slug: installation
---

# Installing, Verifying & Uninstalling

## Before you install

- A Dataverse environment. During the beta, use a **non-production** one (*Beta Limitations §1*).
- **System Administrator** on that environment.
- The managed solution, `AscentixRulesEngine_<version>_managed.zip`, from the
  [download page](https://ascentix.ca/power-platform/rules-engine/download), which also lists its
  SHA-256. Only the managed package is supported.

## Install

1. In the [Power Platform admin center](https://admin.powerplatform.microsoft.com) → your
   environment → **Solutions** (or [make.powerapps.com](https://make.powerapps.com) →
   **Solutions**), choose **Import solution**.
2. Select the managed zip and import. Nothing is prompted, and there are no external dependencies.

The solution holds everything: the configuration tables, the plug-in, the Custom APIs, the
model-driven app, the Rule Builder and the two security roles.

## Assign roles

| Role | For |
|---|---|
| **Rules Engine Author** | People who create and edit rules. |
| **Rules Engine Reader** | People or service accounts that only read rule configuration. |

Administrators need no extra role. Publishing a **System**-context rule that writes needs the
publisher to hold the matching privileges org-wide on each target table (*Evaluation Context*). See
*Security Roles* for exactly what each role grants.

## Optional settings

| Environment variable | Default | What it does |
|---|---|---|
| **Bulk writes** (`asx_BulkWrites`) | No | Yes sends several creates or updates of one table as one request: faster, but unsupported by Microsoft in plug-in code (*Beta Limitations §18*). |
| **Capture diagnostics** (`asx_CaptureDiagnostics`) | No | Yes records each save's timings, for troubleshooting (*Troubleshooting*). |

## Verify the install

1. **Solution:** the Solutions list shows *Ascentix Rules Engine*, managed, at your version.
2. **App:** the **Ascentix Rules Engine** app opens with the Authoring and Configuration groups.
3. **Hub:** the Rule Builder opens with empty Rules and Data models tabs, and no errors.
4. **Test rule:** create a rule on a test table with a new data model. Add one condition a test
   record will break, and a **Block save** action, with a recognizable message, that fires when the
   outcome is false. Have it run on **Create**.
5. **Publish:** **Check for issues** finds none, and **Publish…** succeeds.
6. **Enforcement:** creating a breaking record fails with *"This record could not be saved:"* and
   your message. Fix the value and the save succeeds.
7. **Report-only:** `asx_RunRules` for the table and a record id returns a verdict and writes
   nothing (*Custom APIs*).
8. **Unpublish:** **Unpublish…** in the rule's **More actions** (⋯) menu lets the blocked save
   through.
9. **Clean up:** delete the test rule, its data model and the test records.

If a step fails, [open a GitHub issue](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues).

## Upgrading

Import the newer managed zip over the installed one (the default **Upgrade**). Published rules and
their enforcement keep working. Each beta is tested as an upgrade from the one before it
(*Beta Limitations §12*); test in a sandbox before skipping versions.

If the release carries a *data update*, the Rule Builder shows a read-only bar after the import, and
a System Administrator or System Customizer applies it there (*Data Updates*).

### Upgrading to outcomes and "Fires when"

This release replaces each action's **On match / On no match** setting with **outcomes** (the named
top-level validation groups of a rule) and a **Fires when** condition on each action. The engine no
longer reads On match / On no match, so the release ships **data update 1, Convert action conditions
to outcomes**. Until it's applied, actions on rules published before the upgrade don't fire: nothing
is blocked wrongly, but nothing fires either.

Right after the import, a System Administrator or System Customizer opens the Rule Builder and
chooses **Apply now** (*Data Updates*). For each rule, the update:

- names each outcome: a blank name becomes "Outcome 1", "Outcome 2" and so on, and a repeated name
  gets " (2)", " (3)";
- gives each action a Fires when condition: **On match** becomes *all outcomes are true*, **On no
  match** becomes *any outcome is false*. An On no match action on a rule with no outcomes never
  fired, so it's turned off.

Converted rules keep enforcing as before, with no publish needed. A rule the update can't convert is
listed with the reason; fix it and choose **Retry failed items**. The retired `asx_fireon` column
stays in this release and is removed in the next.

**Breaking:** `asx_RunRules` and `asx_ReadRules` no longer return `fireOn` on each action.

## Uninstalling

The engine's enforcement steps are created in your environment when rules are published, outside the
solution, so they block a straight solution delete.

1. Call `asx_SyncSteps` with `Mode = "RemoveAll"` (System Administrator or System Customizer;
   *Custom APIs*). It deletes every engine-generated step, deactivated ones included. Your rules are
   untouched, so this is reversible.
2. Delete the managed solution. Rules, data models and the engine's tables go with it. **This can't
   be undone.**

If you deleted the solution first and got a dependency error naming `Ascentix.RulesEngine` steps,
run step 1 and delete again. If you run `RemoveAll` and then decide to keep the engine, call
`asx_SyncSteps` with `Mode = "Sync"`, or publish any rule, to rebuild the steps.
