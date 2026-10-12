---
title: Rule Lifecycle
section: Getting Started
order: 105
slug: rule-lifecycle
---

# Rule Lifecycle

A rule's **status** decides whether it runs; an optional **active period** decides when.

## Status

| Status | Enforced? |
|---|---|
| **Draft** | Never. Every new rule starts here. |
| **Published** | Yes, within its active period. It must pass the publish check first (*Validating & Publishing*). |
| **Archived** | Never. Kept for history. |

The pill under the rule's name shows **Live · vN**, **Draft** (never published) or **Archived**,
plus **Editing draft** while you work on a published rule's draft (*Editor Layout*).

## Drafts and published versions

- Every rule has an editable draft. Saving a published rule's draft leaves the live version
  running.
- **Publish…** captures the draft, with its own copy of the data model, as a new version. A change
  to a shared data model reaches each rule only when that rule is republished. Business records and
  the caller's permissions are always read live.
- **Discard draft…** (⋯ menu) deletes the draft and its edits; the live version is unchanged.
- An unpublished rule keeps its last version. To bring it back, open it and choose **Publish…**.
- **View published** shows what's live. A form that's already open keeps the version it loaded;
  reload it to pick up a new one.

See *Saving & Recovery*.

## Active period

In the rule settings, **Active period**:

- **Starts** (Effective From): not enforced before this time.
- **Ends** (Effective To): not enforced after this exact time (not the end of that day).

Both are optional; an empty one reads **No start limit** or **No end limit**. Both are stored in
**UTC** and take effect when the rule is published.

The editor takes a date and time to the second. **Show times in** defaults to **UTC**; **Local**
uses your browser's time zone without changing the stored times. Around a daylight-saving change,
enter the time in UTC to be exact.
