---
title: Runtime Enforcement
section: Administering
order: 302
slug: runtime-enforcement
---

# Runtime Enforcement

What a published rule does when it fires depends on *which action type* fired
and *where* the rule ran, not on severity alone.

## Severity is a message level, not a block switch

Severity (**Information**, **Warning**, or **Error**) is set per action
(see *Core Concepts*) and controls the notification level a message is
shown at. It does **not**, by itself, determine whether an operation is
blocked: on the server a **Show Message** is always informational, at any
severity. On a form, a Show Message targeted at a field does stop the save,
for the reason given under *On form* below.

What blocks an operation is the action **type**. Only a fired **Block**
action stops the save, and severity is not consulted when deciding whether to
block: a **Warning**-severity `Block` blocks and rolls back the save exactly
like an Error-severity one.

## On create / update / delete (server, authoritative)

When a Create, Update, or Delete against a rule's table matches the rule's
trigger:

- The plugin evaluates every applicable rule and dispatches its fired
  actions.
- If **any** `Block` action fires (across any rule on that record), the
  plugin throws before any writes happen. **No** part of the operation
  commits, including any `Create Record` / `Update Record` / `Delete
  Record` write actions that also fired: **block wins**.
- If no `Block` fires, any fired write actions (`Create Record`, `Update
  Record`, `Delete Record`) are applied atomically in the same transaction
  as the triggering operation. A write failure throws and rolls back the
  whole operation.
- Write actions don't cascade into rules triggered by their own writes; they
  execute only at the top level of the operation.
- This holds identically across all three triggers, including **On
  Delete**: a `Block` that fires when a matching record is deleted throws
  before the delete is applied, and the row survives.
- Enforcement also respects the rule's **Channels** gate (see *Triggers &
  Channels*): a write through a Power Pages portal resolves to **Portal**,
  every other origin to **Standard**, and each is enforced (or excluded) as
  such. The engine does not distinguish a human from an integration.

**Message format.** The exception message aggregates **every** fired
`Block` message across all rules on the record as a deduped, bulleted list
under a header, for example:

```
This record could not be saved:
 • Name must be Valid.
 • Amount must be positive.
```

A `Block` action with no configured message falls back to a default block
message. On a bulk operation, the plugin evaluates **every** record rather
than failing fast, and throws once with every failing record's messages and
id included, so the caller sees every problem in a single round trip.

## On form (client, advisory)

The client form library never calls `preventDefault` on a save. It has no `OnSave`
handler and only *surfaces* what a rule would do, giving the person filling
out the form early feedback before they save:

- `Set Visible` and `Set Required` are applied directly to the form.
- A **form-level** `Show Message` sets a form notification at its configured
  severity and does not block.
- A **field-targeted** `Show Message` is added to the control instead. The
  platform renders control notifications at Error only, and an Error control
  notification stops the save through native field validation. So a Show
  Message on a field blocks until its condition stops matching, whatever
  severity it carries. Use a form-level Show Message for advice that must not
  stop anyone.
- A **field-targeted** `Block` shows as an inline notification on that
  field only. On save, the platform's own validation rolls that
  notification up to the form header and stops the save at that point,
  through native field validation rather than through the rules engine.
- A **form-level `Block`** (not targeted at a specific field) shows as a
  form banner instead, since there's no field to attach it to.

The server backstops the client for any write that doesn't go through this
form (bulk import, API calls, other integrations).

## Manual / on-demand

A rule invoked through `asx_RunRules` never blocks, regardless of what
fires (see *How Rules Run*). Every fired action, including `Block`, is
reported back to the caller as data instead: the response's `IsValid` flag
is `true` only when no `Block` action fired, and `FailedRuleCount` counts
the distinct rules that fired one. Nothing is thrown and no write actually
happens.
