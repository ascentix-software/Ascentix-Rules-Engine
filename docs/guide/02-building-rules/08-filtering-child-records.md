---
title: Filtering a Condition's Child Records
section: Building Rules
order: 208
slug: filtering-child-records
screenshots:
  - file: images/02-08-filtering-child-records-01.png
    caption: The “Only consider records where…” dialog, a filter block that targets one node and builds an AND/OR set of column criteria.
    alt: "The “Only consider records where…” dialog: Filter on “(this record's collection)”, Match All of the following, and the criterion Line Amount, Greater than, Literal, 100, with Add, Add filter, Cancel and Apply."
  - file: images/02-08-filtering-child-records-02.png
    caption: A completed filter, so the condition only counts order lines where Line Amount is more than 100.
    alt: "A Count rows condition “Order lines has at least 1 row” with Only count rows where “Line Amount is more than 100” and an Edit link."
  - file: images/02-08-filtering-child-records-03.png
    caption: The Count dropdown sets how many matching rows the condition needs (at least, at most, between, or none).
    alt: "The Count rows condition with its Count dropdown open: has at least (selected), has at most, has between, and has no."
---

# Filtering a Condition's Child Records

When a condition targets a **child (collection) node**, the condition panel
shows an **Only consider rows where** section (**Only count rows where** for a
Count rows condition). It summarizes the filter in one line; its **Add
filter** (or **Edit**) button opens the **"Only consider records where…"**
dialog. The condition evaluates only the child records that match the filter.

## How filters work

Each filter is a **block that targets one specific node** and specifies an
**AND/OR set of criteria** on that node's columns.

- **First filter targets the child node**: a new filter starts on the
  condition's own child node.
- **Add more filters**: each additional filter (**Add filter** in the dialog) can target the same child node,
  or an **ancestor node** to filter by that related record's columns.
- **All filters must match**: a child record is evaluated only if it satisfies
  **all** filters you add. An ancestor filter acts as an additional constraint
  via the parent relationship.

![The “Only consider records where…” dialog: Filter on “(this record's collection)”, Match All of the following, and the criterion Line Amount, Greater than, Literal, 100, with Add, Add filter, Cancel and Apply.](../images/02-08-filtering-child-records-01.png)

## Supported operators

A filter's criteria support the same comparison operators as Compare
conditions, named as follows in the filter's operator dropdown:

- **Equals**
- **Not equals**
- **Greater than**
- **Greater or equal**
- **Less than**
- **Less or equal**
- **Contains**
- **Does not contain**
- **Is null**
- **Is not null**

The editor only offers operators that make sense for the column's data type.
Each group of criteria has a **Match** **All** / **Any** toggle.

## Comparison values

Each criterion's comparison value can be:

- **Literal**: a fixed value you type in.
- **From record**: read from a related record's column through a
  lookup-chain or single-record reference. For example, compare a line item's
  date against the order's due date.

For a date column you can also choose **Date expression**: a point in time relative to when the
rule runs ("now minus 90 days"), or to another date ("the row's estimated close date plus 2
days"). A date on the row itself is read from each row being filtered. If that date is empty on a
row, the row simply doesn't match. The same applies when the date comes from a related record that is missing or has no date. For a window such as "in the next 120 days", add two
conditions: on or after now, and on or before now plus 120 days.

A date comparison (Equals, Not equals, and the before/after operators) with a literal date or
a date expression based on when the rule runs, or on a date of the rule's own record or a
record it looks up, is applied in the Dataverse query. A date expression based on a date on the
same row is applied after the rows are loaded.

### Which day it is

Date columns come in three kinds. **User Local** dates are exact moments, compared exactly.
**Date Only** dates are calendar dates: "on or after yesterday" means any time yesterday.
**Time Zone Independent** dates are clock times with no time zone. To compare those two kinds
with "when the rule runs", the rule needs to know which day and which clock time it is: set
**Rule time zone** in the **Evaluation** section of the rule settings. The default is UTC, so a rule used in Eastern
Canada moves to the next day at 8 pm (7 pm in winter) unless its time zone is set. The same
setting reads a date without a time zone against a User Local column: "Created On on or after
2026-09-01", or a Date Only anchor date, means midnight in the rule's time zone.

## Examples

### Example 1: Filter child records by a column on the child node

A rule on **order lines** checks "every line **with status = Active** must have
amount > 0."

- Create a condition on the order-line node: `amount > 0`.
- Add a filter targeting the order-line node: `status Equals Active`.
- Result: only order lines with `status = Active` are checked.

![A Count rows condition “Order lines has at least 1 row” with Only count rows where “Line Amount is more than 100” and an Edit link.](../images/02-08-filtering-child-records-02.png)

### Example 2: Filter child records by a column on an ancestor node

A rule on **order lines** checks "every line must have amount > 0, but only for
orders in the **Northeast region**."

- Create a condition on the order-line node: `amount > 0`.
- Add a filter that targets the **parent order node**: `region Equals Northeast`.
- Result: only lines that belong to a Northeast order are checked.

## Has related rows… (existence filtering)

A filter's **Add ▾** menu offers **Condition**, **Group**, and a third option:
**Related-rows filter**. Adding one turns **the criterion** into an existence
check: the criterion is satisfied when another related collection has a **count
of matching rows** within a range you choose, instead of comparing a single
column.

This expresses "this order has at least one line item with status = Active"
inside the filter, without a separate Row Count condition.

### Picking the related collection

A **"Related rows collection"** picker lists the rule's child-collection nodes
from the configuration tree. The engine relates the picked collection to the
node the filter targets through the **common ancestor** the two nodes share in
the tree. A line node and a shipment
node that both hang off the same order node are related through that order.

### Count modes

The **"How many matching rows?"** dropdown sets the count range, the same
minimum and maximum a Count rows condition stores:

- **At least one (exists)**: min 1, no upper bound.
- **None (does not exist)**: max 0.
- **At least N**: min N, no upper bound.
- **At most N**: max N, no lower bound.
- **Exactly N**: min and max both N.
- **Between N and M**: min N, max M.
- **Custom (min / max)**: the raw bounds, set directly.

![The Count rows condition with its Count dropdown open: has at least (selected), has at most, has between, and has no.](../images/02-08-filtering-child-records-03.png)

### The sub-filter

Once a collection is picked, a **sub-filter** appears below the count mode: an
AND/OR set of criteria on the related collection's columns, with the same
operators and value sources as any other filter. Its **Add** menu offers only
**Condition** and **Group**: existence filtering supports **one level of
nesting**.

### Available in both surfaces

"Has related rows…" appears wherever a filter builder does: a
condition's **"Only consider records where…"** dialog (this page) and an
aggregate's **"Filter this aggregate…"** builder (see *Field Mapping* →
*Filtering an aggregate*).

### Example: filter by an existence check on a different collection

A rule on **order lines** checks "only consider a line when its **order also
has an expedited shipment**."

- Create a filter on the order-line node.
- Use the **Add** menu and choose **Related-rows filter**.
- Pick the **shipments** collection.
- Set the count mode to **At least one (exists)**.
- In the sub-filter, add `type Equals Expedited`.
- Result: only order lines whose order has at least one expedited shipment
  are checked.

Switching the count mode to **None (does not exist)** inverts the criterion to
"…order has **no** expedited shipment" instead.
