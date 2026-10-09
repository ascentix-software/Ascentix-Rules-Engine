---
title: Building Actions
section: Building Rules
order: 207
slug: building-actions
screenshots:
  - file: images/02-07-building-actions-01.png
    caption: The action panel, with its plain summary, type, optional target field, message, severity, and the When section.
    alt: "The action panel for a Show message: the summary “When Valid email is false, shows ‘Enter a valid email address.’ on Contact Email and holds the form save”, Type Show message and Active, Show as “On a field” with Field Contact Email, the message, Insert field, Translations, and When: Valid email is false."
---

# Building Actions

Actions are what a rule does: the **Then** band. Add one with **Add action**.

## Action types

| Type | Stored as | Does |
|---|---|---|
| **Set visible** | Set Visible | Shows or hides a form field. |
| **Set required** | Set Required | Makes a form field required or not. |
| **Show message** | Show Message | Shows a message. Never blocks a save on the server. |
| **Block save** | Block | Stops the save. Enforced on the server. |
| **Create record** | Create Record | Creates a record from a field mapping. |
| **Update record** | Update Record | Updates a record from a field mapping. |
| **Delete record** | Delete Record | Deletes a record. |
| **Deactivate record** | Deactivate Record | Makes records inactive, with an optional status reason (otherwise the table's default). |

**The type, not the severity, decides whether a save is blocked.** **Block save** blocks at any
severity, Warning included; **Show message** never blocks on the server. On a form, a **Show
message** shown **On a field** holds the save until its condition stops matching, whatever its
severity, because the platform treats field notifications as errors. Shown as a **Banner on the
form**, it doesn't hold the save (*Runtime Enforcement*).

## The action panel

Select an action to open its panel. The summary at the top says what it will do, for example "When
**Credit check** is false, blocks the save with “…”."

| Field | Use |
|---|---|
| **Type** | One of the types above. Types that can't run under the rule's triggers are disabled (below). |
| **Active** | Turns the action off without deleting it (reads **Off**). |
| **Target column** | **Set visible** / **Set required**: the field, or **(form-level)**. |
| **Visible** / **Required** | The value to apply when the action fires. |
| **Target field** | **Block save**: a field to attach the block to; blank for a form-level block. |
| **Show as** | **Show message**: **Banner on the form** or **On a field** (then **Field**). |
| **Message**, **Severity**, **Translations** | **Show message** and **Block save**. Severity is Information, Warning or Error; a message **On a field** has none. |
| **Columns to set** | **Create record** / **Update record**: the field mapping (*Field Mapping*). |
| **When** | When the action fires. Always last. |

![The action panel for a Show message: the summary “When Valid email is false, shows ‘Enter a valid email address.’ on Contact Email and holds the form save”, Type Show message and Active, Show as “On a field” with Field Contact Email, the message, Insert field, Translations, and When: Valid email is false.](../images/02-07-building-actions-01.png)

**Which types a rule can use** depends on its triggers:

| Types | Need |
|---|---|
| **Set visible**, **Set required**, **Show message** | **On form** or **On demand** (*Needs On form*) |
| **Create record**, **Update record**, **Delete record**, **Deactivate record** | **On create**, **On update**, **On delete** or **On demand** (*Needs a save or On demand trigger*) |
| **Block save** | Any trigger |

A new action starts as **Show message** if the rule runs on the form or on demand, otherwise **Block
save**. If you change the triggers so an active action can no longer run, the **Issues** drawer
warns on it (*Validating & Publishing*).

## When

The **When** section tests the rule's outcomes (*Building Conditions*):

- A **test** reads "<outcome> **is true**" or "<outcome> **is false**". **Add test** adds one.
- A **group** is **All** or **Any** of its tests (the root's toggle reads **When matches**). **Add
  group** nests one.
- An empty root **All** reads **Always, when the rule runs**, the default for a new action.
- **Not set. This action never runs.** means the action has no condition at all, for example after
  restoring an older version. Click **Run always** or build one. Publishing refuses it
  (`ACTION_NO_TREE`).

Until the rule has an outcome, **Add test** and **Add group** are replaced by "Add an outcome to test
it here." An empty group other than the root **All** is refused at publish (`ACTION_EMPTY_GROUP`).

The action row sums it up, for example "When High value and (At risk or Critical case is false)". A
validation rule usually pairs **Block save** with "its *valid* outcome is false".

## Dynamic message text

A message and its translations can include `{root.<column>}` (the record being saved) and
`{node:<node>.<column>}` (a related record), filled in when the action fires. Use **Insert field**;
the **Message** label's info tip previews the result. **Add translation** adds a version for
another language.

If a token can't be filled (unknown node, malformed token, a related record that's gone), the
message shows the raw text instead of failing the rule. A comparison template fails instead
(*Comparison Value Sources*).

## When the record moves to another parent

When a save changes a lookup (an opportunity moves from contact Ana to Ben), the rule only sees the
new contact. To update the previous one too, turn on **Also apply to the previous Contact when it
changes** on the Update record action. In the same save the rule then runs again for Ana, applying
only the actions with this option on.

- Blocks and messages apply only to the record being saved.
- A record both runs lead to (two orders under one customer) is updated only by the new parent's run.
- The option appears only on Update record actions that target a record through lookups, never a
  collection. If the action stops qualifying, it's hidden and saved as off.
- The second run uses the rule's evaluation context: for a User-context rule, the person saving needs
  write access to the previous record.

## Writing a set of rows

**Update record**, **Delete record** and **Deactivate record** can target a **collection** (a child
table, shown as "Contacts (each row)"). The action then writes every row of it for the record being
evaluated; a collection under a collection gives all its rows.

- **Rows** filter: which rows it writes (the conditions decide *whether* it fires). The same editor
  as a condition's "Only consider records where…"; "has none" and "has at least" work, so "contacts
  with no open follow-up task" is one filter. It filters rows already read for the rule; it doesn't
  narrow the query (see *Beta Limitations* for the size limit this sets).
- **For each row of** (Create record): creates one record per filtered row, or **(one record)**. Use
  the **Current row** source or `{row.<column>}` for values; a lookup can point at the row itself.
  There's no duplicate check, so guard with a "has none" Rows filter. Appears only when the data
  model has a collection.

**How writes are combined**, per record being evaluated:

1. All writes are collected first. A Block anywhere means nothing is written.
2. Two writes to the same record in the same evaluation context (User or System) merge; the later
   action wins per column. An update and a delete of one record become the delete.
3. A row that already holds the values is skipped, so saving again unchanged writes nothing.
4. Writes go out as creates, then updates, then deletes, per table, in bulk where the table allows.
