---
title: Editor Layout
section: Building Rules
order: 204
slug: editor-layout
screenshots:
  - file: images/02-04-editor-layout-01.png
    caption: The rule editor, showing header actions, properties band, data-map tree, and the WHEN (execution conditions and outcomes) and THEN (actions) zones.
    alt: "Rule editor for 'Order total within credit limit': breadcrumb, Save/Reload/Validate/Publish actions, a properties band (Table sample_order, Triggers, Channels All), a DATA MAP row (Orders, sample_customer, sample_orderline, sample_product), a WHEN Execution conditions zone, a WHEN Outcomes zone with an 'Outcome · Credit check' ALL·AND group and one condition, and a THEN Actions zone with a 'Block save' action."
---

# Editor Layout

The editor has four regions: the header, the properties band, the data map,
and the WHEN/THEN zones that hold the rule body.

![Rule editor for "Order total within credit limit": breadcrumb, Save/Reload/Validate/Publish actions, a properties band (Table sample_order, Triggers, Channels All), a DATA MAP row (Orders, sample_customer, sample_orderline, sample_product), a WHEN Execution conditions zone, a WHEN Outcomes zone with an "Outcome · Credit check" ALL·AND group and one condition, and a THEN Actions zone with a "Block save" action.](../images/02-04-editor-layout-01.png)

## Header

A **breadcrumb** back to the hub, the rule's **name**, a
**Draft**/**Published** status badge, and the header actions:

- **Edit rule**: creates or reopens a working draft while the published rule stays active.
- **Save**: writes draft changes to the server while any published revision stays active.
- **Reload**: discards in-memory edits and re-fetches the rule from the
  server.
- **Validate**: runs the rule through the validator without publishing.
- **Publish**: validates the saved draft and makes it the next published revision.
- **View published / Back to draft**: switches between the frozen definition and the editable draft.
- **Restore published to draft**: replaces draft changes after confirmation, without changing enforcement.
- **Unpublish**: explicitly stops enforcement.

See *Validating & Publishing* for what those checks cover.

## Properties band

The properties band summarizes the rule's **Table**, **Triggers**, and
**Channels**. To change them, use the **Properties** inspector, the same panel
the condition and action inspectors use: on wide viewports it's docked
alongside the editor by default, and on narrow viewports a **Properties**
button appears at the end of the band to bring it up as an overlay.

> The properties inspector also exposes settings that don't fit in the
> resting band: **Fire on change of these columns** (trigger columns),
> **Effective from** / **Effective to**, **Evaluation context**, and **Time zone for dates**. See
> *Creating a New Rule* for trigger columns and *Evaluation Context* for
> what evaluation context controls.

## Data map

The **DATA MAP** row shows the rule's table-config tree: the root table and
any lookup/child nodes reachable from it. An **Edit data model** link opens
the tree for editing. See *Table Configuration Tree* for how the tree is
built and extended.

## WHEN and THEN zones

The rule body is organized into three zones:

- **WHEN · Execution conditions**: gate whether the rule is evaluated at all.
- **WHEN · Outcomes**: the validation condition groups (AND/OR trees)
  checked at save time. Each top-level group is a named **outcome**, true or
  false, and has an **+ Add outcome** button. Each action's **Fires when**
  condition tests these outcomes.
- **THEN · Actions**: the actions the rule performs, run in order. Each
  fires when its **Fires when** condition holds.

See *Building Conditions* and *Building Actions* for how to build out each of these zones.
