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
The import adds no custom install steps, and there is no separate schema-deploy
tool or step to run.

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
   and a **Block** action (fire on **On No Match**) with a recognizable
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
