---
title: Validating & Publishing
section: Building Rules
order: 212
slug: validating-and-publishing
screenshots:
  - file: images/02-12-validating-and-publishing-01.png
    caption: Check for issues lists every issue, and errors block publishing. Here a condition's column doesn't exist.
    alt: "The Issues drawer for “Draft: order contact tier check (needs work)”: Must fix to publish · 1, “Gold tier › sample_tier: Column 'sample_tier' does not exist on 'sample_customer'” (META_COLUMN_NOT_FOUND); the condition row carries an error icon."
  - file: images/02-12-validating-and-publishing-02.png
    caption: When a rule is valid, Publish… checks it, finds no errors, and asks you to confirm.
    alt: "The Publish v1? dialog: “Order total within credit limit will start running for new evaluations.”, No errors, a note that it includes this rule's copy of the shared data model, and Cancel and Publish v1."
  - file: images/02-12-validating-and-publishing-03.png
    caption: Preview on a record runs the rule against a real record without saving anything, and says what would happen.
    alt: "The Run dialog's Preview on a record tab for “Order contact email must be valid”: a record with an invalid email, As if On form, the verdict “Save would be held: 1 field message holds the save until it clears. Shows 1 message on the form.”, the Valid email outcome as false, and Show message Fired with “Enter a valid email address.” on Contact Email."
---

# Validating & Publishing

A **Draft** rule becomes **Published** only if it validates cleanly.

- **Check for issues** (header **More actions** (⋯) menu) saves any edits, then validates. It shows
  *No issues found*, or opens the **Issues** drawer.
- **Publish…** saves and checks too (the button reads **Checking…**), so publishing always
  validates the current saved rule, including shared data models.
- A published rule keeps running while you edit and save its draft, until you publish the draft.
  See *Saving & Recovery*.

## What's checked

Every issue is collected, not just the first.

| Layer | Checks |
|---|---|
| **Structural** | The rule has a condition and an action, no group is empty, and every condition and action has its required fields |
| **Traversal** | Every node a condition or action uses exists in the rule's tree and is reachable, and nodes that must be a single record are (such as the node of an **another column** comparison) |
| **Metadata** | Every table and column exists and can be read, created or updated as its use needs (a Create Record target must be creatable) |

These report **errors**, which block publishing. **Warnings** don't block, for example a Row Count
minimum that can never pass at Create (`STRUCT_ROWCOUNT_ON_CREATE`).

## The Issues drawer

After a check finds issues, the header shows an issues button with the counts (for example **2
errors**). The drawer lists errors under **Must fix to publish** and warnings under **Warnings**,
each with its message, code and the field it applies to; select one to go there. After an edit it says *You've edited since this check. Results may be out of
date.* Errors also show an icon on the row.

While you build, incomplete items say what to do next, for example *Choose a column to compare.*
or *Enter a value to compare against.*

**`HINT_ACTION_NEVER_RUNS`** (warning) flags an active action that can't run under the rule's
triggers (*Building Actions*):

- A message or field change without **On form** or **On demand**: *This action only works on the
  form. Add On form to the triggers, or choose another type.*
- A write action without a save trigger or **On demand**: *This action only runs when a record is
  saved or run on demand. Add On create, On update, On delete or On demand to the triggers, or
  choose another type.*

Below, a condition's **Column** doesn't exist on its table (`META_COLUMN_NOT_FOUND`).

![The Issues drawer for “Draft: order contact tier check (needs work)”: Must fix to publish · 1, “Gold tier › sample_tier: Column 'sample_tier' does not exist on 'sample_customer'” (META_COLUMN_NOT_FOUND); the condition row carries an error icon.](../images/02-12-validating-and-publishing-01.png)

### Outcome and Fires when checks

| Code | Message |
|---|---|
| `OUTCOME_UNNAMED` | "Name this outcome." |
| `OUTCOME_DUPLICATE_NAME` | "Another outcome is already named "<name>"." (ignoring case) |
| `ACTION_NO_TREE` | "Choose when this action fires." (its **When** isn't set) |
| `ACTION_TEST_UNKNOWN_OUTCOME` | "A test in "Fires when" refers to an outcome this rule doesn't have." |
| `ACTION_EMPTY_GROUP` | "A group in "Fires when" has no tests or groups." An empty root **All** group is fine: it means "Always, when the rule runs" |
| `OUTCOME_UNUSED` (warning) | "No active action uses this outcome. It is still evaluated and reported." |

### Set-action checks

These apply to Update, Delete or Deactivate Record on a collection, and Create Record **For each row
of** one. All are errors.

| Code | Meaning |
|---|---|
| `STRUCT_ACTION_FILTER_TARGET` | A Rows filter must filter the action's own target rows, and only a set action can have one |
| `STRUCT_ROW_SOURCE_NOT_SET` | **Current row** (a `row` mapping, or a `{row.<column>}` token in a message, its translations, or a Template condition value) only works in an action that writes a set of rows |
| `STRUCT_DEACTIVATE_MAPPING` | Deactivate Record's mapping may only set **Status Reason** |
| `META_TABLE_NOT_DEACTIVATABLE` | The table has no `statecode`, or changes state through its own message (Opportunity, Case, Quote, Order and Invoice are refused) |

Columns read through **Current row** are checked for existence and readability only.

## Publishing

**Publish…** saves, checks, then opens a dialog:

- With errors: **Fix N errors to publish**, each with **Go to field**, and **Open issues**.
- Otherwise: **Publish vN?** with **No errors**, any warnings (**View**) and the changes since the
  live version (**Review**). **Publish vN** confirms, and *vN is live* appears with **View runs**.

![The Publish v1? dialog: “Order total within credit limit will start running for new evaluations.”, No errors, a note that it includes this rule's copy of the shared data model, and Cancel and Publish v1.](../images/02-12-validating-and-publishing-02.png)

Publishing creates a numbered revision and enables the rule; republishing replaces the live
revision in one step. Only **Published** rules are enforced. See *Rule Lifecycle* and *Runtime
Enforcement*.

## Previewing a rule on a record

A rule that has been published shows **Run** in the header (*Running Rules On Demand*); one that
never has shows **Preview**. **Run** (or **Preview on a record…** in **More run options**) or
**Preview** opens the **Run** dialog on **Preview on a record**:

1. Pick a **Record** (type to search, or **Advanced search…**).
2. Pick **As if**: one of the rule's triggers (**Created**, **Updated**, **Deleted**, **On form**,
   **Run on demand**). It starts on **On form** when the rule runs there, otherwise on its first
   trigger.
3. Pick a **Version** when editing a live rule's draft: **Draft** (the default; the draft's saved
   rows run in place of the live rule) or **Live vN**. A rule that isn't published previews its
   draft only. With unsaved edits it says *Previews the saved draft. Save to include your latest
   edits.*
4. Click **Run preview**. Nothing is saved; it's the same evaluation as `asx_RunRules` (*Custom
   APIs*).

| Verdict | Means |
|---|---|
| **Save would be blocked** | A Block fired, from this rule or another on the record. Shows its message and "Nothing would be written."; this rule's writes show **Skipped, blocked** |
| **Save would be held** | **On form** only: a field message holds the save until it clears ("1 field message holds the save until it clears.") |
| **Save would go through** | With what the form would show ("Shows 2 messages on the form. Changes 1 field on the form.") or, for a save or on-demand trigger, the messages returned ("Returns 2 messages.") and "Change set: …" or "Nothing would be written." |
| **Nothing would happen** | "No action of this rule fired.", or only actions that don't run on that trigger fired, with what to change ("3 messages fired, but messages only show on the form. Add On form to the rule's triggers to show them." or "Choose As if On form to see them."). Writes previewed **As if On form** say they run on save or on demand |

![The Run dialog's Preview on a record tab for “Order contact email must be valid”: a record with an invalid email, As if On form, the verdict “Save would be held: 1 field message holds the save until it clears. Shows 1 message on the form.”, the Valid email outcome as false, and Show message Fired with “Enter a valid email address.” on Contact Email.](../images/02-12-validating-and-publishing-03.png)

Below the verdict:

- **OUTCOMES** lists each outcome as true or false (none if **Only if** held the rule back).
- Every action, in order, is marked **Fired**, **Didn't fire**, **Skipped, blocked**, **Form only**
  (a message or field change when previewing a save) or **Not on the form** (a write when
  previewing **On form**). Fired messages show text, placement and severity; field changes say what
  they do ("Shows Budget", "Hides Budget", "Makes Budget required", "Makes Budget optional"); writes
  expand to the rows they'd write.
- If other rules fired, "2 other rules also fired on this record." lets you show them.
