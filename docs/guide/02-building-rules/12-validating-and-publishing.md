---
title: Validating & Publishing
section: Building Rules
order: 212
slug: validating-and-publishing
screenshots:
  - file: images/02-12-validating-and-publishing-01.png
    caption: Validation lists every issue and blocks publishing. Here two columns don't exist, so Publish is disabled.
    alt: Rule editor showing "Validation found 2 issues" and a Validation Issues panel with two META_COLUMN_NOT_FOUND errors (a condition's ComparisonColumn and an action's TargetColumn), an inline error on the condition row, and a disabled Publish button.
  - file: images/02-12-validating-and-publishing-02.png
    caption: When a rule is valid, validation passes and Publish becomes available.
    alt: Rule editor showing a green "Validation passed. The rule is valid" banner and an enabled blue Publish button on a Draft rule.
---

# Validating & Publishing

Publishing is **gated** on validity: a **Draft** rule only becomes
**Published** if it validates cleanly. **Validate** reports what is
standing in the way.

When there are unsaved edits, the button reads **Save & validate**: it first saves
the Draft, then validates the persisted result. On a clean rule it reads **Validate**.
Published rules remain active while you edit and save their draft. Validate the
draft, then **Publish** to replace the live revision. Publication revalidates the current saved
configuration, including shared data models. Changes since a previous validation
do not block publication when the current definition is valid. See *Saving & Recovery*.

## Validation layers

Validation runs three layers of checks, in order, collecting every issue
found rather than stopping at the first one:

- **Structural**, the rule's basic shape: it has at least one condition
  and one action, no condition group is empty, and every condition/action
  has the fields its type requires.
- **Traversal integrity**: every table-config node a condition or action
  points at exists in the rule's tree and is reachable from the root, and
  single-cardinality requirements (like a Field Reference right-hand node)
  are respected.
- **Metadata-aware**: every referenced table and column actually exists,
  and is creatable, updatable, or readable as needed for how it's used
  (for example, a Create Record mapping target must be creatable; a
  comparison column must be readable).

All three layers report **errors**, which block publishing. Issues can also
carry a **Warning** severity, which is advisory and does not block: a Row
Count minimum that can never pass at Create (`STRUCT_ROWCOUNT_ON_CREATE`).

## Reading the issues panel

Each issue shows a **code**, a human-readable **message**, and the
**field or node** it applies to. Errors are also marked **inline** on the
offending row.

Below, a condition's **Comparison column** and an action's **Target
column** both reference columns that no longer exist, raising two
`META_COLUMN_NOT_FOUND` errors.

## Set-action errors

A set action (Update Record, Delete Record or Deactivate Record on a collection, or Create Record
creating **For each row of** one) adds a few checks of its own, all Error severity:

- **`STRUCT_ACTION_FILTER_TARGET`**: a Rows filter must filter the action's own target rows, and
  only a set action can have a Rows filter at all.
- **`STRUCT_ROW_SOURCE_NOT_SET`**: the **Current row** source — a field mapping's `row` source, or
  a `{row.<column>}` token anywhere it can appear (a Show Message/Block message, one of its
  per-language translations, or a Template condition's comparison value) — can only be used by an
  action that writes a set of rows.
- **`STRUCT_DEACTIVATE_MAPPING`**: Deactivate Record's field mapping may only set **Status
  Reason**; any other mapped column is refused.
- **`META_TABLE_NOT_DEACTIVATABLE`**: Deactivate Record's target table can't be deactivated by a
  rule — either it has no `statecode`, or it changes state only through its own dedicated message
  (Opportunity, Case, Quote, Order and Invoice are refused outright).

A set action's **row-source columns** (the columns a `row` mapping or a `{row.…}` token reads) are
checked only for existence and readability, the same as any other read; type compatibility with
the target is the editor's own picker and the resolver's concern, not validation's.

![Rule editor showing "Validation found 2 issues" and a Validation Issues panel with two META_COLUMN_NOT_FOUND errors (a condition's ComparisonColumn and an action's TargetColumn), an inline error on the condition row, and a disabled Publish button.](../images/02-12-validating-and-publishing-01.png)

Once every issue is resolved, Validate shows a green **"Validation
passed. The rule is valid"** banner and **Publish** becomes available.

![Rule editor showing a green "Validation passed. The rule is valid" banner and an enabled blue Publish button on a Draft rule.](../images/02-12-validating-and-publishing-02.png)

## Publishing is enforced

Publishing creates a numbered revision and enables the rule. Republishing a live
rule atomically replaces its active revision. Only
**Published** rules are enforced at runtime; a Draft rule, however valid,
doesn't run. See *Rule Lifecycle* for the full Draft/Published/Archived
flow, and *Runtime Enforcement* for how a published rule's actions are
actually applied.

## Testing a published rule against a record

Once a rule has a published revision, a **Test** button appears in the toolbar — the same
condition as **Runs** (*Running Rules On Demand*): whenever the rule has ever been published,
whether or not it's currently Published or has unsaved Draft edits. Test opens a dialog to pick a
record and an **Evaluate as** trigger, then reports what would fire — the same report-only,
nothing-is-saved evaluation as `asx_RunRules`, always against the **published** version of the
rule, never the unsaved draft you're looking at. See *Custom APIs* → `asx_RunRules` for the
underlying report shape, including the `ChangeSet` summary Test renders for set actions.
