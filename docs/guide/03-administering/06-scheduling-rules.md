---
title: Scheduling Rules
section: Administering
order: 306
slug: scheduling-rules
---

# Scheduling Rules

A **Published**, **On demand** rule scoped to **All records that pass its execution
conditions** can also run on a recurring schedule, instead of (or as well as) **Run
now** (*Running Rules On Demand*). Scheduling starts or continues a **Rule Run**
exactly the way Run now does — the same table read, the same execution-condition
gate, the same **Runs** dialog for history — the only difference is what starts it.

## Setting a schedule

Open a Published rule that's On demand with **Runs for** set to **All records that
pass its execution conditions** (*Running Rules On Demand*); a rule scoped to **A
record it's given** can't be scheduled, since a schedule has no records to choose. The
Rule Builder's properties panel then shows a **Schedule** section with a switch and,
once it's On, a **Pattern**:

- **Every N minutes** — N is 15, 30 or 45.
- **Every N hours** — N is 1–23.
- **Daily** — at a chosen time of day.
- **Weekly** — at a chosen time of day, on one or more chosen days.
- **Monthly** — at a chosen time of day, on a chosen day of the month. A day past the
  end of a shorter month (the 31st in a 30-day month, or in February) clamps to that
  month's last day.

A time of day is read in the rule's own **Time zone for dates** setting (*Editor
Layout*'s properties panel; blank means UTC), the same zone the rule's date
comparisons use. **Next run** and **Last run** (with its outcome) are shown below the
pattern, both engine-owned: they're computed by the schedule plug-in and by
`asx_StartDueSchedules`, never set from the Rule Builder, and clicking either opens the
**Runs** dialog. Saving writes one `asx_ruleschedule` row for the rule (*Schema
Reference*); a rule can have at most one.

## Precision: within 15 minutes

A schedule becomes due when something calls `asx_StartDueSchedules` (*Custom APIs*)
and finds its **Next run on** at or before that moment. The shipped scheduler add-on
(below) calls it every 15 minutes, so a scheduled run actually starts **within 15
minutes of** its scheduled time, not at the exact minute. A schedule isn't a
precision timer: don't schedule something that must fire at an exact second.

## Catch-up and continue

If the caller driving `asx_StartDueSchedules` is itself down for a while — the add-on's
flow turned off, or an outage — a schedule that was due during that gap doesn't queue
up multiple runs to make up for lost time: the next call that finds it due starts (or
continues) **one** run and moves **Next run on** forward from *now*, exactly as if it
had been due only once. A missed daily, weekly or monthly occurrence is simply
skipped, not queued.

If a schedule comes due while its rule **already has an active Rule Run** (Queued or
Running — from Run now, a previous wake-up, or another schedule call racing this
one), `asx_StartDueSchedules` doesn't start a second one: it **continues** that run
(the same one-run-at-a-time rule as Run now, *Running Rules On Demand*) and records
that outcome, **Continued the active run**, on the schedule. **Next run on** is left
alone in that case, so the schedule stays due until the run it's waiting on finishes,
and the call after that starts the next occurrence.

A schedule that can't actually be processed — its rule was deleted, unpublished, no
longer scoped to All records, or its recurrence is somehow invalid — is switched
**Off** with **Last outcome** set to **Rule not runnable**, rather than staying due
forever. Fix the rule (or delete and recreate the schedule) and turn it back On.

## Installing the scheduler add-on

Nothing calls `asx_StartDueSchedules` on its own; the product solution ships no
timer. The optional **scheduler add-on** is a separate solution
(`AscentixRulesEngineScheduler`) containing one cloud flow, **Rules Engine
Scheduler**, that wakes up every 15 minutes, calls `asx_StartDueSchedules`, and drives
every returned run id to completion with `asx_ProcessRunPage` (up to about a
**12-minute** budget per wake-up, so a very large backlog of due schedules or slow
runs is finished across more than one wake-up rather than blocking the flow
indefinitely).

To install it:

1. Install the core `AscentixRulesEngine` solution first (*Installing, Verifying &
   Uninstalling*) — the add-on uses its publisher and can't be provisioned without it.
2. Import the `AscentixRulesEngineScheduler` solution into the same environment.
3. In the Power Apps maker portal, bind a **Dataverse** connection to the solution's
   connection reference (`asx_SchedulerDataverse`). **A dedicated service account is
   recommended** rather than a person's own account, so the schedule keeps running
   independent of any one person's license or session, and so **Runs** and audit
   history show a consistent, recognizable caller for every scheduled run.
4. Turn the **Rules Engine Scheduler** flow **On**. A newly-imported flow is Off by
   default and can't run until a connection is bound.

`pipelines/scheduler/Deploy-Scheduler.ps1` in the repository automates steps 1–2 (and
re-applies the flow definition on a later run, so hand edits made in the flow designer
are overwritten the next time it's deployed); binding the connection and turning the
flow on are manual maker-portal steps every time, since they're identity decisions the
pipeline can't make for you.

### The service account's privileges

Whatever identity the bound connection runs as needs:

- The same privileges any caller of `asx_ProcessRunPage` needs to drive Rule Runs
  (*Running Rules On Demand* — **Create**, **Read**, **Append** and **Write** on Rule
  Run; **Append To** on Rule).
- **Read** and **Write** on **Rule Schedule** (`asx_ruleschedule`) — `asx_StartDueSchedules`
  advances **Next run on**, **Last run on**, **Last run** and **Last outcome** on the
  caller's behalf.
- **Create**, **Read** and **Write** on **Scheduler Status** (`asx_schedulerstatus`) —
  the heartbeat row the hub's status chip reads (below); the first call ever made
  creates it.

### User-context rules run as the scheduler account

A scheduled run is driven the same way any other Rule Run is: a **System**-context
rule always acts as the system user, but a **User**-context rule (*Evaluation
Context*) acts as whoever started or continued the run. For a schedule, that's the
identity bound to the add-on's connection (or whatever other caller drives
`asx_StartDueSchedules`), not the rule's author and not whoever last edited the
schedule. A User-context scheduled rule only reaches records that account can read,
so a narrowly-privileged service account can silently undercount **Changed**/skip
records it can't see: give it whatever business-table access the rule needs to act
against, the same way you would for a person running the rule by hand.

## The hub's scheduler status

The hub shows a small clock icon on any rule with a schedule that's On (hover it for a
one-line summary — "Daily at 02:00", "Every 15 minutes", and so on), and a status chip
in the header, shown only while at least one rule is scheduled:

- **Scheduler: last ran N minutes ago** — a caller reported in (the heartbeat on
  Scheduler Status) within the last 30 minutes. Healthy.
- **Scheduler not running since {time}** — a caller reported in before, but not in the
  last 30 minutes. The add-on flow may be turned off, its connection may have expired,
  or it may be failing before it reaches the heartbeat write; check the flow's run
  history in the maker portal.
- **Scheduler not installed** — no Scheduler Status row exists at all (or the current
  user can't read it), meaning `asx_StartDueSchedules` has never successfully been
  called in this environment. Install the add-on (above) or confirm your own caller is
  actually invoking `asx_StartDueSchedules`.

The engine itself never reads Scheduler Status; it exists purely for this indicator,
so a stale or missing heartbeat doesn't affect enforcement — only whether schedules
actually advance.

## Using your own scheduler instead

The add-on is optional. Anything that can call the Dataverse Web API on a timer —
Azure Automation, a different flow, an on-prem scheduled task — can drive schedules
the same way:

1. Call `asx_StartDueSchedules` (*Custom APIs*) with no parameters. It starts or
   continues every currently-due schedule (up to 50 per call — see *Beta
   Limitations*), records its own heartbeat, and returns `RunIds` (every run started
   or continued, plus any other active run of a scheduled rule left over from a
   previous wake-up) and `ScheduledCount`.
2. For each id in `RunIds`, call `asx_ProcessRunPage` (*Custom APIs*) in a loop until
   `Done` is `true`, exactly as the recipe under `asx_ProcessRunPage` describes for a
   flow that runs a rule for every matching record.
3. Call it again on your own interval. There's nothing to configure on the engine side
   for a second caller — multiple callers (your own plus the add-on, say) simply race
   harmlessly, since `asx_StartDueSchedules` never starts a second run for a rule that
   already has one active.

The caller's identity needs the same privileges listed above for the add-on's service
account.
