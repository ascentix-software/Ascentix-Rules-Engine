---
title: Troubleshooting
section: Administering
order: 305
slug: troubleshooting
---

# Troubleshooting

Every fix on this page touches only *engine* configuration. Nothing here
writes to your business tables.

## A rule is blocking saves it shouldn't

A blocked save shows **"This record could not be saved:"** followed by the
rule's message. That message is configured on the rule's action, so it
identifies the rule:

```
GET /api/data/v9.2/asx_ruleactions?$select=asx_message
    &$expand=asx_rule($select=asx_name)
    &$filter=contains(asx_message,'part of the message text')
```

Advanced Find on the **Rule Actions** table, filtered on *Message* contains,
returns the same record.

Set that rule back to **Draft**. Unpublishing removes or narrows the table's
enforcement steps in the same transaction, so the next save is evaluated
without the rule.

If the rule itself cannot be edited, deactivate its generated enforcement
step instead (*Plugin Registration* covers how the steps are named). That
suspends enforcement for the whole table and message, not just the one rule.
Reconciliation and `asx_SyncSteps` leave a deactivated step alone until an
administrator reactivates it.

## The Rule Builder won't open, or shows an error panel

When the editor can't start it renders a panel (**"The editor could not start."**
or **"The rule could not load."**) with the error text and a **Reload**
button. Work through these in order:

1. **Reload.** Press the panel's Reload button. A transient metadata or token
   failure clears on the next load.
2. **Open it from the app, not the raw URL.** The Rule Builder only runs
   inside the model-driven app, where it gets its client API and data
   context. A web-resource URL pasted into the address bar loads the page with
   nothing to talk to, and the panel says so ("The editor must be opened from
   within a model-driven app"). Open the
   **Ascentix Rules Engine** app and use **Authoring → Visual Rule
   Editor** (*Opening the Rule Builder*).
3. **Content Security Policy.** The editor loads nothing from outside your
   environment (scripts, styles, and fonts all ship as web resources), and
   each release is verified on an org with CSP enforcement turned on. If your
   environment adds its own CSP directives and the editor still fails, open
   the browser console (F12): CSP violations are reported there by name.
   Include that line in your report.
4. **Browser.** The editor and form library are verified on Chromium-class
   browsers (Edge, Chrome). Other browsers are untested during the beta
   (*Beta Limitations §9*); if you're on one, try Edge or Chrome before
   reporting.

If the panel keeps coming back, copy its error text verbatim.

## Enforcement is a few seconds behind a publish

Publishing a rule registers or widens the table's enforcement steps as part
of the publish itself, but the platform can take a few seconds to start
routing saves through a newly registered step. If the first save after a
publish goes through when it shouldn't have, wait and save again before
treating it as a bug.

## Uninstall says dependencies exist

Deleting the managed solution while engine-generated enforcement steps still
exist is dependency-blocked. The error looks like this (ids will differ):

```
Solution dependencies exist, cannot uninstall. DependencyCount : 2
RequiredComponentObject details: Type: PluginType,
  ObjectName: Ascentix.RulesEngine.Plugin.RulesEnginePlugin, Id: …
DependentComponentObject details: Type: SdkMessageProcessingStep, Id: …
DependencyType: Published
```

`DependencyCount` is the number of engine-generated steps still registered.
Clear them with the **`asx_SyncSteps`** Custom API at `Mode = "RemoveAll"`,
then delete the solution again. The full sequence is in the *Uninstalling*
section of *Installing, Verifying & Uninstalling*.

## Collect diagnostics before you report

The engine collects no telemetry from your environment: by design, nothing
phones home (*Beta Limitations §10*). A report has to carry its own evidence:

- **Solution version.** From the environment's **Solutions** list: the
  version shown for *Ascentix Rules Engine*.
- **The exact block message text**, copied verbatim from the save error, if
  a save was blocked.
- **The rule name and the table** it targets. Both are on the rule's row in
  the hub.
- **Whether it reproduces with `asx_RunRules`.** Call it for the table and
  record (*Custom APIs*). It reports what fired without writing anything.
  Pass `IncludeDiagnostics: true` and include the `Diagnostics` output: it
  carries the evaluation's timings and row counts, which is usually enough
  to show where the time or the rows went.
- **For editor problems:** the browser and version, and any errors from the
  browser console (F12 → Console), including the error panel's text.
- **The environment's base language**, especially if it isn't English.
  Localization is spot-checked on one non-English org per release, not
  systematically (*Beta Limitations §14*).

Don't include record data you wouldn't want outside your organization; rule
names, messages, and diagnostics are enough.

## Report a problem

Bugs and questions go to **GitHub Issues**:

[github.com/ascentix-software/Ascentix-Rules-Engine/issues](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues)

Open a new issue, pick the **Bug report** or **Question** template, and paste
in the diagnostics above. If the report contains something you can't put in
a public issue, email [info@ascentix.ca](mailto:info@ascentix.ca) instead. The in-app help viewer's
**Report a problem** link opens the same issue tracker in a new tab.

**A suspected security vulnerability does not go in a public issue.** Report
it privately: on the repository, use the **Security** tab →
[**Report a vulnerability**](https://github.com/ascentix-software/Ascentix-Rules-Engine/security/advisories/new),
or email [info@ascentix.ca](mailto:info@ascentix.ca) with `SECURITY` in the
subject line. The full policy is in the repository's `SECURITY.md`.
