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
- **For a slow or failing save:** its `asx-diag` line from the plug-in trace log, or for a slow
  save its Rule Diagnostic row (both below).
- **For editor problems:** the browser and version, and any errors from the
  browser console (F12 → Console), including the error panel's text.
- **The environment's base language**, especially if it isn't English.
  Localization is spot-checked on one non-English org per release, not
  systematically (*Beta Limitations §14*).

### Read a save's diagnostics from the plug-in trace log

Every save the engine evaluates writes one line to the plug-in trace: `asx-diag ` followed by the same JSON `asx_RunRules` returns as `Diagnostics`, plus the save's write figures (`writesSent`, `bulkRequests`, …; see *Custom APIs*). Its `totalMs` is the whole save, evaluation and writes.

Dataverse keeps plug-in trace lines only when the environment's **plug-in trace log** setting (System Settings, **Customization** tab, **Enable logging to plug-in trace log**) is **All**, or **Exception** for a save that failed. To read one:

1. Set the setting to **All**.
2. Repeat the save.
3. Open **Plug-In Trace Log** in the classic Settings area (or query the `plugintracelogs` table), open the newest entry for `Ascentix.RulesEngine.Plugin.RulesEnginePlugin`, and copy the text after `asx-diag `.
4. Set the setting back: **All** records a trace for every plug-in in the environment.

The line holds timings, counts and configuration node ids only, never record data. To stay well inside the trace log's 10 KB per execution, `nodes` is cut when the line would pass 4 KB (the busiest nodes are kept), and the line then carries `"nodesTruncated": true`.

The trace log can show a line minutes after the save, and it doesn't keep every line. To time a series of saves, use the diagnostics table instead (next section).

### Capture save diagnostics in a table

The **Capture diagnostics** environment variable (`asx_CaptureDiagnostics`) is a Yes/No switch that ships set to **No**. While it's **Yes**, every save the engine evaluates writes one **Rule Diagnostic** row (`asx_rulediagnostic`) per saved record. The row holds the table, the record id, the message (`Update`, `Create`, …), the save's correlation id, and in **Diagnostics** the full JSON of the `asx-diag` line, with no 4 KB cut. Its `totalMs` is the whole save. Like the trace line, the row holds timings, counts and ids only, never record data.

1. In the solution, or under **Environment variables** in the maker portal, open **Capture diagnostics** and set its current value to **Yes**.
2. Wait a minute. Each plug-in worker checks the switch at most once a minute.
3. Repeat the saves, then read the rows (for example `GET /api/data/v9.2/asx_rulediagnostics?$filter=asx_recordid eq '<record id>'`).
4. Set the current value back to **No**, or remove it, and delete the rows. While it's on, every save the engine evaluates writes a row.

A blocked or failed save leaves no row, because the row is written in the save's transaction and rolls back with it. For those saves, use the trace line. If a row can't be written, the save goes ahead as usual and the plug-in trace records why.

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
