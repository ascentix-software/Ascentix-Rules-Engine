---
title: Saving & Recovery
section: Building Rules
order: 213
slug: saving-and-concurrency
---

# Saving & Recovery

## Dirty tracking

While your in-progress edits differ from what was last loaded or saved,
the header shows how many there are (for example, *3 unsaved changes*) next
to the status pill, and the **Save** button appears. With nothing to save,
the header shows a **Saved** status in its place.

## Save is atomic

**Save** persists the entire rule graph (the rule itself, its condition
groups and conditions, and its actions) in **one atomic transaction**.

## Reload

**Reload from server**, in the header's **More actions** (⋯) menu,
discards your in-memory edits and re-fetches the rule fresh from the
server, picking up any changes someone else made.

## Undo, redo, and browser recovery

**Undo** (Ctrl+Z) restores the previous edit, including a deleted group and its children.
**Redo** (Ctrl+Y) reapplies it. Deleting a condition, group, outcome or action also shows a
short message (for example, *Condition deleted*) with an **Undo** button. The editor keeps the last 100 edits; a successful save or
reload starts a new history.

Pending edits also have a recovery copy in the current browser tab. After a page
reload, a bar reads *Unsaved edits from this tab were found.*: choose **Restore** to
recover them, or **Discard** to remove that copy. Restoring never saves or publishes a
rule. Recovery is scoped to the environment and rule, and lasts only for the browser
tab's session. If storage is unavailable, the editor says so (*Browser recovery is off.
Use Review changes before leaving.*). Explicitly discarding edits clears their recovery
copy.

**Review changes**, in the **More actions** (⋯) menu, shows pending operations and lets
you **Copy changes** before reloading. If clipboard access is unavailable, select and copy the text manually.

## Latest save wins

Saving updates the current records without rejecting an older loaded version.
If two authors change the same field, the last successful save wins. Reload to see
current server values. Restoring browser recovery follows the same behavior.
Saving remains atomic: a failed operation rolls back the entire changeset.

## Editing a published rule

Choose **Edit rule** on a published rule to create or reopen its **working draft**. Save as often as needed while the last
published revision continues enforcing. **Publish…** saves and validates the draft and
replaces the active revision. A rejected publication leaves the active revision intact.

**View published** (in the **More actions** menu) opens the frozen definition, including its
data model, read-only; the status pill reads **Viewing live vN**. **Back to draft** returns to
your work, preserving unsaved edits. **Restore published to draft…** asks you to confirm
replacing both saved and unsaved draft changes. It
creates a private copy of the published data model so other rules' shared models
are unaffected. You must publish again to change enforcement.

**Discard draft…** (in the same **Published vN** group of the **More actions** menu) throws the
draft away instead. A **Discard this draft?** confirmation reads *This deletes the draft,
including saved and unsaved edits. vN stays live and unchanged.* Confirming with **Discard
draft** deletes the draft (through `asx_DeleteRule` on the draft) and reopens the live rule,
read-only, with **Edit rule** to start a new draft.

API callers open the working draft before editing its records. Direct changes to published configuration are rejected. Shared-model
changes affect a published rule only after that rule is republished. **Unpublish…**
remains an explicit way to stop enforcement; it is not required for editing.

To republish a rule that isn't live (the status pill reads **Not live · vN**) and has no draft
open, the header shows **Publish…** as the main button with **Edit rule** beside it.
**Publish…** opens the draft and goes straight to the usual save, check and confirm (see
*Validating & Publishing*); choose **Edit rule** instead to change the rule first.

## No autosave

Every change stays local until you click **Save**, or until **Check for issues** or
**Publish…** saves it for you.
