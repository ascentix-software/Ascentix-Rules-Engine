---
title: The Hub
section: Building Rules
order: 202
slug: the-hub
screenshots:
  - file: images/02-02-the-hub-01.png
    caption: The hub's Rules tab lists each rule with its table, rule set, status, triggers, action count, and last modified.
    alt: "The Rules & data model hub on its Rules tab, searched for “Order”: the Rules, Data models and Rule sets tabs; New rule, Table, Rule set and Status filters; and six Draft rules on sample_order that use the Orders data model, each with a selection checkbox, its rule set (two are in Billing), triggers, action count and last modified time."
---

# The Hub

The hub, **Rules & data model**, is the Rule Builder's landing page. It has three tabs: **Rules**,
**Data models** and **Rule sets**.

![The Rules & data model hub on its Rules tab, searched for “Order”: the Rules, Data models and Rule sets tabs; New rule, Table, Rule set and Status filters; and six Draft rules on sample_order that use the Orders data model, each with a selection checkbox, its rule set (two are in Billing), triggers, action count and last modified time.](../images/02-02-the-hub-01.png)

## Rules tab

| Column | Shows |
|---|---|
| **Rule** | The rule's name, and the data model it uses. |
| **Table** | The table the rule runs on. |
| **Rule set** | The rule set the rule is in (click it to open the set), or a dash. |
| **Status** | Draft, Published or Archived (*Rule Lifecycle*). |
| **Triggers** | When it runs (*Triggers & Channels*). |
| **Actions** | How many actions it has. |
| **Modified** | When it last changed, and by whom. |

Click a row to open the rule (*Editor Layout*). Above the list: **New rule** (*Creating a New
Rule*), **Search rules**, and the **Table**, **Rule set** and **Status** filters.

### Moving rules to a rule set

Tick the rules to move; the header checkbox selects every rule on the page. A bar shows how many are
selected, with **Move to rule set** and **Clear selection** (and **Select all** on a narrow
screen). Changing the page, search, filters or tab clears the selection.

**Move to rule set** opens **Move N rules**, which says where the rules are now. Choose a rule set,
**No rule set**, or **New rule set…** and a name, then **Move**. Either all the rules move or none
do. A rule's set changes without a working draft, so a published rule keeps enforcing.

### While a data update is waiting

A bar reads *Read-only until Update N is applied.* **New rule**, **Duplicate**, **Delete**, the
selection checkboxes, and the controls that change rule sets are hidden. A System Administrator or
System Customizer sees **Apply now** (*Data Updates*).

## Data models tab

Data models (the table trees rules read through) are shared between rules, so they're managed here.
Editing one affects every rule that uses it.

| Column | Shows |
|---|---|
| **Data model** | Its name and root table. |
| **Root table** | The table it starts from. |
| **Tables** | How many tables it reaches. |
| **Used by** | How many rules use it, or **Unused**. |
| **Modified** | When it last changed. |

**Delete** is disabled while any rule uses the model. Above the list: **New data model**, **Search
data models**, and a **Root table** filter. Click a row to open the model (*Table Configuration
Tree*).

## Rule sets tab

A rule set is a named group of rules that move between environments together (*Moving Rules
Between Environments*). A rule is in one rule set or none.

| Column | Shows |
|---|---|
| **Rule set** | Its name and description. |
| **Rules** | How many rules it holds, whatever their status (click to open the set), or **Empty**. |
| **Last imported** | The environment it was last imported from, and when, or **Never**. |
| **Modified** | When it last changed, and by whom. |

Above the list: **New rule set** and **Search rule sets**, which matches names and descriptions. A
rule set has a **Name**, unique in the environment, and an optional **Description**. Each row has
**Edit** (name and description) and **Delete**. **Delete** is disabled while the set has rules:
move or remove them first. Click a row to open the rule set's page.

### Rule set page

The page shows the set's name, description and last change, with **Delete** at the top right. The
breadcrumb leads back to the **Rule sets** tab.

- **Rules** lists the set's rules with their table, status and last change. Click one to open it.
  The **Remove from set** button on each row takes a rule out straight away; the confirmation has
  **Undo**.
- **Add rules** lists every rule not in the set, with a search and **Select all**. A rule in
  another set says which set it moves from. Pick rules and choose **Add N rules**.
- **Details** holds the **Name** and **Description**. Each saves when you leave the field.
- **Between environments** shows where and when the set was last imported, or **Never imported**.
