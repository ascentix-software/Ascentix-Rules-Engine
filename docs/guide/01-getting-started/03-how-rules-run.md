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
  table, matching the rule's **On create**, **On update**, or **On delete**
  trigger.
- **What actions it can apply:** the full server action set, including write and
  blocking actions: **Block**, **Create Record**, **Update Record**, **Delete
  Record**, and **Deactivate Record**. A write action can write one record or a
  set of rows (every filtered row of a collection, or a new record for each row).
  A fired **Block** action prevents the operation entirely and rolls back any
  pending writes; write actions run atomically in the same transaction as the
  triggering operation.
- **How the writes go out:** one record's writes are merged first (two writes of
  the same record become one; an update and a delete become the delete; rows
  that already hold the values are skipped), then sent as creates, then updates,
  then deletes, grouped per table and in bulk where the table supports it. A
  failed write names what failed, for example `Update contact (action "Stop bulk
  email"): …` or, for a bulk request, `UpdateMultiple contact: …`. See *Runtime
  Enforcement*.

## On form (client form library)

- **What triggers it:** the form loading, or a field on the form changing, matching
  the rule's **On form** trigger.
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

### Enforcing: Apply to records, Runs, and `asx_ApplyRules`

The **enforcing** on-demand path, for actually applying an On demand rule rather
than previewing it: the **Apply to records** tab of the **Run** dialog (opened from
the Rule Builder's **Run** menu or the hub's **Run now** button), the **Runs**
dialog, and the `asx_ApplyRules` / `asx_ProcessRunPage` Custom APIs a script or
flow can call directly. See *Running Rules On Demand* for the full picture.

- **What triggers it:** a **Rule Run**, started with **Apply to records**, that
  the rule's **Runs for** setting scopes to either the records you choose
  (**Records it's given**) or **every record that matches the rule's Only if
  conditions** (**All records that match “Only if”**, read a page at a time). A
  caller can also invoke `asx_ApplyRules` directly against a single record.
- **What actions it can apply:** the full server action set, like *On create /
  update / delete* below. `asx_ApplyRules` throws on a fired **Block**, applying no
  writes; otherwise every fired write action is applied inside the call's
  transaction. In a **Rule Run** (what Apply to records starts), a record that fires a
  Block gets no writes and is counted Blocked rather than thrown, so the run goes
  on; the records of one page share a transaction, and a write that fails rolls
  the page back, is counted Failed, and the page is processed again without that
  record.
