---
title: Installing, Verifying & Uninstalling
section: Administering
order: 300
slug: installation
---

# Installing, Verifying & Uninstalling

## Before you install

- A Dataverse environment. During the beta, use a **non-production**
  environment (see *Beta Limitations §1*).
- **System Administrator** on that environment to import the solution.
- The managed solution zip,
  `AscentixRulesEngine_0.0.0.N_managed.zip` (N = the beta
  number), from the
  [download page](https://ascentix.ca/power-platform/rules-engine/download),
  which also lists the file's SHA-256. Only the managed package is
  supported.

## Install

1. Open the [Power Platform admin center](https://admin.powerplatform.microsoft.com)
   → your environment → **Solutions** (or [make.powerapps.com](https://make.powerapps.com)
   → **Solutions**) and choose **Import solution**.
2. Select the managed zip and import. No settings or connection references
   are prompted. The engine has no external dependencies.

Everything ships in the solution: the rule configuration tables, the plug-in
assembly with its bootstrap registration steps, the Custom APIs, the model-driven app, the Rule Builder web resources, and the two security roles.
Existing rules work after import. Open a published rule and choose **Edit rule**
to create or resume its working draft. The published rule continues enforcing
until you publish the draft. Internal coordination and configuration preservation
are handled automatically. A release that must convert existing rules ships a *data
update*: after importing it, a System Administrator or System Customizer applies it
from the Rule Builder (see *Data Updates*).

## Assign roles

Assign the shipped roles (see *Security Roles* for exactly what they grant):

- **Rules Engine Author**: for people who create and edit rules.
- **Rules Engine Reader**: for people (or service accounts) that only read
  rule configuration.

Administrators need no extra role. Publishing a **System-context** rule with
write actions requires the publisher to hold the matching privileges org-wide
on each target table (*Evaluation Context*).

## Post-import verification checklist

1. **Solution present:** the solution list shows *Ascentix Rules Engine*
   at the version you installed, managed.
2. **App opens:** launch the **Ascentix Rules Engine** model-driven
   app; the sitemap shows the Authoring and Configuration groups.
3. **Hub loads:** open the Rule Builder. The hub renders its Rules and Table
   configurations tabs, both empty, without errors.
4. **Author a test rule:** in the hub, create a rule on any test table with
   a new configuration; add one condition that a test record will violate
   and a **Block** action that fires when the outcome is false, with a recognizable
   message; triggers **On Create**.
5. **Validate & publish:** Validate shows no errors; Publish succeeds.
6. **Enforcement is live:** create a violating record → the save is blocked
   with *"This record could not be saved:"* and your message. Fix the value
   → the save succeeds.
7. **Report-only works:** call `asx_RunRules` for the table and a record id
   (see *Custom APIs*). It returns a verdict without writing anything.
8. **Unpublish releases:** set the rule back to Draft → the previously
   blocked save now succeeds.
9. **Clean up:** delete the test rule and configuration; delete the test
    records.

If any step fails,
[open a GitHub issue](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues).

## Upgrading

Import the newer managed zip over the installed one (the default **Upgrade**
behavior). Published rules, their configurations, and their generated
enforcement steps are unaffected. Each beta release is verified to upgrade
from its immediate predecessor (*Beta Limitations §12*); don't skip versions
without testing in a sandbox first.

If the release carries a *data update*, the Rule Builder shows a banner after the
import; a System Administrator or System Customizer applies it from there (see
*Data Updates*).

### Upgrading to outcomes and "Fires when"

This release replaces each action's **On match / On no match** setting with **outcomes** (the
named top-level validation groups of a rule) and a **Fires when** condition on each action. The
upgraded engine no longer reads On match / On no match, so a one-time script converts your
existing rules. Until it has run, actions on rules published before the upgrade do not fire:
nothing is blocked wrongly, but nothing fires either. The script is
[`migrations/2026-10-multi-outcome/README.md`](../../../migrations/2026-10-multi-outcome/README.md).

Before you import the new version:

1. Run the script with `-WhatIf` (it writes nothing) to see what it would change.
2. Every rule that has ever been published from the Rule Builder keeps a working draft. The script
   republishes enforcing rules from their drafts, so it first checks each draft and lists, under
   **Drafts with edits since the last publish** (the first list of its summary), only the drafts
   changed since their last publish. Open each listed rule and **Publish** or **Discard** its
   changes.

After you import it, sign in as a System Administrator or System Customizer and run
`Convert-RulesToOutcomes.ps1` straight away. It names each outcome, builds each action's Fires
when condition, and republishes the rules that are currently enforcing. It skips any enforcing
rule whose draft has edits since the last publish, writes nothing to it, and lists it under
**Drafts with edits since the last publish (skipped: publish or discard them, then re-run)**. The
actions of a skipped rule do not fire until its draft is published or discarded and the script is
run again (or run with `-PublishDraftEdits`), so deal with this list straight away. For
each listed rule, open it and Discard the draft changes, or Publish them (the upgraded Rule
Builder first asks you to choose when each of its actions fires), then run the script again. Or,
once you have checked them, run it again with `-PublishDraftEdits` to convert and publish those
rules with their changes. A rule published before published versions were kept has nothing to
compare its draft with: it is converted and published as it is, and listed under **Drafts not
checked (no published version to compare): review them by hand**. It is safe to run again if a
run is interrupted. The retired
`asx_fireon` column stays in the solution for this release and is removed in the next one.

The `asx_RunRules` and `asx_ReadRules` results no longer include `fireOn` on each action. This is
a breaking change for any caller that reads it.

## Uninstalling

The engine's generated enforcement steps live outside the
solution (they're created at publish time in your environment) and reference
the engine's plug-in type, so a straight solution delete is
**dependency-blocked** while any exist.

1. Call the **`asx_SyncSteps`** Custom API with `Mode = "RemoveAll"` (System
   Administrator or System Customizer; see *Custom APIs*). This deletes every
   engine-generated step, including any you deactivated. It is recoverable:
   your rules are not touched.
2. Delete the managed solution from the Solutions list. Rules, configurations
   and the engine's tables are removed with it. **This is not recoverable.**

If you deleted the solution first and got a dependency error naming
`Ascentix.RulesEngine` steps, run step 1, then delete again. If you run
`RemoveAll` but *don't* uninstall, one `asx_SyncSteps` call with
`Mode = "Sync"` (or any rule publish) regenerates the steps from your
published rules.
