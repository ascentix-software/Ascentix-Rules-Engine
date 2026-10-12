---
title: Core Concepts
section: Getting Started
order: 102
slug: core-concepts
---

# Core Concepts

## Rule

The top-level object you author. A rule belongs to one Dataverse table, owns its conditions and
actions, and declares its **Triggers** and, optionally, **Channels** (*Triggers & Channels*).

## Conditions (WHEN)

Conditions sit in **Condition Groups** that combine their children with **And** or **Or**. Each
condition has a type:

| Type | What it checks |
|---|---|
| **Field Comparison** | A field against a value or another field: Equals, Not Equals, Greater Than, Greater Than Or Equal, Less Than, Less Than Or Equal, Contains, Does Not Contain, Is Null, Is Not Null |
| **Row Count** | How many related child records there are (optionally filtered), against a minimum and/or maximum |
| **Regex Match** | A field against a regular expression |
| **Calculation** | A math expression (totals over child records plus arithmetic) against a value |

Each top-level validation group is an **outcome**: it has a required name and is either true or
false. A rule can have several, such as "High value" and "At risk", and all are evaluated. The
**Only if** groups are not outcomes; they decide whether the rule runs at all.

## Actions (THEN)

Each action has a type: Set Visible, Set Required, Show Message, Block, Create Record, Update
Record, Delete Record or Deactivate Record.

Each action also has a **Fires when** condition (the **When** section of its panel): tests such as
"High value is true", joined by ALL or ANY. A new action fires **Always, when the rule runs** until
you add tests. Typical pairings:

- Validation: *Block* when the "valid" outcome is **false**.
- Form behavior: *Set Visible* or *Set Required* when an outcome is **true**.

## Table Config

A tree, rooted at the rule's table, that says how to reach related data:

- a **Lookup Table** node follows a lookup to one related record;
- a **Child Table** node follows a one-to-many relationship to a set of records.

Conditions and actions point at a node to say which record or rows they use. Several rules can
share one tree.

## Severity

Severity (**Information**, **Warning** or **Error**) is set **per action** and sets the message's
level only. It doesn't decide whether a save is blocked: a Warning-severity **Block** still blocks.
See *Runtime Enforcement*.
