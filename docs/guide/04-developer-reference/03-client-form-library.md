---
title: Client Form Library
section: Developer Reference
order: 403
slug: client-form-library
---

# Client Form Library

`asx_rulesengine.js` is the JavaScript web resource that gives rules their on-form
behavior with no custom JavaScript of your own: the *On form (client, advisory)* path
described in *Runtime Enforcement*. The client is advisory only. The server plugin is
the authoritative enforcer of every rule, and everything below assumes that.

## What it does

On form load, the library:

1. Calls `asx_ReadRules` once for the form's table (requesting the `OnForm`
   trigger), caches the rule definitions, and derives which columns the rules depend
   on and which columns/messages the rules can target.
2. Snapshots the baseline visibility and required-level of every control the rules
   might touch.
3. Registers a change handler on each dependency column present on the form. It
   registers **no** save handler: the client never blocks or triggers a save.
4. Runs an initial evaluate-then-apply pass.

Each subsequent evaluate-then-apply cycle (on load, and again on every relevant field
change) serializes the current form values for the dependency columns, calls
`asx_RunRules` for the table with those values, resets every previously-touched
control back to its baseline, and applies the actions the response reports as fired.
See *Custom APIs*.

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
Bulk imports, API calls, and other writes that never pass through this form are
gated on save by the server plugin regardless of what the client shows.

## Wiring it onto a form

On each model-driven form that should run the rules engine:

1. Add the `asx_rulesengine` web resource as a **form library**.
2. Register one event handler:
   - **Event:** `OnLoad`
   - **Function:** `Ascentix.RulesEngine.onLoad`
   - **Pass execution context as first parameter:** checked

That is the only handler to register by hand. From inside `onLoad` the library
self-registers change handlers on the dependency columns it discovers from
`asx_ReadRules`.

> `asx_authoringforms.js` is a separate bundle: it drives conditional visibility on
> the engine's own configuration forms inside the Rules Engine app, not rules running
> on your own tables.

## Graceful degradation

The library never breaks or freezes a form on its own failure:

- If `asx_ReadRules` fails on load (network error, the caller lacks read access, or
  the API isn't available), the library logs the error, skips all wiring, and leaves
  the form usable as-is with no end-user error banner.
- If `asx_RunRules` fails mid-cycle, the library logs the error and keeps the last
  successful cycle's state rather than wiping the form or fabricating a block
  notification.
