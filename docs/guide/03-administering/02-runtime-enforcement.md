---
title: Runtime Enforcement
section: Administering
order: 302
slug: runtime-enforcement
---

# Runtime Enforcement

What a fired rule does depends on the **action type** and **where it ran**.

## Severity doesn't block

Severity (**Information**, **Warning**, **Error**) sets how a message is shown. Only a fired
**Block** action stops a save, at any severity: a Warning Block blocks exactly like an Error one. On
the server, a **Show Message** never blocks. On a form, a field-targeted Show Message does (see *On
a form* below).

## On create, update and delete (server)

This is the enforcement that counts: it covers every save, from forms, the Web API, integrations and
imports.

- Every matching rule is evaluated and its fired actions are collected.
- **Block wins.** If any Block fires, on any rule, the save fails before anything is written. None of
  the fired write actions (Create, Update, Delete or Deactivate Record, on one record or a set) are
  applied.
- Otherwise the fired writes are applied in the save's own transaction. A write that fails rolls the
  whole save back.
- Writes made by rules don't trigger further rules.
- **On Delete** works the same way: a Block stops the delete and the row stays.
- **Channels** apply (*Triggers & Channels*): a Power Pages save is **Portal**, everything else is
  **Standard**.

### How writes go out

As *Building Actions* → *Writing a set of rows* describes:

- Two writes of the same record (in the same evaluation context) merge into one, the later action
  winning per column. An update and a delete of the same record become the delete.
- A row that already holds the values is skipped, so saving again with nothing changed writes
  nothing.
- An update of the record being saved is applied to it in place, as part of the save.
- The rest go out as creates, then updates, then deletes, grouped by table. Two or more creates or
  updates of one table go as one `CreateMultiple` / `UpdateMultiple` where the table supports it.
  Deletes go one at a time.

### Error messages

A failed write names what failed:

- A single write: `Update contact (action "Stop bulk email"): <error>` (the action's id if it has no
  name).
- A bulk write: `UpdateMultiple contact: <error>`, since it carries rows from several actions.

A Rule Run records the same text for a Failed record.

A blocked save lists every fired Block message, across all rules, once each:

```
This record could not be saved:
 • Name must be Valid.
 • Amount must be positive.
```

A Block with no message shows a default one. A bulk operation checks every record and fails once,
listing each failing record's id and messages.

## On a form (client)

The form library gives early feedback. It never cancels a save itself:

| Action | On the form |
|---|---|
| Set Visible, Set Required | Applied to the field. |
| Show Message, form-level | A form notification at its severity. Doesn't block. |
| Show Message, on a field | A field notification. The platform shows these as errors, so it **stops the save** until its condition stops matching, whatever its severity. Use a form-level message for advice. |
| Block, on a field | A field notification. The platform's own field validation stops the save. |
| Block, form-level | A form banner. |

Saves that don't go through a form (imports, API calls, integrations) are still enforced by the
server.

## On demand

| Called through | Enforces? |
|---|---|
| `asx_RunRules` | **No.** Nothing is blocked or written. Fired actions come back as data: `IsValid` is `true` only when no Block fired, and `FailedRuleCount` counts the rules that fired one. |
| `asx_ApplyRules` | **Yes**, like a save: a Block fails the call with no writes; otherwise the fired writes are applied. |
| **Apply to records** (**Run now**) and Rule Runs | **Yes**, per record, and the run keeps going. A blocked record gets no writes and is counted **Blocked** with its message. A page of records shares one transaction: a failed write rolls the page back, that record is counted **Failed**, and the page runs again without it. |

See *How Rules Run* and *Running Rules On Demand*.
