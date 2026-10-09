---
title: Data Updates
section: Administering
order: 307
slug: data-updates
screenshots:
  - file: images/03-07-data-updates-01.png
    caption: While an update is waiting, the bar names it and the Rule Builder is read-only. An administrator sees Apply now.
    alt: "The hub with a yellow bar: “Read-only until Update 1 is applied. Convert action conditions to outcomes”, an info tip and Apply now. New rule and each row's Duplicate and Delete are hidden."
  - file: images/03-07-data-updates-02.png
    caption: Apply now asks you to confirm and names the update it will apply.
    alt: "The Apply update 1? dialog: “Convert action conditions to outcomes. This converts existing rules for this release. It can take a few minutes; keep this tab open until it finishes.”, with Cancel and Apply."
  - file: images/03-07-data-updates-03.png
    caption: An update that finished with failed items lists each one with the reason, and offers Retry failed items.
    alt: "The hub's notice “Update 1 · Convert action conditions to outcomes finished with 1 failed item(s).”, listing a rule id and the reason (its published version still uses On match / On no match; publish it from the Rule Builder, then Retry failed items), with Retry failed items and Dismiss. New rule is back."
---

# Data Updates

Some releases change how rules are stored, so the rules you already have must be converted once. The
release ships that conversion as a numbered **data update**. Most releases carry none, and an
update only appears where it has something to convert: a new installation never sees one.

A data update is applied from the Rule Builder, not on import. Importing the new solution is safe on
its own: published rules keep enforcing the whole time.

## How you see one

While an update is waiting, the Rule Builder shows a slim bar on the hub and in the editors,
followed by the update's title:

> Read-only until Update N is applied.

![The hub with a yellow bar: “Read-only until Update 1 is applied. Convert action conditions to outcomes”, an info tip and Apply now. New rule and each row's Duplicate and Delete are hidden.](../images/03-07-data-updates-01.png)

## Who can apply it

A **System Administrator** or **System Customizer** sees an **Apply now** button in the bar. The
shipped Rules Engine Author and Reader roles can't apply an update. See *Security Roles*.

Everyone else sees the same bar without the button; its info tip says to ask a System
Administrator or System Customizer. For them, until the update
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
   reloads, the bar is gone and rules are editable again.

![The Apply update 1? dialog: “Convert action conditions to outcomes. This converts existing rules for this release. It can take a few minutes; keep this tab open until it finishes.”, with Cancel and Apply.](../images/03-07-data-updates-02.png)

If you close the tab part way, nothing is lost: the update saves its position after every step.
Open the Rule Builder and choose **Apply now** again to carry on from there.

If several updates are waiting, they run in order, lowest number first.

## Completed with failures

A data update converts items one at a time. If an item can't be converted, the update records it,
skips it and carries on. When it ends with any failed item, an administrator sees a notice:

> Update N · title finished with N failed item(s).

![The hub's notice “Update 1 · Convert action conditions to outcomes finished with 1 failed item(s).”, listing a rule id and the reason (its published version still uses On match / On no match; publish it from the Rule Builder, then Retry failed items), with Retry failed items and Dismiss. New rule is back.](../images/03-07-data-updates-03.png)

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
