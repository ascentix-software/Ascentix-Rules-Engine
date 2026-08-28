---
title: Evaluation Context
section: Administering
order: 303
slug: evaluation-context
---

# Evaluation Context

Every rule has an **Evaluation Context** setting that controls whose read
access governs the business data a rule's conditions traverse: `User` (the
default) or `System`.

## What it governs

A Table Config tree lets a rule follow lookups and child relationships out to
related records (see *Core Concepts*). Reading that data (the triggering
record itself and everything reached through the Table Config) runs under one
of two contexts:

- **User (default, value 1)**: the traversal reads data in the **calling
  user's** context, so a rule sees only the data that specific user can
  read. This preserves caller-visibility: the rule's outcome never exposes
  a field or related record the caller couldn't otherwise see. It also means
  a rule's outcome depends on who is saving: a Row Count minimum can pass for
  a read-restricted user where it would block an administrator, and the
  reverse.
- **System (value 2)**: the traversal reads data as the **system user**,
  regardless of what the calling user can see.

This is scoped to **business data** only. It's independent of how the
rules engine reads its own configuration: rule definitions (`asx_rule` and
the other config tables) are always loaded via the system user, no matter
which Evaluation Context a rule declares. See *Security Roles*.

Evaluation Context also determines which identity **write actions** run
as. A fired `Create Record`, `Update Record`, or `Delete Record` action
executes under the same context as the rule that fired it: a User-context
rule writes as the calling user, a System-context rule writes as the
system user.

## When to use each

- **Stay on User** for most validation and form-behavior rules.
- **Switch to System** when a rule's traversal needs to reach related data
  that the calling user may not have read access to: for example, a
  validation that must check a field on a related record regardless of the
  caller's per-record security, or a write action that needs to succeed
  even though the calling user lacks write privileges on the action's
  target table or column.

Evaluation Context is set **per rule**, so one rule can stay caller-scoped
while another on the same table is deliberately elevated to System for a
traversal or write the caller has no direct access to.
