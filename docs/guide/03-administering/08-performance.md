---
title: Performance
section: Administering
order: 308
slug: performance
---

# Performance

How long the engine takes as data grows, measured on release 0.1.0.2. These figures are the
baseline later releases are compared against.

Measured on a Dataverse development environment in October 2026. Your times depend on your
environment's load, the other plug-ins on the same tables, and your data.

## How it was measured

The tests use a parent table with related child and lookup tables, and raise the data volume step
by step. Times are the engine's own, from its diagnostics (*Troubleshooting*): the platform's own
work on a save comes on top. Each save figure is the median of 5 or 10 records.

| Test | What it measures |
|---|---|
| Evaluating a save | One save of a record with N related rows, nothing written. The table has 100 other published rules, plus rules with date filters, a row count and a filtered total. |
| Also apply to the previous | A real save that changes a lookup, with a rule that updates the parent and its previous value. 100 other published rules. |
| Set actions | A real save whose rule updates, deactivates and deletes related rows, and creates a record per row. |
| On demand runs | A run over every record of a table: one rule that only reads, one that updates a related row per record. |
| Scheduler | One scheduler check starting 1, 10 or 50 due schedules. |
| Date comparisons | Date conditions on 1 to 7 related tables in one save. |

## Evaluating a save

| Related rows | Median | Largest part |
|---|---|---|
| 100 | 1.8 s | loading rules (75%) |
| 500 | 2.0 s | loading rules (61%) |
| 2,000 | 3.1 s | reading related rows (58%) |
| 5,000 | 5.7 s | reading related rows (73%) |
| 10,000 | 9.5 s | reading related rows (83%) |

Loading about 100 published rules costs about 1.3 seconds per save, whatever the data. Beyond a few
hundred related rows, reading them takes over.

## A save with Also apply to the previous

| Related rows | Median save | Largest part |
|---|---|---|
| 100 | 1.6 s | loading rules (85%) |
| 500 | 1.5 s | loading rules (78%) |
| 2,000 | 2.0 s | loading rules (64%) |
| 5,000 | 2.8 s | reading related rows (44%) |
| 10,000 | 4.1 s | reading related rows (65%) |

The save updates the parent and its previous value, but reads the related rows once: 10,027 rows at
10,000. It stays under 2 seconds up to about 2,000 related rows. It's faster than *Evaluating a
save* above because that test's extra rules (date filters, a row count, a filtered total) read more.

## Set actions on a save

| Related rows | Rows written | Median save |
|---|---|---|
| 100 | 134 | 2.6 s |
| 500 | 667 | 12.1 s |
| 2,000 | 2,667 | 48.0 s |
| 5,000 | 6,667 | about 2 minutes: over Dataverse's limit |

Deletes take about half of the time. At 5,000 related rows a save wrote 6,667 rows in 113 seconds,
and the next one ran past the **2-minute limit** Dataverse puts on a save's plug-ins, so it failed
and was rolled back. Keep a save's set actions to about 2,000 rows; for more, use an **On demand**
run.

## On demand runs

Engine time for the whole run, 500 records per page:

| Records | Rule that only reads | Rule that updates a row per record |
|---|---|---|
| 1,000 | 2.8 s | 11.4 s |
| 10,000 | 22.1 s | 1.8 min |
| 50,000 | 1.9 min | 9.1 min |

Time grows in line with the record count: about 1.6 million records an hour for a rule that only
reads, and about 330,000 an hour for one that writes. The slowest page took 1.6 s and 6.7 s
respectively, well inside a page's 60-second budget. The round trips between pages come on top.

## Scheduler

| Due schedules | One scheduler check |
|---|---|
| 1 | 0.8 s |
| 10 | 2.1 s |
| 50 | 12.7 s |

That's the time to start the runs, not to run them. A check stops after about 60 seconds and leaves
the rest for the next one.

## Date comparisons across tables

| Tables with a date condition | Median |
|---|---|
| 1 | 1.3 s |
| 3 | 1.2 s |
| 5 | 1.4 s |
| 7 | 1.5 s |

Comparing dates across more related tables adds little. About 80% of each save is loading the
rules.

## Guidance

- **Keep related rows small per save.** Use conditions and Rows filters so a save reads only the
  rows it needs. Microsoft recommends
  [2 seconds](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/analyze-performance)
  for a synchronous plug-in, which this release meets up to about 500 related rows.
- **Keep set actions on a save to about 2,000 rows.** Larger sets risk Dataverse's 2-minute limit.
  Use **Preview on a record** to see how many rows a record would write, and an **On demand** run for
  bigger jobs.
- **Plan runs by record count.** A rule that writes costs about five times one that only reads.
- **Measure on your own data.** Turn on **Capture diagnostics** (*Troubleshooting*) to time real saves,
  and turn it off when you're done.
