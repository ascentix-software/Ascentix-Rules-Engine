---
title: Core Concepts
section: Getting Started
order: 102
slug: core-concepts
---

# Core Concepts

## Rule

A **Rule** is the top-level object you author. It is scoped to a single Dataverse
table and is the parent of everything else: its condition tree and its actions. A
rule also declares which **Triggers** invoke it and, optionally, which **Channels**
it applies to (covered in *Triggers & Channels*).

## Conditions (WHEN)

The WHEN side of a rule is a tree of **Condition Groups**. Each group combines its
children with a **Logical Operator**, either **And** or **Or**. Each leaf in the
tree is a **Condition**, which has a **Condition Type**:

- **Field Comparison**: compares a field's value against a literal or another
  field, using a **Comparison Operator**: Equals, Not Equals, Greater Than, Greater
  Than Or Equal, Less Than, Less Than Or Equal, Contains, Does Not Contain, Is Null,
  Is Not Null.
- **Row Count**: counts related child records (optionally filtered) and checks the
  count against a minimum and/or maximum.
- **Regex Match**: tests a field's value against a regular expression pattern.
- **Calculation**: evaluates a math expression (aggregates over a child
  collection plus arithmetic) and compares the numeric result against a value.

Whether the group as a whole is satisfied is the rule's **match** or **no-match**
outcome, which drives which actions fire.

## Actions (THEN)

The THEN side of a rule is one or more **Actions**. Each action has an **Action
Type**: Set Visible, Set Required, Show Message, Block, Create Record, Update
Record, or Delete Record. Each also fires on either **On Match** or **On No Match**
(its **Fire On** setting). A validation rule typically pairs a *Block* action with
**On No Match**; a form-behavior rule typically pairs *Set Visible* or *Set
Required* with **On Match**.

## Table Config

A rule's conditions and field-reference values don't have to stay on the triggering
record. A **Table Config** is a tree, rooted at the rule's own table, that describes
how to traverse outward to related data: a **Lookup Table** node follows a lookup to
a single related record, and a **Child Table** node follows a one-to-many
relationship to a set of related records. Conditions and actions reference specific
nodes in this tree to say *which* record or rows they're evaluating. A Table Config
tree can be shared across multiple rules.

## Severity & outcomes

Severity (**Information**, **Warning**, or **Error**) is set **per action**, not
per rule. A single rule can carry actions at different severities (a *Show Message*
at Warning alongside a *Block* at Error), and different rules on the same table can
disagree about how serious an outcome is. Severity sets the message's level, not
whether the action blocks. A Warning-severity **Block** still blocks and rolls back
the save, exactly like an Error-severity one. See *Runtime Enforcement* for the
full mechanics.
