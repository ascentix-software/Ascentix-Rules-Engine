---
title: Editor Layout
section: Building Rules
order: 204
slug: editor-layout
screenshots:
  - file: images/02-04-editor-layout-01.png
    caption: The rule editor, showing the header actions, the Rule settings strip, the data model, and the Only if, Outcomes and Then bands.
    alt: "The rule editor for “Order total within credit limit”: Not live and Draft pills, Undo, Redo, Preview, Saved, Publish… and More actions; the Rule settings strip (Order · On create, On form, On update · All channels); the Orders data model chip; an Only if group “Has a customer”; a Credit check outcome; and a Then band with a Block save action; Rule settings open on the right."
---

# Editor Layout

The editor has a header, the **Rule settings** strip, the data model chip, and three bands that
hold the rule: **Only if**, **Outcomes** and **Then**.

![The rule editor for “Order total within credit limit”: Not live and Draft pills, Undo, Redo, Preview, Saved, Publish… and More actions; the Rule settings strip (Order · On create, On form, On update · All channels); the Orders data model chip; an Only if group “Has a customer”; a Credit check outcome; and a Then band with a Block save action; Rule settings open on the right.](../images/02-04-editor-layout-01.png)

## Header

A breadcrumb back to the hub, the rule's name (**Rename rule** while you can edit it), a status
pill, and the actions.

| Status pill | Meaning |
|---|---|
| **Live · vN** | Version N is published and enforcing. |
| **Not live · vN** | Version N was published, then unpublished. |
| **Editing draft** | A draft of a published rule is open (with its unsaved change count). |
| **Draft** | Never published (shown with **Not live**). |
| **Viewing live vN** | The published version, read-only. |
| **Archived** | Retired; never enforced. |

Actions, left to right (only the ones that apply are shown):

| Action | Does |
|---|---|
| **Undo** / **Redo** | Steps through your edits (Ctrl+Z / Ctrl+Y). |
| Issues button | Shows the error and warning count and opens the **Issues** drawer (*Validating & Publishing*). |
| **Run** | Previews the rule on a record, applies the live version to records, or shows its runs. A never-published rule shows **Preview** instead (*Running Rules On Demand*). |
| **Save** | Saves the draft; the published version keeps enforcing. Shows **Saved** when there's nothing to save. |
| **Edit rule** | On a live rule: opens its working draft. |
| **Publish…** | On a draft: saves, checks, and publishes it as the next version. On a rule that isn't live with no draft open, it sits beside **Edit rule**. |
| **Back to draft** | While viewing the published version: returns to the draft. |
| **More actions** (⋯) | **Review changes**, **Check for issues**, the **Published vN** group (**View published**, **Restore published to draft…**, **Discard draft…**), **Reload from server**, **Unpublish…**. |

**Check for issues** saves and validates without publishing. **Restore published to draft…**
replaces the draft's changes; **Discard draft…** deletes the draft and reopens the live rule. Neither
changes what's enforcing. **Reload from server** drops unsaved edits.

## Rule settings strip

The strip sums up the rule's table, triggers, schedule and channels. Click it to open **Rule
settings** in the side panel (docked on wide screens, an overlay on narrow ones). It has three
sections:

- **When it runs**: the table, **Triggers**, **Also run on update when these change** (*Creating a
  New Rule*), **Channels**, and for On demand rules the **On demand** card.
- **Active period**: **Starts** and **Ends**.
- **Evaluation**: **Run as** (*Evaluation Context*) and **Rule time zone**.

## Data model

The chip beside the strip shows the root table and how many related tables the model reaches. Click
it to see the tree; **Edit data model** opens it for editing (*Table Configuration Tree*).

## Only if, Outcomes and Then

| Band | Holds |
|---|---|
| **Only if** | Conditions that decide whether the rule runs at all. **Add group**. |
| **Outcomes** | Named condition groups, each true or false. **Add outcome**. |
| **Then** | Actions, run in order. Each fires when its **When** test on the outcomes holds. **Add action**. |

See *Building Conditions* and *Building Actions*.
