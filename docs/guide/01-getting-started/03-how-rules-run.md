---
title: How Rules Run
section: Getting Started
order: 103
slug: how-rules-run
---

# How Rules Run

A rule evaluates the same way everywhere: same conditions, same data model. What differs is what
starts it and which actions take effect.

| Started by | Trigger | Actions that take effect |
|---|---|---|
| A create, update or delete on the rule's table | **On create**, **On update**, **On delete** | All server actions, including **Block** and the write actions |
| The form loading or a field changing | **On form** | **Set Visible**, **Set Required**, **Show Message** |
| `asx_RunRules` (a preview) | **On demand** by default | None: every fired action is reported, nothing is written |
| **Apply to records**, a **Rule Run**, or `asx_ApplyRules` | **On demand** | All server actions |

**On demand** was labelled **Manual** before this release. The stored value is unchanged, and the
API accepts both `Manual` and `OnDemand`.

## On create, update or delete

The engine runs inside the save, in the same transaction.

- A fired **Block** stops the save and rolls back any pending writes.
- **Create Record**, **Update Record**, **Delete Record** and **Deactivate Record** can write one
  record or a set of rows (every filtered row of a collection, or a new record per row).
- Writes to the same record are merged (an update and a delete become the delete; rows that already
  hold the values are skipped), then sent as creates, then updates, then deletes, in bulk where the
  table allows it.
- A failed write names what failed, for example `Update contact (action "Stop bulk email"): …` or,
  for a bulk request, `UpdateMultiple contact: …`. See *Runtime Enforcement*.

## On form

The form library applies **Set Visible**, **Set Required** and **Show Message** live. Block and the
write actions on the same rule are evaluated but not run from the form; the server enforces them
when the record is saved.

## On demand

### Preview: `asx_RunRules`

Checks what a rule would do, without changing data. The caller passes a table and an existing
record id, unsaved field values as JSON, or both. It can also pass a draft rule's id to run that
draft in place of its live rule; that's how the Rule Builder previews a draft.

It never enforces: a fired **Block** is reported, not thrown, and writes are described, not made.

### Apply: Apply to records, Rule Runs and `asx_ApplyRules`

- **Apply to records** (the **Run** dialog, from the Rule Builder's **Run** menu or the hub's
  **Run now**) starts a **Rule Run**. The rule's **Runs for** setting decides whether it acts on the
  records you choose or on every record that passes **Only if**.
- In a Rule Run, a record that fires **Block** gets no writes and is counted **Blocked**; the run
  carries on. A page of records shares one transaction: a failed write rolls the page back, that
  record is counted **Failed**, and the page runs again without it.
- `asx_ApplyRules` applies a rule to one record. A fired **Block** throws and nothing is written;
  otherwise every write is applied in the call's transaction.

See *Running Rules On Demand*.
