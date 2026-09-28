---
title: How Rules Run
section: Getting Started
order: 103
slug: how-rules-run
---

# How Rules Run

A single rule can be evaluated in three execution contexts, depending on its
**Triggers**. The **evaluation model is identical across all three contexts**: the
same WHEN/THEN logic, the same Table Config traversal, the same condition types.
Only the invocation and which action types take effect differ.

## On create / update / delete (server engine)

A plugin step runs synchronously as part of the database operation whenever a
record on the rule's table is created, updated, or deleted.

- **What triggers it:** a Create, Update, or Delete operation against the rule's
  table, matching the rule's **On Create**, **On Update**, or **On Delete**
  trigger.
- **What actions it can apply:** the full server action set, including write and
  blocking actions: **Block**, **Create Record**, **Update Record**, and **Delete
  Record**. A fired **Block** action prevents the operation entirely and rolls back
  any pending writes; write actions run atomically in the same transaction as the
  triggering operation.

## On form (client form library)

- **What triggers it:** the form loading, or a field on the form changing, matching
  the rule's **On Form** trigger.
- **What actions it can apply:** the client-facing action set (**Set Visible**,
  **Set Required**, and **Show Message**), applied live to the form. Any
  server-only actions (like Block or the write actions) attached to the same rule
  are evaluated and reported, but never executed from the form; enforcement of
  those still happens server-side when the record is saved.

## On demand

A rule with the **On demand** trigger (labelled **Manual** before this release; the
stored value and the API trigger name are unchanged, and `Manual` is still accepted
alongside `OnDemand`) is invoked explicitly rather than by a save or a form event.
There are two different ways to invoke it, with different enforcement:

### Dry run: `asx_RunRules`

The ad-hoc path for checking a rule's outcome without changing any data: useful for
integrations, admin tools, or testing a rule before publishing it.

- **What triggers it:** an explicit call to the `asx_RunRules` Custom API, matching
  the rule's **On demand** trigger (the API's default trigger filter). The caller
  passes a table name plus an existing record id, unsaved field values as JSON, or
  both.
- **What actions it can apply:** every fired action across all action types is
  reported back to the caller, but `asx_RunRules` is always **non-enforcing**. Even
  a fired **Block** is only reported, never thrown, and write actions are reported
  as a resolved "would write" description rather than executed.

### Enforcing: Run now, Runs, and `asx_ApplyRules`

The **enforcing** on-demand path, for actually applying an On demand rule rather
than previewing it: the Rule Builder and hub's **Run now** button, the **Runs**
dialog, and the `asx_ApplyRules` / `asx_ProcessRunPage` Custom APIs a script or
flow can call directly. See *Running Rules On Demand* for the full picture.

- **What triggers it:** **Run now** against one record, or a **Rule Run** the
  rule's **Runs for** setting scopes to either one record at a time (**a record
  it's given**) or **every record that passes the rule's execution conditions**
  (**all records**, read a page at a time). A caller can also invoke
  `asx_ApplyRules` directly against a single record.
- **What actions it can apply:** the full server action set, exactly like *On
  create / update / delete* below: a fired **Block** throws, applying no writes for
  that record, and otherwise every fired write action is applied inside its own
  transaction.
