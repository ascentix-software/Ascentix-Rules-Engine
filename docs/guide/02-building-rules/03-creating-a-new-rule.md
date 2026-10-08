---
title: Creating a New Rule
section: Building Rules
order: 203
slug: creating-a-new-rule
screenshots:
  - file: images/02-03-creating-a-new-rule-01.png
    caption: The New rule dialog, where you name the rule, pick its table and data model, and choose when it runs.
    alt: "The New rule dialog: Name “Flag large expedited orders”, Table Order (sample_order), Data model cards with Orders selected (4 tables, used by 6 rules), and Runs with While editing and Update ticked."
---

# Creating a New Rule

A rule starts with the table it runs on and the data model (table
configuration) it will run against.

![The New rule dialog: Name “Flag large expedited orders”, Table Order (sample_order), Data model cards with Orders selected (4 tables, used by 6 rules), and Runs with While editing and Update ticked.](../images/02-03-creating-a-new-rule-01.png)

## Steps

1. On the hub's Rules tab, click **New rule**.
2. Enter a **Name** for the rule.
3. Pick the **Table** the rule runs on.
4. Choose a **Data model**. Once a table is picked, the dialog lists it as
   cards:
   - One card per existing data model rooted at that table, most-used first
     (each shows how many tables it has and how many rules use it). The
     first one is preselected.
   - **Start a new model for** *table name*: start a fresh table-config tree. The
     new model is named after the table (with a number added if that name is
     already taken); you can rename it later in the data-model editor.
5. Under **Runs**, check at least one trigger. They are grouped by where the
   rule runs:
   - **On the form**: **While editing** (the On form trigger).
   - **When saved**: **Create**, **Update**, **Delete** (the On create, On
     update and On delete triggers).
   - **On demand**: **On demand**.

   See *Triggers & Channels* for what each one means.
6. Click **Create**. The new rule opens in the editor, in **Draft** status.
   **Create** stays enabled: if something is missing, the dialog says what
   (*Enter a name.*, *Choose a table.*, or *Choose at least one.* under
   **Runs**) and moves focus to it.

## New data model vs. existing data model

- Pick **Start a new model for** *table name* when this rule needs a data shape
  no other rule has defined yet: a table config tree naming the table plus
  whatever lookup/child nodes the rule's conditions and actions will need to
  reach.
- Pick an existing model's card when another rule already built the tree you
  need. Data models are shared, so reusing one keeps rules on the same table
  consistent with each other, and any future extension to that tree (a new
  node) becomes visible to every rule using it.

See *Editor Layout* for how the resulting table-config tree shows up in the
editor, and *Table Configuration Tree* for how to extend one.

## Also run on update when specific columns change

Once the rule exists, the **When it runs** section of its **Rule settings**
(see *Editor Layout*) shows an **Also run on update when these change**
picker, listing the root table's columns. It appears **only when the On
update trigger is selected**.

By default, an On update rule only re-fires when a column referenced by its
**conditions** changes. Trigger columns are **added** to that set: pick a
column here and the rule *also* fires when that column changes, even though
no condition reads it.

This matters when a rule's **actions** depend on a column its conditions
don't reference. A rule on `sample_orderline` uses an aggregate action to
compute `sum(lines.lineamount)` onto the order, but its conditions never
reference the line amount. Without a trigger column, editing a line's amount
wouldn't re-run the rule, and the computed total would go stale.

See *Triggers & Channels* for the full trigger model, and *Field Mapping*
for the aggregate action used in this example.
