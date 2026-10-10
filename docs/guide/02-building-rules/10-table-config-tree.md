---
title: Table Configuration Tree
section: Building Rules
order: 210
slug: table-config-tree
screenshots:
  - file: images/02-10-table-config-tree-01.png
    caption: The data-model editor, a traversal tree from a root table out to related lookup and child tables.
    alt: "The Orders data model, used by 6 rules, 4 tables: the tree Orders (ROOT), Customer (LOOKS UP, via sample_customerid), Order lines (HAS MANY, linked by Order) and under it Product (LOOKS UP, via sample_productid); the panel reads “Select a table to edit it” with Add related table."
  - file: images/02-10-table-config-tree-02.png
    caption: Selecting a table shows its table, the column it's linked by, and its path from the root.
    alt: "Product selected in the Orders tree: its panel shows Name Product, Table Product · sample_product, Linked by Product · sample_productid, Path Orders › Order lines › Product, and Add related table and Delete."
---

# Table Configuration Tree

A **data model** (stored as a **table configuration**) is the tree of tables a rule can reach,
starting from its **root table**. Every node picker in conditions and actions, and the data model
chip in *Editor Layout*, come from it.

## Node types

The tree, **Tables this model can reach**, tags each table:

| Tag | Node | Reached through |
|---|---|---|
| **ROOT** | The rule's own table; one per data model | — |
| **LOOKS UP** | A many-to-one table, such as an order's customer | A lookup column, shown as "via Customer (sample_customerid)" |
| **HAS MANY** | A one-to-many table, such as an order's lines | A link column back to the parent, shown as "Order Line, linked by Order" |

Indentation shows depth. Lookups can hang off child nodes, as in Order → Order Line → Product. The
tree works from the keyboard: arrows move (Right and Left expand and collapse), Enter selects.

![The Orders data model, used by 6 rules, 4 tables: the tree Orders (ROOT), Customer (LOOKS UP, via sample_customerid), Order lines (HAS MANY, linked by Order) and under it Product (LOOKS UP, via sample_productid); the panel reads “Select a table to edit it” with Add related table.](../images/02-10-table-config-tree-01.png)

## Data models are shared

Several rules can use one data model, so editing it affects **every rule** that uses it. The header
shows **Used by N rules**; click it to list them, each marked **Live** or **Draft**.

**Save…** asks first: **Save shared data model?** names your change and lists each rule with the
tables it reads (for example "reads Customer in 2 conditions") or **not affected**. Live rules keep
their published copy until they're republished.

## Editing a table

Click a table to open its panel:

| Field | Shows |
|---|---|
| **Name** | An editable label, shown in the pickers of every rule using the model |
| **Table** | The Dataverse table |
| **Linked by** | The column it's reached through from its parent |
| **Path** | The path from the root |
| **Used by N rules** | The rules that read it, with how many conditions and actions |

**Add related table** attaches a lookup or child table underneath, from a searchable list grouped
**LOOKS UP · ONE RECORD** and **HAS MANY · ROWS**. Each row's ⋯ menu also has **Add related
table…**, **Rename** and **Delete**. You can't delete the **Root**, a table with tables under it
(*Delete the tables under it first.*), or a table rules use (*Can't delete: used by N rules.*).

![Product selected in the Orders tree: its panel shows Name Product, Table Product · sample_product, Linked by Product · sample_productid, Path Orders › Order lines › Product, and Add related table and Delete.](../images/02-10-table-config-tree-02.png)

## Opening a data model

- **Edit data model** on a rule's data model chip.
- The hub's **Data models** tab (*The Hub*).
- **Table Configs** in the app sitemap.

See *Metadata Pickers* for the relationship list, and *Building
Conditions* for picking a condition's node.
