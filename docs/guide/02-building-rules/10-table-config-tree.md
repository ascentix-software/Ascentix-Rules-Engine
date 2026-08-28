---
title: Table Configuration Tree
section: Building Rules
order: 210
slug: table-config-tree
screenshots:
  - file: images/02-10-table-config-tree-01.png
    caption: The table configuration editor, a traversal tree from a root table out to related lookup and child tables.
    alt: 'Table configuration "Orders" (SHARED, root sample_order, 4 nodes, used by 6 rules) with a Traversal tree: ROOT Orders, LOOKUP sample_customer, CHILD sample_orderline, LOOKUP sample_product, each with "Add related", a legend (lookup = many-to-one, child = one-to-many; indentation = depth), and a node-editing panel.'
  - file: images/02-10-table-config-tree-02.png
    caption: Selecting a node shows its table, relationship, and where it sits in the traversal.
    alt: Table config editor with the sample_customer lookup node selected; the Editing node panel shows Node name, Table (sample_customer), Relationship ("Lookup via parent column sample_customerid"), a "Reach from here" path (Orders → sample_customer), and Add related / Delete node.
---

# Table Configuration Tree

A **table configuration** (also called a **data map** or **traversal
tree**) describes how the engine reaches related data starting from a
**root table** out to whatever related tables a rule needs to look at.
Every condition and action node picker in the earlier pages, and the
**DATA MAP** row shown in *Editor Layout*, are built on top of one of
these trees.

## Node types

Every node is one of three types:

- **Root Table**: the tree's starting point, and the table the rule
  itself is bound to. There's exactly one per configuration.
- **Lookup Table**: a **many-to-one** related table, reached through a
  parent lookup column on the current node's table (for example, an order
  reaching the customer it belongs to via its customer lookup).
- **Child Table**: a **one-to-many** related table, reached through a
  child link field back to the current node.

Indentation in the tree shows **traversal depth**. A lookup reached from
underneath a child node gives a multi-level path, as in
Order → Order Line → Product, where Product hangs off the Order Line
**child** node rather than off the root.

![Table configuration "Orders" (SHARED, root sample_order, 4 nodes, used by 6 rules) with a Traversal tree: ROOT Orders, LOOKUP sample_customer, CHILD sample_orderline, LOOKUP sample_product, each with "Add related", a legend (lookup = many-to-one, child = one-to-many; indentation = depth), and a node-editing panel.](../images/02-10-table-config-tree-01.png)

## Configurations are shared

A table configuration is **shared and reusable**: more than one rule can
point at the same root configuration. Editing a config's tree (adding a
related node, for example) affects **every rule** that uses it. The
editor's header carries a **SHARED**
marker and a used-by rule count alongside the root table and node total.

## Selecting a node

Clicking a node in the tree opens its editing panel, showing:

- **Node name**: an editable label for the node.
- **Table**: the Dataverse table the node resolves to.
- **Relationship**: how this node is reached from its parent (for
  example, "Lookup via parent column `sample_customerid`" or a child link
  field).
- **Reach from here**: the full path from the root down to this node.

Every node also exposes an **"Add related"** action, which attaches a
further Lookup or Child node underneath it and is how multi-level paths
get built, and a **Delete node** action, which removes a node and its
subtree. The **Root** node can't be deleted.

![Table config editor with the sample_customer lookup node selected; the Editing node panel shows Node name, Table (sample_customer), Relationship ("Lookup via parent column sample_customerid"), a "Reach from here" path (Orders → sample_customer), and Add related / Delete node.](../images/02-10-table-config-tree-02.png)

## Opening a table configuration

You can reach the table configuration editor three ways:

- **Edit data model**: from a rule's DATA MAP row, opens that rule's
  root configuration.
- **Table configurations**: a tab on the hub, listing every
  configuration.
- **Table Configs**: an entry in the app sitemap.

See *Metadata Pickers* for how the "Add related" relationship list is
kept limited to relationships that actually exist, and *Building
Conditions* for how a condition picks which node in the tree it
evaluates against.
