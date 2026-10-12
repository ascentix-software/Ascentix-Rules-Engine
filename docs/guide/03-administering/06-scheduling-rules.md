---
title: Scheduling Rules
section: Administering
order: 306
slug: scheduling-rules
---

# Scheduling Rules

A rule that runs **On demand** for **All records that match "Only if"** can also run on a schedule.
A scheduled run is an ordinary **Rule Run**: it reads the same records as **Apply to records**
(*Running Rules On Demand*) and shows in the same **Runs** dialog.

Scheduling needs the optional **scheduler add-on** (below).

## Setting a schedule

Open the published rule. In the rule settings, **When it runs** → **On demand** → **Schedule**,
turn the schedule **On** and pick a pattern:

| Pattern | Options |
|---|---|
| Every N minutes | 15, 30 or 45 |
| Every N hours | 1 to 23 |
| Daily | a time of day |
| Weekly | a time of day, on one or more days |
| Monthly | a time of day, on a day of the month (the 31st runs on a shorter month's last day) |

Times use the rule's **Rule time zone** (rule settings → **Evaluation**; UTC by default). Below the
pattern, **Next** and **Last** show the next run and the last one with its outcome, and **View
runs** opens the **Runs** dialog.

Then **Save**. A schedule doesn't need a draft or a publish: it belongs to the published rule, and
saving it leaves the published rule untouched. **Save** is refused while the schedule is On and
incomplete; the section says what's missing.

### Who can set schedules

The **Rules Engine Author** and **Reader** roles don't include it. Grant **Create**, **Read**,
**Write** and **Append** on **Rule Schedule**, and **Append To** on **Rule**, to whoever may
schedule rules (*Security Roles*). Without Read, the section shows "You don't have access to rule
schedules."

## When scheduled runs start

The add-on checks every 15 minutes, so a run starts **within 15 minutes** of its scheduled time.

- **Missed runs aren't queued.** If the scheduler was off for a while, the next check starts one
  run and moves **Next** to the next time after now.
- **Minute and hour patterns keep their rhythm.** A 15-minute schedule due at 10:00 and picked up
  at 10:07 is next due at 10:15.
- **One run at a time.** If the rule's previous run is still going, the check continues that run
  instead of starting another, and the schedule stays due until it finishes.

### Schedules that can't run

| Situation | What happens |
|---|---|
| The rule is unpublished, no longer On demand for all records, or has an unknown time zone | The schedule stays On, records **Rule not runnable**, and tries again next time. Fix the rule and it picks up. |
| The schedule itself is invalid or lost its rule | It's turned **Off** with **Rule not runnable**. Fix it and turn it back On. |

## Installing the scheduler add-on

The add-on is a separate solution, `AscentixRulesEngineScheduler`, with one cloud flow, **Rules
Engine Scheduler**. Every 15 minutes it starts the due runs and drives them to completion.

1. Install the core **Ascentix Rules Engine** solution first (*Installing, Verifying &
   Uninstalling*).
2. Import `AscentixRulesEngineScheduler` into the same environment.
3. In the maker portal, bind a **Dataverse** connection to its connection reference
   (`asx_SchedulerDataverse`). Use a **dedicated service account**, so schedules don't depend on
   one person's license and **Runs** shows one recognizable caller.
4. Turn the **Rules Engine Scheduler** flow **On**. It's off until a connection is bound.

To uninstall, remove the add-on **before** the core solution.

### The service account

- It needs the same privileges as anyone who runs rules: **Create**, **Read**, **Append** and
  **Write** on **Rule Run**, and **Append To** on **Rule** (*Running Rules On Demand*). Nothing on
  Rule Schedule.
- Runs it starts are **owned by it**.
- A **User**-context rule (*Evaluation Context*) acts as this account, so it only sees records the
  account can read. Give it access to the tables the rule works on, or the run skips what it can't
  see.

## The hub's scheduler status

A scheduled rule shows a clock icon in the hub (hover for its pattern). While any rule is
scheduled, the hub header shows the scheduler's status:

| Status | Meaning |
|---|---|
| **Scheduler: last ran N minutes ago** | It checked in within the last 30 minutes. |
| **Scheduler not running since …** | No check-in for over 30 minutes. The flow may be off, its connection expired, or its calls failing. Check the flow's run history. |
| **Scheduler not installed** | It has never checked in. Install the add-on, or check your own caller. |

The status only reflects whether schedules advance. Enforcement doesn't depend on it.

## Using your own scheduler

Anything that can call the Dataverse Web API on a timer can replace the add-on:

1. Call `asx_StartDueSchedules` (*Custom APIs*). It starts or continues every due schedule (up to
   50 per call, about 60 seconds) and returns their run ids in `RunIds`.
2. For each id, in order, call `asx_ProcessRunPage` until `Done` is `true`.
3. Repeat on your own interval.

Two callers can run side by side. If they call at the same moment, one call fails and is simply
tried again next time; a rule never gets a second active run. The caller needs the same privileges
as the add-on's service account.
