---
title: Running Rules On Demand
section: Administering
order: 304
slug: running-rules-on-demand
---

# Running Rules On Demand

An **On demand** rule (*Triggers & Channels*) runs when someone runs it, not on a save. Unlike
**Preview on a record**, a run is **enforced**: a fired **Block** stops that record, and the other
fired writes are applied. This page covers **Apply to records**, the **Runs** dialog and the **Rule
Run** record behind them. Scripts and flows can call the same `asx_ApplyRules` and
`asx_ProcessRunPage` Custom APIs (*Custom APIs*).

## Runs for

**Runs for** (`asx_ondemandscope`) is on the rule settings' **On demand** card, shown once **On
demand** is ticked. It decides which records the rule can run against:

| Runs for | Runs against |
|---|---|
| **Records it's given** (default) | Up to 250 records you choose (`asx_ApplyRules`: the one record it's called for). |
| **All records that match "Only if"** | The whole table, a page at a time, applying the rule to each record that passes its **Only if** conditions. |

With **All records**, the **Only if** conditions aren't applied in the Dataverse query yet, so every
row is read. On a large table, keep **Only if** narrow (*Beta Limitations*).

## Apply to records

On a published On demand rule, choose **Run now** (the play icon) on its row in the hub, or **Apply
to records…** from the **Run** button's menu in the Rule Builder. The **Run** dialog opens on its
**Apply to records** tab. It always runs the **published** version, never your unpublished draft.

Before you start, the tab shows:

- **Version**: the live version, for example **Live v3**.
- **Records**: an **Add records…** picker (up to 250) for **Records it's given**, or the table and
  the **Only if** conditions for **All records**.
- **Writes**: each write action. Blocked records are counted and skipped.
- **Runs as**: **System**, or **You** for a User-context rule (*Evaluation Context*).

**Apply to matching records** (or **Apply to N records**) starts the run and shows its progress:
**Running · page N**, the records checked so far, and **Stop run** and **View runs**.

## What a run counts

| Count | Meaning |
|---|---|
| **Records checked** | Every record the run processed. |
| **Changed** | At least one write was applied. |
| **Blocked** | A Block fired; no writes. |
| **Failed** | A write failed, or the record couldn't be found or read. |
| **Didn't match** | It didn't pass **Only if**. Most records of an **All records** run end up here. |

The run keeps the first 50 Blocked and Failed records with their messages. A run that reaches 100
Failed with nothing succeeding stops itself as **Failed**.

## Runs, Stop and Resume

Keep the tab open: closing it pauses the run, and the progress view says so. The run itself stays on
the server.

Open **Runs** from the history icon next to Run now in the hub, or **View runs** in the Rule
Builder's **Run** menu. It lists each run with its **Status**, **Started** (when, and by whom or
**Scheduled**), **Changed**, **Blocked**, **Failed** and **Checked**. Expand a run with failures to
see each record (linked) and its message.

| Status | Meaning |
|---|---|
| **Queued**, **Running** | In progress. **Stop** ends it after the current page, as **Cancelled**. |
| **Paused** | No progress for 2 minutes, usually a closed tab. **Resume** carries on from where it stopped. |
| **Completed**, **N failed** | Finished, with or without failed records. |
| **Cancelled**, **Failed** | Stopped by someone, or by the 100-failure safety stop. |

A rule has **one run at a time**. Starting another while one is Queued or Running is refused: "This
rule already has a run in progress. Cancel or resume it first." A run can't be edited, only
cancelled.

## Who can run rules

The Author and Reader roles don't include this (*Security Roles*). Grant it to whoever may run
rules, for example with a small role on top:

| Table | Privileges |
|---|---|
| **Rule Run** (`asx_rulerun`) | **Create** (needed to start, resume or call `asx_ApplyRules`), **Read** (the Runs dialog), **Append**, **Write** at user level or wider (Stop) |
| **Rule** (`asx_rule`) | **Append To** |

The rule's **Evaluation Context** decides whose access the run uses. A **User**-context rule acts as
the person who started or resumed the run, so it only reaches records they can read: an **All
records** run skips rows they can't see, and a chosen record they can't read counts **Failed**
("Record not found or not readable."). A **System**-context rule acts as the system user.
