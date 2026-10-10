---
title: What Is the Ascentix Rules Engine?
section: Getting Started
order: 101
slug: what-is-it
---

# What Is the Ascentix Rules Engine?

A rules engine for Microsoft Dataverse. One rule model drives both **server-side validation** and
**form behavior**. The engine adds its own `asx_` tables to hold the rules and nothing else: it
stores no results and copies none of your data.

## What it does

- **Enforces validation on save.** A rule can block a create, update or delete, with a message
  saying why.
- **Drives forms.** A rule can show or hide a field, make it required, or show a message, with no
  custom JavaScript.
- **Runs on demand.** A rule can be run against a record, saved or not, to see what it would do
  without writing anything.

## Key ideas

- **A rule belongs to one table**, such as `account` or `incident`.
- **A rule is WHEN / THEN.** WHEN is a tree of conditions grouped with AND/OR; THEN is the actions
  that fire depending on the result.
- **A data model reaches related records.** A Table Config tree tells the engine how to follow
  lookups and child records, so conditions can use them too.
- **Only published rules run.** A new rule starts as a Draft.

## Where you author rules

In the **Rule Builder**. See *Building Rules*.
