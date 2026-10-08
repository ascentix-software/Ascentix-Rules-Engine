---
title: Building Conditions
section: Building Rules
order: 205
slug: building-conditions
screenshots:
  - file: images/02-05-building-conditions-01.png
    caption: An outcome (a top-level validation group) holding a direct condition and a nested Match all subgroup.
    alt: "The Credit check outcome selected: Match any, the condition “Order Total is at most Customer · Credit Limit”, and a nested Match all subgroup “Small order” with “Order Total is less than 500” and “Is Expedited is No”; the Outcome panel shows its name, True when it matches All/Any, and Used by Block save."
  - file: images/02-05-building-conditions-02.png
    caption: The condition panel, with the condition type switch, then the node, column, operator, Compare with tabs, and value.
    alt: "The condition panel for “Order Total is less than 500”: Compare selected among Compare, Count rows, Pattern and Calculation; On “This order”, column Order Total (Currency), operator “is less than”, Compare with “a value”, and the value 500."
  - file: images/02-05-building-conditions-03.png
    caption: A Calculation condition using the Expression editor with Insert field and Insert aggregate, compared by a numeric operator.
    alt: "A Calculation condition on the Large order value outcome: the expression with Insert field and Insert aggregate, a preview reading “Sum of Order lines → Line Amount + Order Total”, an Aggregates block (sum of Order lines · Line Amount), and “is more than 5000”."
---

# Building Conditions

Conditions are what a rule checks. They appear in two bands,
**Only if** and **Outcomes**, which
use the same building blocks and differ only in their role in the rule (see
*Editor Layout*).

## Condition groups

Conditions live inside **condition groups**, and every group combines its
children one of two ways. Each group's header shows which, and its panel has
an **All** / **Any** toggle:

- **Match all** (AND): every condition (and subgroup) in the group must match.
- **Match any** (OR): at least one condition (or subgroup) in the group must match.

Groups can **nest**: a group can hold subgroups as well as direct
conditions, so you can build arbitrarily deep AND/OR trees. Inside a group,
**Add condition** adds a condition and **Add subgroup** adds a nested group.
A **Match any** group holding a direct condition and a **Match all** subgroup
matches if either the direct condition matches, or every condition in the
subgroup does.

Each condition reads as a sentence, for example *Order Total is more than
1,000*. Hovering over a condition (or focusing it) shows **Duplicate
condition** and **Delete condition** buttons. A group's ⋯ menu has **Rename
group**, **Match any instead** (or **Match all instead**), **Duplicate** and
**Delete group**; on an outcome the menu reads **Rename outcome** and
**Delete outcome**.

## Outcomes

Each top-level group in **Outcomes** is an **outcome**. Click **Add outcome** to add
one. Its card shows its name and, once actions test it, **Used by N actions**. Its panel has a
**Name** field whose info tip reads "Actions test this outcome by name.", a **True when it
matches** **All** / **Any** toggle, and a **Used by** list of the actions that test it (select one
to jump to that action).

- The name is required.
- Names must be unique in the rule, ignoring upper and lower case.
- A name can be at most 100 characters.

Every outcome is evaluated; there is no short-circuit. An outcome that no active action tests
still runs and is reported, but publishing warns you (`OUTCOME_UNUSED`). Subgroups inside an outcome
are not outcomes of their own; they only shape how that outcome is decided. **Only if**
groups are not outcomes either. They gate the whole rule.

If you delete an outcome that actions test, a **Delete outcome** dialog names those actions and
removes their tests of it. An action whose only test was that outcome becomes **Not set**, and the
dialog says it will then never fire until you set its **When**.
See *Building Actions*.

![The Credit check outcome selected: Match any, the condition “Order Total is at most Customer · Credit Limit”, and a nested Match all subgroup “Small order” with “Order Total is less than 500” and “Is Expedited is No”; the Outcome panel shows its name, True when it matches All/Any, and Used by Block save.](../images/02-05-building-conditions-01.png)

## Condition types

Each condition is one of four types, picked with the switch at the top of
the condition panel:

- **Compare** (Field Comparison): compares a column against a value using a comparison
  operator. The default and most common type.
- **Count rows** (Row Count): counts the related child rows at a child table-config
  node and checks the count against a minimum and/or maximum. Only valid on
  a child node. At Create of the parent record, Row Count evaluates the child
  rows existing at that instant (always zero for the record's own
  collections), so a minimum-row rule blocks the create unless **On create**
  is omitted from its triggers. The validator flags this combination with a
  `STRUCT_ROWCOUNT_ON_CREATE` warning at authoring time.
- **Pattern** (Regex Match): tests a text column against a regular expression, matching
  or not matching.
- **Calculation**: compares a numeric expression against a value using a
  numeric comparison operator. The expression can aggregate child collection
  values and perform arithmetic.

## Comparison operators

For a Compare condition, the **Operator** dropdown offers these phrases
(the stored operator is in brackets):

- **is** (Equals)
- **is not** (Not Equals)
- **is more than** (Greater Than)
- **is at least** (Greater Than Or Equal)
- **is less than** (Less Than)
- **is at most** (Less Than Or Equal)
- **contains** (Contains)
- **doesn't contain** (Does Not Contain)
- **is empty** (Is Null)
- **has a value** (Is Not Null)

The editor only offers operators that suit the comparison column's data
type: ordering operators like **is more than** aren't offered for a text
column, and **contains**/**doesn't contain** aren't offered for a number
column. **is empty** and **has a value** are always available, hide the
value side, and ignore whatever was configured there.

`Is Null` (**is empty**) matches both an explicitly-null value **and a column that is
absent from the record**: Dataverse omits null attributes entirely, so an
absent column is how "no value" actually looks at runtime, and `Is Null`
treats it as a match (while `Is Not Null`, **has a value**, treats it as no match).

## Calculation conditions

A Calculation condition evaluates the arithmetic expression typed into the
condition panel's expression box and compares the result against a value:
"order total is more than 1000," or "average line item discount is less
than 5%." Only the six numeric operators apply (**is**, **is not**, **is
more than**, **is at least**, **is less than**, **is at most**). The
right-hand side uses the same **Compare with** tabs as a Compare condition;
because the result is a number, they are **a value** and **another
column**. See *Comparison Value Sources*.

Expressions support:

- **Column references:** `{root.<column>}` for the triggering record,
  `{node:<tableconfig-guid>.<column>}` for related records.
- **Numeric literals:** e.g., `42`, `3.5`.
- **Arithmetic:** `+`, `-`, `*`, `/`, and `(` `)` for grouping.
- **Unary minus:** a leading `-` (e.g., `-{root.sample_value}`).
- **Aggregate functions:** `sum(node:<guid>.<column>)`,
  `avg(node:<guid>.<column>)`, `min(node:<guid>.<column>)`,
  `max(node:<guid>.<column>)`, and `count(node:<guid>)` to aggregate over a
  child collection.

For example: `sum(node:<lines>.lineamount) > 1000`.

**Insert field** exposes the related nodes and columns, inserting the
appropriate token at your cursor. **Insert aggregate** walks you through
selecting a function (sum, avg, min, max, count), the child collection, and
optionally the column to aggregate. Both use the same interface as the
Calculation field-mapping source; see the **Calculation** section in *Field
Mapping* for detailed examples and guidance on aggregate functions and
operand types.

![A Calculation condition on the Large order value outcome: the expression with Insert field and Insert aggregate, a preview reading “Sum of Order lines → Line Amount + Order Total”, an Aggregates block (sum of Order lines · Line Amount), and “is more than 5000”.](../images/02-05-building-conditions-03.png)

If a calculation cannot be computed (a null operand, a divide-by-zero, or an
aggregate function returning an empty result such as `avg()` on an empty
child collection), **the condition is not satisfied** and the comparison
does not fire. The same holds if the right-hand side value is missing or
null.

### Filtering what a total counts

Each aggregate in a Calculation can have its own filter. Select **Only rows where…** next to the
aggregate to choose which rows it includes, for example only open opportunities, or only those
closed in the last 12 months. Two aggregates over the same table can use different filters, so
`sum(won) / sum(all)` works as a ratio.

## The condition inspector

Selecting a condition opens its panel. Below the condition type switch, a
Compare condition reads as a sentence, top to bottom. Two of its fields are
documented nowhere else:

- **On**: which node in the data model this condition evaluates against
  (the root, listed as *This* plus the table name, or a lookup/child node
  reachable from it). Shown only when the data model has more than one table.
- **Column**: the column to evaluate, for Compare and Pattern. Count rows
  replaces the sentence with **Rows of** (the child node) and a **Count**
  choice (**has at least**, **has at most**, **has between**, **has no**)
  with its row numbers; Calculation replaces it with the expression box.

The rest are the **Operator**, the **Compare with** tabs (**a value** by
default), and the value. The condition's name sits in the collapsed **More**
section: **Condition name**, which you can leave blank to name the condition
from what it checks.

![The condition panel for “Order Total is less than 500”: Compare selected among Compare, Count rows, Pattern and Calculation; On “This order”, column Order Total (Currency), operator “is less than”, Compare with “a value”, and the value 500.](../images/02-05-building-conditions-02.png)

See *Comparison Value Sources* for the rest of the value-source options, and
*Building Actions* for how actions use outcomes.
