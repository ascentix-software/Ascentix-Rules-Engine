---
title: Building Actions
section: Building Rules
order: 207
slug: building-actions
screenshots:
  - file: images/02-07-building-actions-01.png
    caption: The action panel, with its plain summary, type, optional target field, message, severity, and the When section.
    alt: Action editing panel "EDITING ACTION 1 · Block" with Action type (Block), Active toggle, Fires when (an outcome test), Target field, Message ("Order total exceeds the customer's credit limit."), Severity (Error), and a WHAT HAPPENS explainer.
---

# Building Actions

Actions are the **Then** layer of a rule: what happens once the validation
conditions have been checked. Add one with **Add action** on the **Then** band.

## When

Every action has a **When** section, the last section of its panel, that says when it fires (its
Fires when tree). It tests the rule's outcomes (see *Building Conditions*):

- A **group** is **All** (every part must hold) or **Any** (at least one must hold). The root's
  toggle is labelled **When matches**. Groups can nest.
- A **test** reads "<outcome> **is true**" or "<outcome> **is false**".
- An empty root **All** group reads **Always, when the rule runs**. This is the default for a new
  action.
- **Not set. This action never runs.** appears when an action has no condition at all, for
  example after you restore an older revision. Click **Run always**, or build a condition.
  Publishing refuses an action that is not set (`ACTION_NO_TREE`).

Click **Add test** to test an outcome, and **Add group** to nest a group. Until the rule has
an outcome, both **Add test** and **Add group** are hidden and the hint "Add an outcome to
test it here." shows in their place. A group with nothing in it is refused at publish, unless it
is the empty root **All** (`ACTION_EMPTY_GROUP`).

The action row shows a summary, for example "When High value and (At risk or Critical case is
false)". A validation rule typically pairs a **Block save** action with a test that its "valid"
outcome is false.

## Action types

The **Type** dropdown names each type in sentence case; the rest of this
guide uses the stored names in brackets.

- **Set visible** (Set Visible): shows or hides a form field.
- **Set required** (Set Required): marks a form field required or not required.
- **Show message** (Show Message): surfaces a message to the user at a given severity.
  Never blocks a save.
- **Block save** (Block): prevents the save. Server-enforced.
- **Create record** (Create Record): creates a new record, with values from a field
  mapping.
- **Update record** (Update Record): updates a target record, with values from a field
  mapping.
- **Delete record** (Delete Record): deletes a target record.
- **Deactivate record** (Deactivate Record): makes the target record(s) inactive (`statecode` 1).
  Optionally sets a status reason; otherwise the table's default inactive status.

**Set visible** and **Set required** are form actions that use a
**Target column** to say which field they apply to (or **(form-level)**).
**Block save** takes an optional **Target field**: set one and the block
attaches to that field inline; leave it blank for a form-level block.
**Show message** has a **Show as** choice instead: **Banner on the form**
(save allowed) or **On a field** (holds the save while shown), which then
asks for the **Field**. **Show message** and **Block save** carry a
**Message**, and a **Severity** (Information, Warning, or Error); a message
shown **On a field** has no Severity choice.

> **What blocks a save is the action type, not the severity.** A **Block**
> action blocks the operation and rolls back at any severity, **Warning**
> included. A **Show Message** never blocks on the server, at any severity.
>
> On a form it is not that simple. A Show Message shown **On a field** is
> shown as a notification on the control, and the platform renders control
> notifications at Error only, so the platform's own validation stops the save
> until the condition stops matching. That happens whatever severity you set.
> A Show Message shown as a **Banner on the form** does not block. See
> *Runtime Enforcement*.

## Dynamic message text

A **Block** or **Show Message** action's **Message** (and its per-language
**Translations**) can include the same tokens used elsewhere in the editor:
`{root.<column>}` for a column on the triggering record, or
`{node:<node>.<column>}` for a column on a related table-config node. Tokens
are rendered **at fire time**, from the record that actually matched. The
message editor has an **Insert field** menu, and when the text has tokens
the **Message** label's info tip previews how users will read it. Add a
per-language version with **Add translation**, which lists the languages
not yet translated.

> If a token can't resolve (an unknown node, a malformed token, a related
> record that no longer exists), the message **degrades to the raw,
> unrendered text** rather than failing the rule. A template used as a
> condition's comparison value fails fast instead (see *Comparison Value
> Sources*).

## The action panel

Selecting an action opens its panel. A plain summary at the top says what
the currently-configured action will do, for example "When **Credit check**
is false, blocks the save with “…”." Below it you configure:

- **Type**: one of the eight types above. Only the types that do something under the
  rule's triggers can be picked; the others show what they need. **Set visible**,
  **Set required** and **Show message** need **On form** or **On demand**. The write
  actions need **On create**, **On update**, **On delete** or **On demand**. **Block**
  works under every trigger. A new action starts as **Show message** when the rule runs
  on the form or on demand, and as **Block** otherwise. If you change the triggers so
  that an existing action can no longer run, Issues shows a warning on that action.
- **Active**: a switch to enable or disable the action without deleting
  it (it reads **Off** when disabled).
- **Target column** / **Target field** / **Show as**: as described above.
- **Visible** or **Required**: for Set visible / Set required, the value to
  apply when the action fires (on means visible, or required).
- **Message**, **Severity** (Information, Warning, or Error), and
  **Translations** (per-language overrides for the message text), for Show
  message and Block save actions.
- **When**: the outcome tree described above, always last.

![Action editing panel "EDITING ACTION 1 · Block" with Action type (Block), Active toggle, Fires when (an outcome test), Target field, Message ("Order total exceeds the customer's credit limit."), Severity (Error), and a WHAT HAPPENS explainer.](../images/02-07-building-actions-01.png)

Create record and Update record actions replace the Message/Severity
fields with a field mapping (**Columns to set**). See *Field Mapping* for how to map target
columns to their values.

### When the record moves to another parent

A rule that runs on a record can update the record it points to, for example an opportunity's
contact. When a save **changes** that lookup (the opportunity moves from Ana to Ben), the rule sees
only the new contact. To keep the previous one up to date too, turn on **Also apply to the previous
Contact when it changes** on the Update record action. The rule then runs a second time for Ana in
the same save, and only the actions with this option on are applied to her. Blocks and messages
apply only to the record being saved. A record that both the new and the previous parent lead to
(two orders under the same customer, say) can only be updated by the new one's run; the previous
one's run leaves it alone. The option only appears on Update Record actions whose target is
reached through lookups; if you later change the action so it no longer qualifies, the option is
hidden and saved as off. The second run writes with the rule's own evaluation context, so with a
User-context rule the person saving also needs write access to the previous record.

## Writing a set of rows

Update Record, Delete Record and Deactivate Record can target a **collection** (a node reached
through a child relationship, shown as "Contacts (each row)"). The action then writes **every row**
of that collection for the record being evaluated; a collection under a collection yields all of
its rows. A single-record target behaves as before.

**Rows.** A set action has a Rows filter (the same editor as a condition's "Only consider records
where…"). The rule's conditions decide *whether* the action fires; the Rows filter decides *which
rows* it writes. "Has none" and "has at least" work here, so "contacts with no open follow-up task"
is one filter. The filter is evaluated **in memory**, over the collection's rows already fetched in
full for the rule's own traversal — it doesn't narrow what's queried from Dataverse, only which of
the fetched rows the action writes. See *Beta Limitations* for the size this puts on a set action.

**Create per row.** Create Record's optional **For each row of** creates one record per filtered row
of a collection (or **(one record)** for a single record). Map values from the row with the
**Current row** source, or `{row.<column>}` in a text template; a lookup column can link to the row
itself. There is no automatic duplicate check: guard with a "has none" Rows filter. **For each row
of** only appears once the rule has at least one collection node in its table-config tree; on a rule
with none, Create Record only ever creates one record.

**How writes are combined.** Every write of one record's evaluation is collected first. Two actions
writing the same record **in the same evaluation context** (User or System) become one write (the
later action wins per column); an update and a delete of the same record become the delete. Writes
in different evaluation contexts stay separate, even for the same record. A row that already holds
the values is skipped, so saving again with nothing changed writes nothing. Writes go out as
creates, then updates, then deletes, grouped per table, in bulk where the table supports it —
Deactivate Record included. A Block anywhere still means nothing is written. Also apply to the
previous parent is available only on a single-record target.
