---
title: Saving & Recovery
section: Building Rules
order: 213
slug: saving-and-concurrency
---

# Saving & Recovery

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

## Latest save wins

Saving updates the current records without rejecting an older loaded version.
If two authors change the same field, the last successful save wins. Reload to see
current server values. Restoring browser recovery follows the same behavior.
Saving remains atomic: a failed operation rolls back the entire changeset.

## Editing a published rule

Choose **Edit rule** on a published rule to create or reopen its **working draft**. Save as often as needed while the last
published revision continues enforcing. **Publish** validates the saved draft and
replaces the active revision. A rejected publication leaves the active revision intact.

**View published** opens the frozen definition, including its data model, read-only.
**Back to draft** returns to your work, preserving unsaved edits. **Restore published
to draft** asks you to confirm replacing both saved and unsaved draft changes. It
creates a private copy of the published data model so other rules' shared models
are unaffected. You must publish again to change enforcement.

API callers open the working draft before editing its records. Direct changes to published configuration are rejected. Shared-model
changes affect a published rule only after that rule is republished. **Unpublish**
remains an explicit way to stop enforcement; it is not required for editing.

## No autosave

Every change stays local until you click **Save** or **Save & validate**.
