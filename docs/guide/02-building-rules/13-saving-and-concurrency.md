---
title: Saving & Concurrency
section: Building Rules
order: 213
slug: saving-and-concurrency
---

# Saving & Concurrency

## Dirty tracking

While your in-progress edits differ from what was last loaded or saved,
the header shows an **unsaved changes** indicator and the **Save** button
is enabled.

## Save is atomic

**Save** persists the entire rule graph (the rule itself, its condition
groups and conditions, and its actions) in **one atomic transaction**.

## Reload

**Reload** discards your in-memory edits and re-fetches the rule fresh
from the server, picking up any changes someone else made.

## Undo, redo, and browser recovery

**Undo** restores the previous edit, including a deleted group and its children.
**Redo** reapplies it. The editor keeps the last 100 edits; a successful save or
reload starts a new history.

Pending edits also have a recovery copy in the current browser tab. After a page
reload, choose **Restore edits** to recover them, or **Discard recovery** to remove
that copy. Restoring never saves or publishes a rule. Recovery is scoped to the
environment and rule, and lasts only for the browser tab's session. If storage is
unavailable, the editor says so. Explicitly discarding edits clears their recovery
copy.

**Review changes** shows pending operations and lets you **Copy changes** before
reloading. If clipboard access is unavailable, select and copy the text manually.

## Optimistic concurrency

Saving uses **optimistic concurrency**: if the rule was changed elsewhere
since you loaded it, your save is rejected and you're told to reload
before saving again. Your in-progress edits stay in memory; the server's
copy is untouched. Use **Review changes** to copy your pending changes, reload the
current version, and reapply the changes you still want. Recovery retains the
original version checks; restoring an old edit does not override someone else's
work.

## Editing a published rule

Published rules open **read-only** in the Rule Builder. Choose **Unpublish** and
confirm that all enforcement and automation from this rule will stop until it is
published again. You can then edit the Draft, save, validate, and publish it.
Any recovered unsaved edits stay in the editor when you unpublish.

This workflow does not create a separate revision while the original stays live.
It governs edits in the Rule Builder; direct configuration edits through classic
forms or APIs, and edits to shared table configurations, remain separate operations.

## No autosave

Every change stays local until you click **Save** or **Save & validate**.
