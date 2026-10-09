---
title: Triggers & Channels
section: Getting Started
order: 104
slug: triggers-and-channels
---

# Triggers & Channels

**Triggers** decide which events run a rule. **Channels** decide which origin of a write it
responds to.

## Triggers

Set in the rule settings under **When it runs**. A rule needs at least one:

- **On create**, **On update**, **On delete**
- **On form**
- **On demand** (labelled **Manual** before this release; the API accepts `Manual` and `OnDemand`)

The **New rule** dialog groups them under **Runs**: **On the form** (**While editing**), **When
saved** (**Create**, **Update**, **Delete**) and **On demand**. See *How Rules Run*.

## Runs for

Appears on the **On demand** card once **On demand** is ticked (`asx_ondemandscope`):

| Setting | What an On demand run acts on |
|---|---|
| **Records it's given** (default) | The records you add to **Apply to records** (a Rule Run takes up to 250), or the one record `asx_ApplyRules` names |
| **All records that match "Only if"** | Every record on the table that passes the rule's **Only if** conditions, read a page at a time |

See *Running Rules On Demand* and *Beta Limitations*.

## Trigger columns

With **On update** ticked, **Also run on update when these change** lists the table's columns.

By default a rule re-runs on update only when a column its **conditions** use changes. Columns you
pick here are added to that set. Use it when an action depends on a column the conditions don't
read:

> A rule on `sample_orderline` totals the line amounts into the order, but its conditions only
> check whether the order is locked. Without `sample_lineamount` as a trigger column, editing a
> line amount never re-runs the rule and the total goes stale.

Trigger columns apply to **On update** only. Create and Delete always run.

## Channels

Optional. **Empty means every channel** (it reads **All channels**).

| Channel | Covers |
|---|---|
| **Standard** | Everything that isn't a portal: model-driven forms, the Web API, scripts, integrations, connectors, service principals, system and background operations |
| **Portal** | Writes from a Power Pages portal |

The engine can't tell a person from an integration, because Dataverse doesn't expose that
reliably. The one origin it can rely on is whether a write came through a portal.

**Example:** a rule on `account` that should only gate Power Pages submissions gets **Triggers**
**On create** and **On update** and **Channels** **Portal**. Saves from the app and the nightly
integration (both **Standard**) aren't affected. **Standard** alone does the reverse.

To exempt an integration while still enforcing a rule on people, use the platform's
`BypassCustomPluginExecution` instead of a channel (*Security Roles → Administrative bypass*).
