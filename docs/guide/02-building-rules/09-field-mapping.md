---
title: Field Mapping
section: Building Rules
order: 209
slug: field-mapping
screenshots:
  - file: images/02-09-field-mapping-01.png
    caption: The Map columns dialog maps each target column to a source (literal, field, template, or date expression).
    alt: '"Map columns" modal with two mapped columns: Approval Notes via a Text template ("Auto-flagged: expedited order totaling {root.sample_ordertotal}." with a live preview) and Handling Instructions via a Literal ("Handle with priority."), plus Add column, Edit as JSON, and Apply/Cancel.'
---

# Field Mapping

**Create Record** and **Update Record** actions write values onto the
target record's columns, configured through the **Map columns** dialog,
opened from the action's **"Edit columns…"** button in the action
inspector.

## The Map columns dialog

The dialog is a **master–detail** layout: a narrow list rail on the left
and a detail pane on the right.

The rail lists one entry per mapped target column: its display name, a
small colored dot for the source type, and a one-line **Source · value**
summary (for example, "Literal · Handle with priority."). Selecting an
entry loads that column into the detail pane.

The detail pane sets the mapped **Column** and its **Source**:

- **Literal**: a constant value, typed in the editor for the target
  column's type (text box, date picker, choice dropdown, and so on).
- **From this record**: a column's value from the triggering record.
- **From related record**: a column's value from a related table-config
  node.
- **Text template**: literal text combined with `{root.<column>}` /
  `{node:<tableconfig-guid>.<column>}` tokens. A live preview beneath the
  template shows the rendered result as you type.
- **Date calculation**, for DateTime targets only: an anchor (either "now"
  or a date column) plus or minus an amount and a unit.
- **Link to a record**, for lookup-family targets only (Lookup,
  Customer, or Owner columns): sets the column to a chosen record's own
  reference rather than one of that record's column values, for example a
  note whose Regarding lookup points back at the root record. Pick "this
  record" for the root record, or any related table-config node that
  resolves to exactly one record. Stored as
  `{ "target": "objectid", "source": "ref", "node": "<tableConfigId>" }`,
  where `node` is the table-config id of the chosen record (the root
  node's id for "this record").
- **Calculation**, for numeric targets only (integer or decimal columns):
  an arithmetic expression over numeric operands. See *Calculation* below.

!["Map columns" modal with two mapped columns: Approval Notes via a Text template ("Auto-flagged: expedited order totaling {root.sample_ordertotal}." with a live preview) and Handling Instructions via a Literal ("Handle with priority."), plus Add column, Edit as JSON, and Apply/Cancel.](../images/02-09-field-mapping-01.png)

## Adding and removing columns

**Add column** appends an entry to the rail and selects it. Each column has
its own **Remove column** button in the detail pane. **Apply** saves the
mapping back onto the action, **Cancel** discards it.

## Edit as JSON

An **"Edit as JSON"** link in the dialog's footer switches to a raw JSON
view of the underlying field-mapping data, the same structure the engine
stores and executes. Switching back to the list/detail view re-parses
whatever's in the JSON editor.

## Calculation

**Calculation** (in the engine code, `mathexpr`) computes a numeric result
from an arithmetic expression.

### Writing a calculation expression

Expressions use the same token syntax as text templates:

- `{root.<column>}`: a column from the triggering record.
- `{node:<tableconfig-guid>.<column>}`: a column from a related record.
- Numeric literals (e.g., `42`, `3.5`).

**Example:** `{root.sample_quantity} * {node:<product>.sample_price}`
multiplies the order quantity by the product's unit price.

### Operators and syntax

- **Arithmetic:** `+`, `-`, `*`, `/`.
- **Grouping:** parentheses `(` and `)`.
- **Unary minus:** a leading `-` before an operand (e.g., `-{root.sample_value}`).

### Target and operand types

- The **target column** must be numeric (an integer or decimal column).
- **Operands** must resolve to numeric values: numeric columns or numeric
  literals. A non-numeric operand fails during rule execution with
  "calculation operand 'X' is not a numeric value".

### Nulls, division by zero, and rounding

If **any operand is null**, or a **division by zero** occurs during
evaluation, the target column is **left unchanged**; no write occurs.
Fractional results are rounded to the **nearest whole number** when writing
to an integer target. Decimal targets preserve the full precision.

### Aggregates over child collections

Calculations can also aggregate values over a **child collection** (a
one-to-many related table), for example an order's line-item amounts.

#### Aggregate functions

- **`sum(node:<guid>.<column>)`**: sums the column's numeric values across
  all rows in the collection.
- **`avg(node:<guid>.<column>)`**: averages them.
- **`min(node:<guid>.<column>)`**: the smallest value in the column.
- **`max(node:<guid>.<column>)`**: the largest value in the column.
- **`count(node:<guid>)`**: the number of rows in the collection; takes no
  column.

On an empty collection, `sum` and `count` return `0`, while `avg`, `min`,
and `max` have no value: the calculation then produces no value and the
target is left unchanged (no write occurs).

#### Aggregate operand requirements

- The **collection must be a child collection** (a one-to-many related
  table picked as a table-config node). Single-related collections or the
  root record cannot be aggregated.
- The **column being aggregated must be numeric** (integer or decimal).
  Text, choice, date, and other non-numeric columns are errors at runtime.
- **Null cells are ignored** during aggregation: they contribute nothing to
  the sum, are skipped when computing average, and do not affect min/max.

#### Building aggregates in the editor

**Insert aggregate**, in the calculation editor, prompts for **Function**
(`sum`, `avg`, `min`, `max`, or `count`), **Collection** (the child
table-config node), and, for every function except `count`, **Column** (the
numeric column to aggregate). The expression is inserted at the cursor
position.

#### Composing aggregates with other operands

Aggregates are operands, like column references and literals, and combine
with arithmetic operators:

**Example:** `sum(node:<lines>.lineamount) * (1 + {root.taxrate})`
multiplies the sum of all line amounts by a tax factor derived from the
triggering record's tax rate.

#### Filtering an aggregate

An aggregate can be filtered to reduce only the child rows that match
specific criteria. Below the calculation expression, a teal **Aggregates**
card shows one chip row per aggregate in your expression: its function,
collection, and (for every function except `count`) column, each as its own
dropdown. Each row's **"Only rows where…"** button opens the filter builder
used for condition filters, where you add AND/OR criteria on the child
collection's columns. A **Clear** button appears next to it once a filter is
set.

Criteria support the same operators as condition filters:

- Equals, not equals, greater than, greater than or equal, less than, less
  than or equal.
- Contains, does not contain.
- Is null / Is not null.

A criterion compares against a **literal value** or **reads from another
record** (for example, a line's amount against the order's maximum
threshold). The filter's **Add** menu also offers a **Related-rows filter**,
the existence check that tests whether a *different* related collection has
a matching count of rows: only sum lines whose order also has an expedited
shipment, for instance. See *Filtering a Condition's Child Records* → *Has
related rows… (existence filtering)*.

**Example:** on an order, set a field to `sum(node:<lines>.amount)` where
each line's `status` equals "Active". Only active lines contribute to the
sum.

A filter that matches no rows behaves like an empty collection.

Filtering does not change when the rule fires or which other actions run.
Only **aggregates** can be filtered; single-record operands like
`{root.…}` and `{node:…}` cannot.

See *Building Actions* for how Create Record and Update Record fit among
the other action types.
