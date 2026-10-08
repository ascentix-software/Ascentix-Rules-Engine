---
title: Performance
section: Administering
order: 308
slug: performance
---

# Performance

This page summarizes the Rules Engine's performance tests: how long the engine took at growing data
volumes, what made it slower, and what that means for how you build rules.

All times were measured on our development (DEV) environment between 2026-09-30 and 2026-10-07.
Your times will vary with your org's load, the other plug-ins on the same tables and the shape of
your data.

## What was measured

The tests used a set of test tables: a parent table with related child tables and lookup tables.
Each scenario raised the data volume step by step. The times are the engine's own time, from its
diagnostics (see *Troubleshooting*). The platform's own work on a save, and the round trips between
the pages of a run, come on top.

| Scenario | What it measures |
|---|---|
| S1 | Evaluating the rules for one save of a record with N related rows (a dry run, nothing written). 100 background rules plus 3 rules with date filters, a row count and a filtered total |
| S2 | A real save that changes a lookup, with a rule that updates the parent and has **Also apply to the previous** turned on. 100 background rules, N related rows |
| S3 | A real save whose rule runs set actions (Update, Deactivate, Delete, Create per row) over N related rows. No other rules |
| S4 | An **On demand** run over **All records** of a table, up to 50,000 records: one rule that only reads, one that updates a related row per record. No other rules |
| S5 | One scheduler wake-up (`asx_StartDueSchedules`) starting 1, 10 or 50 due schedules |
| S6 | Evaluating date comparisons across 1 to 7 tables in one save |

S1, S2 and S3 report the median of 5 or 10 sampled records per step.

## Results

### Evaluating rules for one save (S1)

| Related rows per record | 2026-09-30 baseline | 2026-10-04 shared reads | 2026-10-07 round 2 |
|---|---|---|---|
| 100 | 4.6 s | 1.7 s | not run |
| 500 | not run | 1.8 s | not run |
| 2,000 | not run | 3.1 s | not run |
| 5,000 | not run | 5.6 s | not run |
| 10,000 | not run | 9.3 s | 10.2 s |

Up to 500 related rows, a save's evaluation stayed under the 2-second target. At 10,000 rows,
reading the related rows took 79% of the time. The 2026-10-07 run read the same rows as the
2026-10-04 run (14,973); loading the rules took 1.3 s instead of 1.1 s.

### A save with Also apply to the previous (S2)

| Related rows per record | Baseline | 2026-10-04 shared reads | 2026-10-07 round 2 |
|---|---|---|---|
| 100 | 4.2 s (2026-09-30) | 1.5 s | not run |
| 500 | 6.5 s (2026-09-30) | not run | not run |
| 2,000 | 13.7 s (2026-09-30) | not run | not run |
| 5,000 | 29.6 s (2026-09-30) | not run | not run |
| 10,000 | 50.7 s (2026-10-03) | 3.6 s | 4.2 s |

At 10,000 rows the baseline save read 510,192 rows. Since the shared-reads change it reads 10,027.

### Set actions on save (S3)

Measured on 2026-10-04.

| Related rows per record | Writes sent | Median save |
|---|---|---|
| 100 | 134 | 3.0 s |
| 2,000 | 2,667 | 56.9 s |

Deleting rows took the largest share (59% at 2,000 rows). The 10,000-row step wasn't measured: the
test setup lost its connection.

### On demand run over 50,000 records (S4)

Total engine time for the whole run: 100 pages of 500 records.

| Rule | 2026-10-04 shared reads | 2026-10-04 batched reads | 2026-10-05 batched writes |
|---|---|---|---|
| Reads only | 7.0 min | 1.8 min | 1.8 min |
| Updates a row per record | 27.4 min | 19.1 min | 11.9 min |

On the 2026-10-05 run that is about 1.7 million records per hour of engine time for the read-only
rule and about 252,000 for the updating rule. The slowest page took 1.4 s and 14.8 s, well inside a
page's 60-second budget. On 2026-10-04 the rate held steady from 1,000 to 50,000 records (370,561
to 426,399 records per hour read-only, 108,929 to 111,409 updating), so run time grows in proportion
to the record count.

### Scheduler and date comparisons (S5, S6)

On 2026-09-30 a scheduler wake-up took 0.9 s for 1 due schedule, 2.6 s for 10 and 11.5 s for 50,
against a 60-second budget per call. That is the time to start the runs, not to run them. S6 was
measured on the same day, before the shared-reads change, at one table only (4.0 s), so it isn't a
current figure.

## What drives cost

- **Related rows read.** In S1 and S2 the time grows with the related rows a save reads. At 10,000
  rows, reading them took 79% (S1) and 61% (S2) of the time on 2026-10-07.
- **Reading the same rows twice.** Before 2026-10-04 each rule read its related rows for itself, so
  one S2 save at 10,000 rows read 510,192 rows. Now a save shares those reads across its rules.
- **Loading the published rules.** With about 100 published rules, loading them took 1.1 to 1.4 s of
  every evaluation, whatever the row count. At 100 rows it was the largest share (72% in S1, 81% in
  S2, 2026-10-04).
- **Writes.** Writes take most of the time when rules change rows: 74% of the updating S4 run, and
  deletes 59% of the S3 save at 2,000 rows. Sending a run page's updates in groups (2,000 bulk
  requests instead of 50,000 single ones) cut the S4 write time from 951 s to 529 s.
- **Reads per run page.** Reading a page's rows in batches and loading the rules once per page cut
  the read-only S4 run from 7.0 to 1.8 minutes: 2,000 queries instead of 28,899, and 2.2 s of rule
  loading instead of 42 s.

## Guidance

- **Bound the related rows a save reads.** Use conditions and Rows filters so a save reads only the
  rows it needs. In S1, 500 related rows took 1.8 s, 2,000 took 3.1 s and 10,000 about 10 s.
  Microsoft recommends a 2-second budget for synchronous plug-ins.
- **Keep set actions small.** A save that wrote 2,667 rows took about a minute; the platform's
  limit for a synchronous save is 2 minutes. Use **Preview on a record** to see how many rows a
  record would write.
- **Plan large runs by record count.** An On demand run pages through the records 500 at a time,
  and its time grows in proportion to the records. A rule that writes costs more than one that only
  reads: about 12 minutes against 2 for 50,000 records. Allow extra time for the round trips
  between pages.
- **Measure on your own data.** Turn on **Capture diagnostics** (see *Troubleshooting*) to time
  real saves in your org, and set it back to **No** when you're done.
