---
title: Data Updates
section: Administering
order: 307
slug: data-updates
---

# Data Updates

Some releases change how rules are stored, so the rules you already have must be converted once. The
release ships that conversion as a numbered **data update**. Most releases carry none.

A data update is applied from the Rule Builder, not on import. Importing the new solution is safe on
its own: published rules keep enforcing the whole time.

## How you see one

While an update is waiting, the Rule Builder shows a banner on the hub and in the editors:

> Update N · title must be applied before rules can be edited.

## Who can apply it

A **System Administrator** or **System Customizer** sees an **Apply now** button in the banner. The
shipped Rules Engine Author and Reader roles can't apply an update. See *Security Roles*.

Everyone else sees the same banner with a note to ask an administrator. For them, until the update
is applied:

- The Rule Builder is **read-only**. Rules can be opened and viewed; the controls that edit them
  are hidden, including **New rule**, **Duplicate** and **Delete**.
- **Publishing is refused:** "An administrator must apply data update N before rules can be
  published."
- Enforcement keeps working, and so do **Run now** and schedules.

## Applying an update

1. Choose **Apply now**, then confirm. The dialog says which update it will apply.
2. **Keep the tab open.** The Rule Builder drives the update in steps of up to a minute each. The
   dialog shows how many items are converted and how many failed so far. It can take a few minutes.
3. When it finishes, the dialog reports *N converted, N failed*. Choose **Close**. The page
   reloads, the banner is gone and rules are editable again.

If you close the tab part way, nothing is lost: the update saves its position after every step.
Open the Rule Builder and choose **Apply now** again to carry on from there.

If several updates are waiting, they run in order, lowest number first.

## Completed with failures

A data update converts items one at a time. If an item can't be converted, the update records it,
skips it and carries on. When it ends with any failed item, an administrator sees a notice:

> Update N · title finished with N failed item(s).

It lists each failed item with the reason. A failed item is left as it was, and rules are editable
again. Fix the cause the reason names, then choose **Retry failed items**. The update runs again from
the start. **Dismiss** hides the notice; it comes back after an apply finishes or when you reopen the
Rule Builder. The list shows the first 50 failures.

An update whose items all fail still finishes this way, with every item listed. See
*Troubleshooting*.

## Applying updates from a pipeline

Our own deploy pipeline applies data updates automatically after it deploys the plug-in, and
reports "Up to date" when none is pending. Your pipeline or script can do the same by calling the
`asx_ApplyDataUpdates` Custom API until it reports `Done`. See *Custom APIs*.
