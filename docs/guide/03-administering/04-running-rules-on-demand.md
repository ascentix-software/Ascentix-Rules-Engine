---
title: Running Rules On Demand
section: Administering
order: 304
slug: running-rules-on-demand
---

# Running Rules On Demand

An **On demand** rule (see *Triggers & Channels*) doesn't wait for a save or a
form event. It's invoked explicitly, and — unlike the read-only `asx_RunRules`
dry run described in *How Rules Run* — actually **enforced**: a fired **Block**
stops the record and every other fired write action is applied. This page covers
**Apply to records**, **Runs**, and the **Rule Run** record they drive; the `asx_ApplyRules`
and `asx_ProcessRunPage` Custom APIs behind them are in *Custom APIs* for anyone
calling them directly from a script or a flow.

## Runs for: one record, or every record

**Runs for** (`asx_ondemandscope`, on the **On demand** card of the rule
settings, only shown once **On demand** is ticked) sets which records an On
demand rule can be run against:

- **Records it's given** (the default) — Apply to records acts on the records you
  choose, up to 250 (a Rule Run must be given their ids), and `asx_ApplyRules` on
  the one record it's called for.
- **All records that match “Only if”** — a Rule Run instead reads the whole table,
  a page at a time, and applies the rule to every record that passes its execution
  (**Only if**) conditions. The rule's execution conditions are **not**
  pushed into the Dataverse query for this scope yet, so scope the rule tightly
  (a narrow execution condition) if the table is large — see *Beta Limitations*.

## Apply to records

**Apply to records** is offered wherever a Published On demand rule is listed: the
**Run now** (**Play**) icon on the rule's row in the hub, and **Apply to records…**
in the **More run options** menu of the Rule Builder's **Run** button when you have
that rule open. Both open the **Run** dialog (titled **Run** and the rule's name) on
its **Apply to records** tab, next to **Preview on a record** (see *Validating &
Publishing*). Both always act on the rule's **published** definition — an open
draft's unpublished changes are never what Apply to records (or a Rule Run)
evaluates, even while you're editing that same rule.

The tab spells out what the run will do before you start it:

- **Version**: the live version, for example **Live v3**.
- **Records**: depends on **Runs for**.
  - **Records it's given**: an **Add records…** picker, up to 250 records,
    searchable, keeping your selection across searches. Each chosen record shows
    as a tag you can remove.
  - **All records that match “Only if”**: the table and the rule's published
    **Only if** conditions as a sentence (or just "All … records" if it has none),
    with a **Change in rule settings** link, since there's nothing to choose.
- **Writes**: each write action, or "No write actions. Only messages and blocks are
  evaluated."; a rule with a Block notes that blocked records are counted and
  skipped.
- **Runs as**: **System**, or **You** for a User-context rule (see *Evaluation
  Context*).

**Apply to matching records** (or **Apply to N records**) creates the Rule Run and
immediately begins driving it. The dialog switches to its progress view (see below),
with **Stop run** and **View runs** buttons; it reads **Running · page N** and the
number of records checked while the run goes.

## What a run records

Each Rule Run (`asx_rulerun`, see *Schema Reference*) keeps five running totals,
shown live in the progress view as **N records checked** and four tiles,
**Changed**, **Blocked**, **Failed** and **Didn't match**:

- **Evaluated** (**records checked**) — every record the run processed.
- **Changed** — a record that had at least one write applied.
- **Blocked** — a record that fired a `Block` action (no writes; recorded as a
  failure below).
- **Failed** — a record whose write threw, or that couldn't be found or read.
- **Skipped** (**Didn't match**) — a record that didn't pass the rule's execution
  conditions (the usual outcome for every record an **All records that match “Only
  if”** run reads that isn't one this rule is meant to touch).

The run also keeps the **first 50** Blocked/Failed records, each with the
record's id and the message, for the Runs dialog to show. Once a run reaches 100
Failed and nothing has succeeded, it's set to **Failed** as a safety stop rather
than grinding through a table it clearly can't process.

## Stop and Resume

**Stop run**, in the progress view, stops the run after its current page: its
status becomes **Cancelled** and it does not resume automatically. If the view
shows an error while the run is still Queued or Running, Stop run stays available.

Closing the browser tab mid-run does **not** cancel it — the progress view warns
"Keep this tab open. Closing it pauses the run." — the run stays **Running**
server-side, and the **Runs** dialog lists every run for the rule. Open it with the
**Runs** (**History**) icon next to Run now in the hub, or **View runs** in the Rule
Builder's **Run** menu. The dialog, titled **Runs ·** and the rule's name, is a grid
with **Status**, **Started** (when, and who started it, or **Scheduled**),
**Changed**, **Blocked**, **Failed** and **Checked** columns. Its status pills read
**Queued**, **Running**, **Completed**, **N failed** (completed with failures),
**Paused**, **Cancelled** or **Failed**. Expand a run with failures to list them,
each named by its record (linked) with its message. Every run that hasn't finished
(Queued or Running) has a **Stop** button there. A **Running** run whose last page
was processed more than **2 minutes** ago, or a **Queued** run that hasn't processed
a page within **2 minutes** of starting, is treated as abandoned: it shows as
**Paused** and offers a **Resume** button, which picks the run back up from where it
left off. A rule that has never run shows "No runs yet."

Once a run is created, cancelling it is the only change anyone can make to it:
its scope, record ids, totals and progress are kept by the engine.

## One run at a time per rule

A rule can have at most one run **Queued** or **Running** at a time. Starting a
second one is refused ("This rule already has a run in progress. Cancel or
resume it first.") until the first reaches Cancelled or a terminal status
(Completed, Completed with failures, or Failed).

## Who can run rules

Starting a run, resuming one, and calling `asx_ApplyRules` are gated by the
**Rule Run Create** privilege (`prvCreateasx_RuleRun`), but Create alone isn't
enough to run rules from the Rule Builder or a flow. The full set is:

- on the **Rule Run** table (`asx_rulerun`): **Create** (the gate), **Read**
  (the Runs dialog, reading a run back), **Append** (linking the run to its rule)
  and **Write** at user level or wider (**Stop run** / **Stop**);
- on the **Rule** table (`asx_rule`): **Append To**.

Neither the **Rules Engine Author** nor **Rules Engine Reader** role (*Security
Roles*) grants these by default: an administrator decides who may actually run
rules — which can be a different set of people from who may author or read
them. A small security role holding exactly these privileges, assigned on top of
whatever role people already hold, is the simplest way to do it.

A rule's **Evaluation Context** (*Evaluation Context*) still governs whose read
access the run uses, and whose write it performs: a **User**-context rule acts as
whoever started or resumed the run (the person driving it, not the rule's
author), and a **System**-context rule always acts as the system service,
regardless of who started it. So a User-context run only reaches records that
person can read: an **All records that match “Only if”** run reads only the rows they can see, and a
chosen record they can't read counts **Failed** ("Record not found or not
readable.") without being evaluated.
