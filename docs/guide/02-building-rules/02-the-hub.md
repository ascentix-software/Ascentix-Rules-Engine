---
title: The Hub
section: Building Rules
order: 202
slug: the-hub
screenshots:
  - file: images/02-02-the-hub-01.png
    caption: The hub's Rules tab lists each rule with its table, status, triggers, action count, and last modified.
    alt: "The Rules & data model hub on its Rules tab, searched for “Order”: New rule, Table and Status filters, and six Draft rules on sample_order that use the Orders data model, each with its triggers, action count and last modified time."
---

# The Hub

The hub, titled **Rules & data model**, is the Rule Builder's landing page. It
has two tabs: **Rules** and **Data models**.

![The Rules & data model hub on its Rules tab, searched for “Order”: New rule, Table and Status filters, and six Draft rules on sample_order that use the Orders data model, each with its triggers, action count and last modified time.](../images/02-02-the-hub-01.png)

## Rules tab

The Rules tab lists every rule with:

- **Rule**: the rule's name, and the data model it uses underneath.
- **Table**: the table the rule's data model is rooted on.
- **Status**: Draft, Published, or Archived. See *Rule Lifecycle* for what
  each status means.
- **Triggers**: the events the rule responds to. See *Triggers & Channels*.
- **Actions**: the rule's action count.
- **Modified**: when the rule was last changed, and by whom.

Clicking a row opens that rule directly in the editor. See *Editor Layout*
for what you land on.

Above the list sit **New rule** (see *Creating a New Rule*), **Search rules**,
and the **Table** and **Status** filters.

While a release's data update is waiting to be applied, a slim bar appears above the list: *Read-only
until Update N is applied.*, followed by the update's title. **New rule**, **Duplicate** and **Delete**
are hidden until it has been applied. A System Administrator or System Customizer sees **Apply now** in
the bar; its info tip tells everyone else who to ask. See *Data Updates*.

## Data models tab

The **Data models** tab lists the shared data models (the table trees rules
read through). A data model can be reused across multiple rules, so it is
managed here rather than inside any one rule. A note above the list says so:
*Data models are shared. Editing one affects every rule that uses it, and a
data model in use can't be deleted.*

Each row shows the **Data model** (its name and root table), the **Root
table**, **Tables** (how many tables it reaches, for example "3 tables"),
**Used by** (how many rules use it, or **Unused**), and **Modified**. A
data model's **Delete** button is disabled while rules use it.

Above the list sit **New data model**, **Search data models**, and a **Root
table** filter. Clicking a row opens the data model in its editor. See
*Table Configuration Tree*.
