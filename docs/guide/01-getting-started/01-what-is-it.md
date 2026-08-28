---
title: What Is the Ascentix Rules Engine?
section: Getting Started
order: 101
slug: what-is-it
---

# What Is the Ascentix Rules Engine?

The Ascentix Rules Engine is a configurable, table-driven rules engine for
Microsoft Dataverse. It handles **server-side data validation** and
**client-side dynamic form behavior** on a single shared rule model.

The engine adds ten `asx_` configuration tables to hold the rules themselves,
and nothing else. It stores no results and mirrors none of your data: rules are
evaluated directly against your organization's **existing** tables.

## What it does

- **Enforces validation on save.** A rule can block an invalid create, update, or
  delete before it commits, with a message explaining why.
- **Drives form behavior.** A rule can show or hide a field, mark it required, or
  display a message as a user fills out a form, all without custom JavaScript.
- **Runs on demand.** A rule can be evaluated manually against a record (saved or
  unsaved) to check its outcome without touching the database.

## Key ideas

- **Rules are scoped to a table.** Every rule applies to one Dataverse table (for
  example, `account` or `incident`).
- **Rules follow a WHEN / THEN shape.** The WHEN side is a tree of **Conditions**
  (grouped with AND/OR); the THEN side is one or more **Actions** that fire based on
  whether the conditions match.
- **Table Configs describe how to traverse related data.** A rule isn't limited to
  the fields on the record that triggered it. A Table Config tree tells the engine
  how to walk out to lookup records and child records so conditions can reference
  them too.
- **Rules move through a Draft → Published lifecycle.** A new rule starts as a
  Draft. Only a Published rule is enforced.

## Where you author rules

Rules are authored visually in the **Rule Builder**. See the *Building Rules*
section for a full walkthrough of the Rule Builder, Table Config editor, and the
WHEN/THEN authoring experience.
