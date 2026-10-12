---
title: Evaluation Context
section: Administering
order: 303
slug: evaluation-context
---

# Evaluation Context

Each rule's **Evaluation Context** decides whose access applies when it reads business data and when
its write actions run. In the Rule Builder it's **Run as**, in the **Evaluation** section of the
rule settings.

| Run as | Value | Reads and writes as | Use it for |
|---|---|---|---|
| **The user who triggered it** (User) | 1, the default | The person saving | Most validation and form-behavior rules. |
| **System** | 2 | The system user | Checks on related records the person may not be able to read, and write actions on tables or columns they can't write. |

- **Reads**: this covers the record being saved and everything the rule reaches through its data
  model (*Core Concepts*).
- **User** never shows a person anything they couldn't already see, but the result can differ by
  user. A Row Count minimum can pass for a user who sees fewer rows and block an administrator, or
  the reverse.
- **Writes**: a fired Create, Update or Delete Record action runs as the same identity.

Rule configuration itself is always read as the system user, whatever this setting says (*Security
Roles*).
