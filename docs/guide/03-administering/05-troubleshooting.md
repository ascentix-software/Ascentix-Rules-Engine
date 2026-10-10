---
title: Troubleshooting
section: Administering
order: 305
slug: troubleshooting
---

# Troubleshooting

Every fix here changes engine configuration only, never your business tables.

## A rule blocks saves it shouldn't

The save error reads **"This record could not be saved:"** followed by the rule's message.

1. Find the rule from its message: Advanced Find on **Rule Actions**, *Message* contains the text.
   Or:
   ```
   GET /api/data/v9.2/asx_ruleactions?$select=asx_message
       &$expand=asx_rule($select=asx_name)
       &$filter=contains(asx_message,'part of the message text')
   ```
2. Open the rule and choose **Unpublish…** in the **More actions** (⋯) menu. The next save runs
   without it.

If you can't edit the rule, deactivate its enforcement step instead (*Plugin Registration*). That
stops every rule on that table and message, and stays off until an administrator turns it back on.

## The Rule Builder shows "could not start" or "could not load"

Try these in order:

1. **Reload** from the panel. Most one-off failures clear.
2. **Open it from the app**: **Ascentix Rules Engine** → **Authoring → Visual Rule Editor**. A
   web resource URL opened directly has no app context, and the panel says so.
3. **Check the browser console** (F12) for Content Security Policy errors if your environment adds
   its own CSP rules. The editor itself loads nothing from outside the environment.
4. **Use Edge or Chrome.** Other browsers aren't tested during the beta (*Beta Limitations §9*).

If it keeps failing, copy the panel's error text into your report.

## A save goes through just after publishing

The platform can take a few seconds to route saves through a newly registered step. Wait, then
save again before treating it as a bug.

## Rules are read-only and a bar names an update

A data update is waiting. Rules can be viewed but not edited or published until it's applied;
enforcement, **Run now** and schedules keep working. A System Administrator or System Customizer
chooses **Apply now** (*Data Updates*). If the bar stays afterwards, reload.

## A data update finished with failed items

Each failed item was skipped and left as it was. Everything else was converted, and rules are
editable again. Fix what each message names, then choose **Retry failed items**. The list shows up
to 50 items. If the same items keep failing, report it with their names and messages.

## Uninstall says dependencies exist

```
Solution dependencies exist, cannot uninstall. DependencyCount : 2
…
DependentComponentObject details: Type: SdkMessageProcessingStep, Id: …
```

The engine's enforcement steps are still registered. Remove them with the `asx_SyncSteps` Custom
API (`Mode = "RemoveAll"`), then delete the solution again. See *Installing, Verifying &
Uninstalling*.

## What to include in a report

The engine sends no telemetry, so a report needs its own evidence:

- The **solution version** (from the **Solutions** list).
- The **rule name and table**, and the **exact message** if a save was blocked.
- The result of **`asx_RunRules`** for the record with `IncludeDiagnostics: true` (*Custom APIs*).
  It writes nothing, and its `Diagnostics` output shows where the time and rows went.
- For a **slow save**: its diagnostics, from the trace log or the diagnostics table (below).
- For **editor problems**: the browser and version, and any console errors (F12).
- The environment's **base language**, if it isn't English.

Leave out record data you can't share. Rule names, messages and diagnostics are enough.

### Read a save's diagnostics from the trace log

Each save the engine evaluates writes an `asx-diag` line to the plug-in trace log: the same JSON
as `asx_RunRules` returns, plus the save's writes. A save that fails during evaluation (for example
at the 25,000-row limit) writes none; reproduce it with `asx_RunRules`.

1. Set **Enable logging to plug-in trace log** (System Settings → **Customization**) to **All**.
2. Repeat the save.
3. Open **Plug-In Trace Log**, find the newest entry for
   `Ascentix.RulesEngine.Plugin.RulesEnginePlugin`, and copy the text after `asx-diag `.
4. Set the setting back. **All** traces every plug-in in the environment.

The line holds timings, counts and ids, never record data. The trace log can be minutes late and
may drop lines, so to time several saves use the diagnostics table.

### Capture save diagnostics in a table

1. Set the **Capture diagnostics** environment variable (`asx_CaptureDiagnostics`) to **Yes**.
2. Wait a minute for it to take effect.
3. Repeat the saves, then read the **Rule Diagnostic** rows (`asx_rulediagnostic`), one per saved
   record.
4. Set it back to **No** and delete the rows.

A blocked or failed save leaves no row. Use this for testing only: while it's on, every save writes
a row, and if writing one fails, Dataverse can fail the save. If saves start failing with a
transaction error, turn it off.

## Report a problem

Open an issue on [GitHub](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues) with
the **Bug report** or **Question** template. The help viewer's **Report a problem** link opens the
same page. For anything you can't post publicly, email [info@ascentix.ca](mailto:info@ascentix.ca).

**Report a suspected security vulnerability privately**: the repository's **Security** tab →
[**Report a vulnerability**](https://github.com/ascentix-software/Ascentix-Rules-Engine/security/advisories/new),
or email [info@ascentix.ca](mailto:info@ascentix.ca) with `SECURITY` in the subject. See
`SECURITY.md`.
