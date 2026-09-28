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
**Run now**, **Runs**, and the **Rule Run** record they drive; the `asx_ApplyRules`
and `asx_ProcessRunPage` Custom APIs behind them are in *Custom APIs* for anyone
calling them directly from a script or a flow.

## Runs for: one record, or every record

**Runs for** (`asx_ondemandscope`, only shown once **On demand** is ticked) sets
which records an On demand rule can be run against:

- **A record it's given** (the default) — Run now (and `asx_ApplyRules`) act on
  one record you choose; a Rule Run must be given up to 250 record ids.
- **All records that pass its execution conditions** — a Rule Run instead reads
  the whole table, a page at a time, and applies the rule to every record that
  passes its execution conditions. The rule's execution conditions are **not**
  pushed into the Dataverse query for this scope yet, so scope the rule tightly
  (a narrow execution condition) if the table is large — see *Beta Limitations*.

## Run now

**Run now** appears wherever a Published On demand rule is listed: a **Play**
icon on the rule's row in the hub, and a matching button in the Rule Builder's
header when you have that rule open. Both always act on the rule's **published**
definition — an open draft's unpublished changes are never what Run now (or a
Rule Run) evaluates, even while you're editing that same rule.

Opening Run now shows different things depending on **Runs for**:

- **A record it's given**: a **Choose records…** picker, up to 250 records,
  searchable, keeping your selection across searches.
- **All records that pass its execution conditions**: a read-only list of the
  rule's published execution conditions (or, if it has none, a note that it runs
  for every record of the table), since there's nothing to choose.

**Start** creates the Rule Run and immediately begins driving it, showing a
progress panel (see below) with a **Cancel** button.

## What a run records

Each Rule Run (`asx_rulerun`, see *Schema Reference*) keeps five running totals,
shown live in the progress panel as `Evaluated · Changed · Blocked · Failed ·
Skipped`:

- **Evaluated** — every record the run processed.
- **Changed** — a record that had at least one write applied.
- **Blocked** — a record that fired a `Block` action (no writes; recorded as a
  failure below).
- **Failed** — a record whose write threw.
- **Skipped** — a record that didn't pass the rule's execution conditions (the
  usual outcome for every record an **All records** run reads that isn't one this
  rule is meant to touch).

The run also keeps the **first 50** Blocked/Failed records, each with the
record's id and the message, for the Runs dialog to show. Once a run reaches 100
Failed and nothing has succeeded, it's set to **Failed** as a safety stop rather
than grinding through a table it clearly can't process.

## Cancel and Resume

**Cancel**, in the progress panel, stops the run after its current page: its
status becomes **Cancelled** and it does not resume automatically.

Closing the browser tab mid-run does **not** cancel it — the run stays
**Running** server-side, and the **Runs** dialog (the **History** icon next to
Run now, in the hub and the Rule Builder) lists every run for the rule. A
**Running** run whose last page was processed more than **2 minutes** ago is
treated as abandoned and offers a **Resume** button, which picks the run back up
from where it left off.

## One run at a time per rule

A rule can have at most one run **Queued** or **Running** at a time. Starting a
second one is refused ("This rule already has a run in progress. Cancel or
resume it first.") until the first reaches Cancelled or a terminal status
(Completed, Completed with failures, or Failed).

## Who can run rules

Starting a run, resuming one, and calling `asx_ApplyRules` all require the
**Rule Run Create** privilege (`prvCreateasx_RuleRun`). Neither the **Rules
Engine Author** nor **Rules Engine Reader** role (*Security Roles*) grants it by
default: an administrator decides who may actually run rules — which can be a
different set of people from who may author or read them — by granting
`prvCreateasx_RuleRun` on top of whatever role they already hold.

A rule's **Evaluation Context** (*Evaluation Context*) still governs whose read
access the run's traversal uses, and whose write it performs: a **User**-context
rule acts as whoever started or resumed the run (the person driving it, not the
rule's author), and a **System**-context rule always acts as the system service,
regardless of who started it.
