---
title: Client Form Library
section: Developer Reference
order: 403
slug: client-form-library
---

# Client Form Library

`asx_rulesengine.js` is the web resource that gives rules their on-form behavior with no custom
JavaScript: the *On form (client, advisory)* path in *Runtime Enforcement*. The client is advisory
only; the server plugin enforces every rule.

## What it does

On form load, the library:

1. Calls `asx_ReadRules` once for the form's table (trigger `OnForm`), caches the rules, and works
   out which columns they depend on and which columns and messages they can target.
2. Records the baseline visibility and required level of every control the rules might touch.
3. Adds a change handler to each dependency column on the form. It adds **no** save handler: the
   client never blocks or triggers a save.
4. Runs a first evaluate-and-apply cycle.

Each cycle (on load, then on every relevant field change) sends the dependency columns' current
values to `asx_RunRules`, resets every touched control to its baseline, and applies the fired
actions (*Custom APIs*).

## Action mapping

| Action Type | Form effect | Blocks save? |
|---|---|---|
| Set Visible | Shows/hides the target control | No |
| Set Required | Sets the target field's required level | An empty required field blocks natively through the platform's own validation |
| Show Message (form-level) | Sets a form notification at the action's configured severity | No |
| Show Message (field-targeted) | Adds a notification to the control | Yes. The platform renders control notifications at Error only, and an Error control notification stops the save through native field validation, whatever severity the action carries |
| Block (field-targeted) | Adds an inline notification on that field only | Yes, via the platform's own field validation: it rolls the field notification up to the form header on save and blocks there |
| Block (form-level) | Shows a form banner | No (no field for the platform to roll a notification up from) |
| Create/Update/Delete Record | Ignored on the client | n/a (server-only) |

Imports, API calls and other writes that don't go through the form are enforced on save by the
server plugin, whatever the client shows.

## Wiring it onto a form

On each model-driven form that should run rules:

1. Add the `asx_rulesengine` web resource as a **form library**.
2. Register one `OnLoad` handler: function `Ascentix.RulesEngine.onLoad`, with **Pass execution
   context as first parameter** checked.

That's the only handler to add. The library registers its own change handlers from `onLoad`.

> `asx_authoringforms.js` is a separate bundle for the engine's own configuration forms, not for
> rules on your tables.

## When something fails

The library never breaks or freezes a form:

- If `asx_ReadRules` fails on load (network error, no read access, or the API missing), it logs the
  error, wires nothing, and leaves the form as it is, with no error banner.
- If `asx_RunRules` fails mid-cycle, it logs the error and keeps the last successful cycle's state,
  rather than clearing the form or inventing a block.
