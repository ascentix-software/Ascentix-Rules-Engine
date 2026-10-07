---
title: Triggers & Channels
section: Getting Started
order: 104
slug: triggers-and-channels
---

# Triggers & Channels

Every rule declares **Triggers** (which events invoke it) and, optionally,
**Channels** (which origin of write it should respond to). Together these two
settings control when a rule fires.

## Triggers

**Triggers** is a multi-select field on the rule (in the **When it runs** section
of the Rule Builder's rule settings), and a rule needs **at least one** selected.
The available values are:

- **On create**
- **On form**
- **On demand** (labelled **Manual** before this release; the stored value and the
  API trigger name are unchanged, and `Manual` is still accepted alongside
  `OnDemand`)
- **On update**
- **On delete**

The **New rule** dialog groups the same triggers under **Runs**: **On the form**
(**While editing**), **When saved** (**Create**, **Update**, **Delete**), and **On
demand**.

See *How Rules Run* for what each trigger invokes and which actions apply under it.

## Runs for

**Runs for** (`asx_ondemandscope`) only appears once **On demand** is ticked (on
the **On demand** card of the rule settings), and decides which records an On
demand rule can be invoked against:

- **Records it's given** (the default): **Apply to records** acts on the records
  you add, `asx_ApplyRules` on one record you name, and a **Rule Run** started
  against the rule must be given up to 250 record ids.
- **All records that match “Only if”**: a **Rule Run** started against the rule
  instead reads the whole table, a page at a time, applying the rule to every
  record its **Only if** (execution) conditions let through.

See *Running Rules On Demand* for the full Apply to records / Runs workflow this setting
drives, and *Beta Limitations* for the page/record budgets a run works within.

## Trigger Columns

When you select **On update**, an additional optional setting appears:
**Also run on update when these change**, a multi-select listing the root
table's columns.

By default (no columns selected) the rule's update firing is driven by the
columns its **conditions** reference, so a rule only re-runs on update when
one of its condition columns changes. Trigger columns are **added** to that
set: pick a column here and the rule *also* fires when it changes. Use one when
the rule's actions depend on a column its conditions don't reference:

> A rule on `sample_orderline` recomputes the order total by summing all line
> amounts in an aggregate action, while its conditions only check whether the
> order is locked. The aggregate reads `sample_lineamount`, so without
> **`sample_lineamount` as a trigger column** the rule never fires when a line
> amount is edited and the total goes stale.

Trigger columns only apply to **On update**. Create and Delete triggers always
fire on the entire record regardless of what columns changed.

## Channels

**Channels** is also a multi-select field, but it's optional, and it works the
opposite way from Triggers: **leaving it empty means the rule applies to every
channel** (the field then reads **All channels**). The available values are:

- **Standard** covers every origin that is not a portal: a person saving a
  model-driven form, the Web API, scripts and CLI tools, integrations,
  connectors, service principals, and the platform's own system or
  asynchronous operations.
- **Portal** covers writes coming from a Power Pages portal.

The engine does not try to tell a human apart from an integration: Dataverse does
not expose that reliably, since an interactive session can present an application
id on the write exactly as a service principal does. The one origin signal the
platform guarantees is whether the call came through a Power Pages portal.
Channels gate which **origin** a rule fires on, independent of which table
operation triggered it.

## A practical example

A validation rule on `account` blocks a save without a credit limit approver when
the credit limit is large, and you want it enforced only on Power Pages
submissions, not on internal users or the nightly integration.

1. Set **Triggers** to **On create** and **On update**.
2. Set **Channels** to **Portal** only.
3. The rule blocks a portal submission, but a save from the model-driven app or a
   write from the integration (both **Standard**) is not gated by this rule at all.

The mirror works too: **Standard** only enforces the rule everywhere except
the portal.

To exempt an integration from a rule while still enforcing it on people, use
the platform's own bypass (`BypassCustomPluginExecution`) rather than a
channel. See *Security Roles → Administrative bypass*.
