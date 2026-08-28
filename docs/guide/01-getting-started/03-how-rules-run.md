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

## Manual / on-demand

The ad-hoc path for checking a rule's outcome without changing any data: useful for
integrations, admin tools, or testing a rule before publishing it.

- **What triggers it:** an explicit call to the `asx_RunRules` Custom API, matching
  the rule's **Manual** trigger (the API's default trigger filter). The caller
  passes a table name plus an existing record id, unsaved field values as JSON, or
  both.
- **What actions it can apply:** every fired action across all action types is
  reported back to the caller, but `asx_RunRules` is always **non-enforcing**. Even
  a fired **Block** is only reported, never thrown, and write actions are reported
  as a resolved "would write" description rather than executed.
