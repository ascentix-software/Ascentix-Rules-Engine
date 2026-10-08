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

Publishing is **gated** on validity: a **Draft** rule only becomes
**Published** if it validates cleanly. **Check for issues**, in the header's
**More actions** (⋯) menu, reports what is standing in the way.

When there are unsaved edits, **Check for issues** first saves the Draft, then
validates the persisted result. If nothing is wrong, a *No issues found* message
appears; otherwise the **Issues** drawer opens. Published rules remain active while
you edit and save their draft. Check the draft, then **Publish…** to replace the live
revision. **Publish…** itself saves and checks first (the button reads **Checking…**
meanwhile), so publication always revalidates the current saved configuration,
including shared data models. Changes since a previous check do not block publication
when the current definition is valid. See *Saving & Recovery*.

## Validation layers

Validation runs three layers of checks, in order, collecting every issue
found rather than stopping at the first one:

- **Structural**, the rule's basic shape: it has at least one condition
  and one action, no condition group is empty, and every condition/action
  has the fields its type requires.
- **Traversal integrity**: every table-config node a condition or action
  points at exists in the rule's tree and is reachable from the root, and
  single-cardinality requirements (like the node of an **another column** comparison)
  are respected.
- **Metadata-aware**: every referenced table and column actually exists,
  and is creatable, updatable, or readable as needed for how it's used
  (for example, a Create Record mapping target must be creatable; a
  comparison column must be readable).

All three layers report **errors**, which block publishing. Issues can also
carry a **Warning** severity, which is advisory and does not block: a Row
Count minimum that can never pass at Create (`STRUCT_ROWCOUNT_ON_CREATE`).

## Reading the Issues drawer

Once a check has found issues, the header shows an issues button with the
error count (and a warning count), for example **2 errors**. It opens the
**Issues** drawer, which lists errors under **Must fix to publish** and
warnings under **Warnings** (warnings don't block publishing). Each issue
shows a human-readable **message**, its **code**, and the **field or node**
it applies to; select one to go to that field. **Check again** re-runs the
check. If you edit after a check, the drawer says *You've edited since this
check. Results may be out of date.* Errors are also marked **inline** with an
issue icon on the offending row.

The editor also flags incomplete items as you build, worded as the next
step to take, for example *Choose a column to compare.* or *Enter a value to
compare against.*

It also warns, under **Warnings**, about an active action whose type does
nothing under the rule's triggers (`HINT_ACTION_NEVER_RUNS`; see *Building
Actions*). A message or field change on a rule without **On form** or **On
demand** reads *This action only works on the form. Add On form to the
triggers, or choose another type.* A write action on a rule without a save
trigger or **On demand** reads *This action only runs when a record is saved
or run on demand. Add On create, On update, On delete or On demand to the
triggers, or choose another type.* Like any warning, it doesn't block
publishing.

Below, a condition's **Column** references a column that doesn't exist on its
table, raising a `META_COLUMN_NOT_FOUND` error.

## Outcome and Fires when checks

Outcomes (the top-level validation groups) and each action's Fires when condition (its **When**
section) get their own checks:

- **`OUTCOME_UNNAMED`** (error): "Name this outcome."
- **`OUTCOME_DUPLICATE_NAME`** (error): "Another outcome is already named "<name>"." Names are
  compared ignoring upper and lower case.
- **`ACTION_NO_TREE`** (error): "Choose when this action fires." The action's **When** section is
  not set.
- **`ACTION_TEST_UNKNOWN_OUTCOME`** (error): "A test in "Fires when" refers to an outcome this
  rule doesn't have."
- **`ACTION_EMPTY_GROUP`** (error): "A group in "Fires when" has no tests or groups." An empty
  root **All** group is fine; it means "Always, when the rule runs".
- **`OUTCOME_UNUSED`** (warning): "No active action uses this outcome. It is still evaluated and
  reported." Only active actions count, so an outcome tested only by an inactive action gets it
  too. It does not block publishing.

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

![The Issues drawer for “Draft: order contact tier check (needs work)”: Must fix to publish · 1, “Gold tier › sample_tier: Column 'sample_tier' does not exist on 'sample_customer'” (META_COLUMN_NOT_FOUND); the condition row carries an error icon.](../images/02-12-validating-and-publishing-01.png)

Once every issue is resolved, **Check for issues** shows **No issues found**
and **Publish…** can go ahead.

## The Publish dialog

**Publish…** saves the draft, checks it, and then opens a dialog:

- If there are errors, the dialog is titled **Fix N errors to publish** and
  lists them, each with a **Go to field** link; **Open issues** opens the
  **Issues** drawer.
- Otherwise it is titled **Publish vN?**, notes **No errors**, any warnings
  (with **View**), and how many changes there are since the live version
  (with **Review**). Confirm with **Publish vN**. A *vN is live* message then
  confirms the publish, with a **View runs** link.

![The Publish v1? dialog: “Order total within credit limit will start running for new evaluations.”, No errors, a note that it includes this rule's copy of the shared data model, and Cancel and Publish v1.](../images/02-12-validating-and-publishing-02.png)

## Publishing is enforced

Publishing creates a numbered revision and enables the rule. Republishing a live
rule atomically replaces its active revision. Only
**Published** rules are enforced at runtime; a Draft rule, however valid,
doesn't run. See *Rule Lifecycle* for the full Draft/Published/Archived
flow, and *Runtime Enforcement* for how a published rule's actions are
actually applied.

## Testing a rule against a record

Once a rule has been published, the header shows a **Run** button (*Running Rules On Demand*),
whether or not it's currently live. A rule that has never been published shows a plain
**Preview** button instead. Clicking **Run** (or **Preview on a record…** in its **More run
options** menu) or **Preview** opens the **Run** dialog on its **Preview on a record** tab. Pick
a **Record** (type to search, or choose **Advanced search…**) and an **As if** trigger, then
click **Run preview**. It reports what would fire — the same report-only, nothing-is-saved
evaluation as `asx_RunRules`. See *Custom APIs* → `asx_RunRules` for the underlying report
shape, including the `ChangeSet` summary the preview renders for set actions.

- **As if** offers the rule's triggers (**Created**, **Updated**, **Deleted**, **On form**, **Run
  on demand**). It starts on **On form** when the rule runs on the form, where messages and field
  changes show, and otherwise on the rule's first trigger.
- **Version** chooses what runs: **Live vN** (the published version) or **Draft** (the draft's
  saved rows, run in place of the live rule). It appears while you're editing the draft of a live
  rule, and starts on **Draft**; a live rule with no draft open previews its live version.
  **Live vN** is offered only while the rule is published: a rule that has never been published,
  or has been unpublished, previews its draft only, with no switch. Previewing the draft runs what is saved, so with unsaved edits the dialog says
  *Previews the saved draft. Save to include your latest edits.*

The result opens with a verdict:

- **Save would be blocked**: a Block fired on the record, from this rule or another rule on the
  same record. It shows the Block's message and "Nothing would be written.", and this rule's write
  actions show **Skipped, blocked**.
- **Save would be held** (**As if** **On form** only): a message on a field holds the form's save
  until it clears, for example "1 field message holds the save until it clears."
- **Save would go through**: with how many messages and field changes the form would show (for
  example "Shows 2 messages on the form. Changes 1 field on the form."), or, for a save or
  on-demand trigger, the messages returned (**Run on demand**: "Returns 2 messages.") and a
  summary of what would be written ("Change set: …") or "Nothing would be written."
- **Nothing would happen**, with the reason: "No action of this rule fired.", or only actions
  that don't run on that trigger fired. When only messages or field changes fired on a save
  trigger, it says so and what to change, for example "3 messages fired, but messages only show
  on the form. Add On form to the rule's triggers to show them." (or, when the rule already runs
  on the form, "Choose As if On form to see them."). When only write actions fired **As if On
  form**, it says they run when a record is saved or run on demand, not on the form.

![The Run dialog's Preview on a record tab for “Order contact email must be valid”: a record with an invalid email, As if On form, the verdict “Save would be held: 1 field message holds the save until it clears. Shows 1 message on the form.”, the Valid email outcome as false, and Show message Fired with “Enter a valid email address.” on Contact Email.](../images/02-12-validating-and-publishing-03.png)

Below the verdict, **OUTCOMES** lists this rule's outcomes, each with a tick or cross icon (true
or false). The values are those of the normal run; a rule held back by its **Only if** conditions
reports none. Then every action of the rule is listed in rule order, marked **Fired**, **Didn't
fire**, **Skipped, blocked**, **Form only** (a message or field change when previewing a save) or
**Not on the form** (a write when previewing **On form**). A fired message shows its text, where it
appears (on a field, or as a banner) and its severity; a fired field change says what it does
("Shows Budget", "Hides Budget", "Makes Budget required" or "Makes Budget optional"); a fired
Block shows its message; a fired write action expands to show the rows it would write. If
other rules fired too, a line such as "2 other rules also fired on this record." lets you show
them.
