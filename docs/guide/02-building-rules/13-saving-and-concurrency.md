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

## Optimistic concurrency

Saving uses **optimistic concurrency**: if the rule was changed elsewhere
since you loaded it, your save is rejected and you're told to reload
before saving again. Your in-progress edits stay in memory; the server's
copy is untouched.

## No autosave

Every change stays local until you click **Save**.
