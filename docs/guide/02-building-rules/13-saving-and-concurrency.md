---
title: Saving & Recovery
section: Building Rules
order: 213
slug: saving-and-concurrency
---

# Saving & Recovery

## Saving

- The header shows how many edits are unsaved (for example *3 unsaved changes*) and the **Save**
  button; with nothing to save it shows **Saved**.
- There's no autosave. Edits stay local until **Save**, or until **Check for issues** or
  **Publish…** saves them.
- **Save** writes the whole rule (rule, groups, conditions, actions) in **one transaction**: a
  failure rolls all of it back.
- **The latest save wins.** If two authors change the same field, the last successful save
  overwrites the other. **Reload from server** (header **More actions** (⋯) menu) discards your
  edits and loads the current version.

## Undo and recovery

- **Undo** (Ctrl+Z) and **Redo** (Ctrl+Y) cover the last 100 edits, including a deleted group and
  everything in it. A save or reload starts a new history.
- Deleting a condition, group, outcome or action shows a message (for example *Condition deleted*)
  with **Undo**.
- **Unsaved edits survive a page reload** in the same browser tab. A bar reads *Unsaved edits from
  this tab were found.*: **Restore** brings them back (without saving), **Discard** drops them.
  If the browser blocks storage, the editor says *Browser recovery is off. Use Review changes
  before leaving.*
- **Review changes** (**More actions** menu) lists pending changes, with **Copy changes** to keep
  a copy before reloading.

## Editing a published rule

**Edit rule** opens the rule's **working draft**. Save it as often as you like: the published
version keeps enforcing until you **Publish…** the draft. A publish that fails leaves the live
version as it was. Changes to a shared data model reach a published rule only when it's
republished.

In the **Published vN** group of the **More actions** menu:

| Command | Does |
|---|---|
| **View published** | Shows the live version, data model included, read-only; the status reads **Viewing live vN**. **Back to draft** returns, keeping unsaved edits |
| **Restore published to draft…** | Replaces the draft, saved and unsaved changes, with the live version (after a confirmation). It gets a private copy of the data model, so other rules aren't affected |
| **Discard draft…** | Deletes the draft: *This deletes the draft, including saved and unsaved edits. vN stays live and unchanged.* **Discard draft** confirms, and the live rule reopens read-only with **Edit rule** |

**Unpublish…** stops enforcement; you don't need it to edit.

A rule that isn't live (**Not live · vN**) with no draft open shows **Publish…** as the main button,
with **Edit rule** beside it. **Publish…** opens the draft and goes straight to save, check and
confirm (*Validating & Publishing*).

API callers must open the working draft before editing; direct changes to published rows are
refused.
