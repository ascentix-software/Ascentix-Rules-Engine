---
title: Editor Layout
section: Building Rules
order: 204
slug: editor-layout
screenshots:
  - file: images/02-04-editor-layout-01.png
    caption: The rule editor, showing the header actions, the Rule settings strip, the data model, and the Only if, Outcomes and Then bands.
    alt: "Rule editor for 'Order total within credit limit': breadcrumb, Save/Reload/Validate/Publish actions, a properties band (Table sample_order, Triggers, Channels All), a DATA MAP row (Orders, sample_customer, sample_orderline, sample_product), a WHEN Execution conditions zone, a WHEN Outcomes zone with an 'Outcome · Credit check' ALL·AND group and one condition, and a THEN Actions zone with a 'Block save' action."
---

# Editor Layout

The editor has four regions: the header, the **Rule settings** strip, the
data model chip, and the **Only if** / **Outcomes** / **Then** bands that
hold the rule body.

![Rule editor for "Order total within credit limit": breadcrumb, Save/Reload/Validate/Publish actions, a properties band (Table sample_order, Triggers, Channels All), a DATA MAP row (Orders, sample_customer, sample_orderline, sample_product), a WHEN Execution conditions zone, a WHEN Outcomes zone with an "Outcome · Credit check" ALL·AND group and one condition, and a THEN Actions zone with a "Block save" action.](../images/02-04-editor-layout-01.png)

## Header

A **breadcrumb** back to the hub, the rule's **name** (with a **Rename rule**
pencil while you can edit it), a status pill showing where the rule is in its
lifecycle, and the header actions.

The status pill reads:

- **Live · vN**: version N is published and enforcing.
- **Not live · vN**: version N was published, then unpublished.
- **Editing draft**: shown next to the live pill while a draft of a
  published rule is open, with the number of unsaved changes.
- **Draft**: a rule that has never been published (next to **Not live**).
- **Viewing live vN**: you are looking at the frozen published version
  (read-only).
- **Archived**.

The header actions, left to right (actions that don't apply aren't shown):

- **Undo** / **Redo** (Ctrl+Z / Ctrl+Y): step back and forward through your
  edits in a draft.
- The **issues** button: shows the count of errors and warnings once there are
  any, and opens the **Issues** drawer. See *Validating & Publishing*.
- **Run**: preview the live version on a record, apply it to records, or view
  its runs. Not shown for a rule that has never been published. See *Running
  Rules On Demand*.
- **Save**: writes draft changes to the server while any published revision
  stays active. With nothing to save it shows a **Saved** status instead.
- The one primary action, which depends on the state:
  - **Edit rule** (live rule): creates or reopens a working draft while the
    published rule stays active.
  - **Publish…** (draft): saves, checks the draft and, if it has no errors,
    makes it the next published revision.
  - **Back to draft** (viewing the published version): returns to the
    editable draft.
- **More actions** (⋯):
  - **Review changes**: lists what differs from the saved version.
  - **Check for issues**: saves and runs the rule through the validator
    without publishing.
  - A **Published vN** group with **View published** (switches to the frozen
    definition) and **Restore published to draft…** (replaces draft changes
    after confirmation, without changing enforcement).
  - **Reload from server**: discards in-memory edits and re-fetches the rule
    from the server.
  - **Unpublish…**: explicitly stops enforcement.

Confirmations such as *Saved*, *No issues found* and *vN is live* appear as
short toast messages. See *Validating & Publishing* for what those checks
cover.

## Rule settings strip

The **Rule settings** strip summarizes the rule's table, triggers, schedule
and channels in one line. Click it (or press Enter on it) to open the rule's
settings in the side panel, the same panel the condition and action
inspectors use: on wide viewports it's docked alongside the editor and shows
the rule settings whenever nothing else is selected, and on narrow viewports
it opens as an overlay.

> The rule settings panel has three sections. **When it runs** holds the
> table, **Triggers**, **Also run on update when these change** (trigger
> columns), **Channels** and, for On demand rules, the **On demand** card.
> **Active period** holds **Starts** / **Ends**. **Evaluation** holds **Run
> as** and **Rule time zone**. See *Creating a New Rule* for trigger columns
> and *Evaluation Context* for what **Run as** controls.

## Data model

Next to the strip, the data model chip shows the rule's root table and how
many related tables its data model has. Click it to see the table-config
tree: the root table and any lookup/child nodes reachable from it. An **Edit
data model** link opens the tree for editing. See *Table Configuration Tree*
for how the tree is built and extended.

## Only if, Outcomes and Then

The rule body is organized into three bands:

- **Only if**: gates whether the rule is evaluated at all. Add groups with
  **Add group**.
- **Outcomes**: the validation condition groups (AND/OR trees) checked at
  save time. Each top-level group is a named **outcome**, true or false; add
  one with **Add outcome**. Each action's **When** section tests these
  outcomes.
- **Then**: the actions the rule performs, run in order. Add one with **Add
  action**. Each fires when its **When** section holds.

See *Building Conditions* and *Building Actions* for how to build out each of these bands.
