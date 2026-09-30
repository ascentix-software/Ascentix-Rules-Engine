# Perf Profiling Harness

A dev-only performance-profiling fixture for the Ascentix Rules Engine.
Provisions a dedicated `perf` solution (8 tables, including `perf_followup` — the Create per
row target — + 15-node tableconfig tree) in the DEV environment, generates configurable data
volumes and rules, drives `asx_RunRules` with diagnostics enabled, and writes timestamped
profiling reports.

> If your DEV environment was provisioned before `perf_followup` existed, re-run
> `create-schema.py` — it is idempotent (check-first) and will add the missing table and
> relationship without touching anything already there. `reset-data.py` now expects
> `perf_followup` to exist.
>
> `reset-data.py` also expects the product's `asx_rulediagnostic` table, and S2/S3 its
> `asx_CaptureDiagnostics` environment variable. Both come from
> `Configure-RuleAuthoring.ps1 -Phase Schema`; run it on an environment deployed before they existed.


## Prerequisites

- Connected to the dev environment (`.env` with `DATAVERSE_URL`, `scripts/auth.py` working).
  If Python auth fails on Windows, authenticate with the Dataverse CLI first.
- Run all scripts from the **repo root**.
- The plugin assembly must be built and pushed, once (see **One-time setup**).

## One-time setup

Build the plugin and push it to the environment. Requires the Power Platform CLI (`pac`).

```
dotnet build ValidationEngine.slnx
pac plugin push --pluginFile Ascentix.RulesEngine.Plugin\bin\Debug\net462\Ascentix.RulesEngine.Plugin.dll
```

`run-profile.py` calls `asx_RunRules` with `IncludeDiagnostics`. That parameter and the
`Diagnostics` response property are components of the product solution, so an environment with
the solution installed already has them.

## Provision (in order)

```
python scripts/perf/create-schema.py     # perf publisher, PerfHarness solution, tables, columns, relationships
python scripts/perf/author-config.py     # 15-node asx_tableconfig tree rooted at perf_root
```

Then either a one-off profile:

```
python scripts/perf/generate.py          # lookup pool, perf_root records, child fan-out, asx_rule records
python scripts/perf/run-profile.py       # samples records, calls asx_RunRules, writes report
```

or a scenario ladder, which resets and generates each step itself (see **Scenario driver**):

```
python scripts/perf/run-scenario.py --scenario S1
```

All scripts are idempotent (check-first), so they are safe to re-run.

## Parameters

### generate.py

| Flag | Default | Description |
|---|---|---|
| `--rules N` | 100, or the profile's default | Number of background `asx_rule` records to create |
| `--records N` | 100 | Number of `perf_root` records |
| `--child-fanout N` | 10 | Children per parent at **each** child level. Multiplicative, so `--records 25 --child-fanout 10` seeds 25 roots, 250, 2,500 and 25,000 children |
| `--rows-per-root N` | — | Flat mode: exactly N perf_child1 rows per root, categories cycling 30001/30002/30003, no child2/child3. Use for exact ladder steps. Overrides `--child-fanout` |
| `--lookup-breadth N` | 4 | Sibling lookup nodes to exercise per root (max 6) |
| `--seed N` | 1234 | Random seed for deterministic reproducibility |
| `--profile S1..S6` | — | Add a performance scenario's rule shapes (see below) |
| `--profile-step K` | 1 | S5: number of scheduled rules (1-50); S6: number of tables compared (1-7) |

Every seeded row (lookup pool, roots, children) also gets a `perf_date` 0-60 days before today.

Rules are created as drafts and published one by one with a `statuscode` PATCH, exactly as the
Rule Builder publishes (the revision guard refuses a rule created already Published). Publishing
registers the enforcement steps, so the rules also enforce real saves of `perf_root`.

Example:
```
python scripts/perf/generate.py --records 25 --child-fanout 10 --rules 100 --lookup-breadth 4
```

#### Scenario profiles (`--profile`, `--profile-step`)

`--profile` adds one scenario's rules on top of the background rules. Each is authored as a draft
(rule, group, conditions with any node filter, actions with any Rows filter, the same records the
Rule Builder writes) and published with the background rules. Every name starts `PERF-RULE-`, so
`reset-data.py` and `teardown.py` remove them. The shapes and payloads live in `profiles.py` and
are unit-tested by `test_profiles.py`.

| Profile | Background default | Rules added |
|---|---|---|
| S1 | 100 | `PERF-RULE-S1-DATE-NOW`: Row Count on PERF Child1 with `perf_date ge now - 30 days` (pushes down). `PERF-RULE-S1-DATE-ROW`: Row Count on PERF Child1 with `perf_date le createdon + 30 days` of the same row (evaluated in memory). `PERF-RULE-S1-CALC`: Calculation `sum(PERF Child1 perf_amount)` over category 30001 rows (a filtered total). All On Update, Show Message |
| S2 | 100 | `PERF-RULE-S2-PREVIOUS`: when PERF Child1 has a row, Update PERF L1's `perf_number` from the root, with Apply to previous parent (changing `perf_lookup1id` also updates the old L1) |
| S3 | 0 | `PERF-RULE-S3-SET`: fires when the root's `perf_text` contains `S3FIRE`; on PERF Child1 rows, a set Update (category 30001), a set Deactivate (30002, active rows), a set Delete (30003) and a Create per row into `perf_followup` (30001) |
| S4 | 0 | `PERF-RULE-S4-READ` (a field check on PERF L1, Show Message) and `PERF-RULE-S4-WRITE` (a set Update of active PERF Child1 rows). On demand, All records |
| S5 | 0 | K rules `PERF-RULE-S5-000`... alternating the S4 read and write shapes, each with an every-15-minutes schedule (created after publishing; Next run on is engine-owned) |
| S6 | 100 | `PERF-RULE-S6-<table>`: `perf_date >= now - 10 years` on each of the first K of perf_root, perf_lookup1-3, perf_child1-3. On Update, Show Message |

`--rules` overrides the background default. For S2 and S3, which are measured with real saves, the
background Block actions are created as Show Message actions with the same trigger, text and
severity: the same condition and traversal cost, but a background rule can never fail the save
being measured. S4 and S5 (up to 50,000 roots) skip wiring half the roots' `perf_parentrootid`
self-reference, one PATCH per root; their rules never read PERF Self.

```
python scripts/perf/generate.py --records 25 --rows-per-root 2000 --profile S1
python scripts/perf/generate.py --records 1000 --rows-per-root 1 --profile S5 --profile-step 10
```

### run-profile.py

| Flag | Default | Description |
|---|---|---|
| `--sample N` | 25 | Number of `perf_root` records to sample |
| `--reps R` | 1 | API calls per record |
| `--label LABEL` | baseline | Report label (used in the output filename) |

Example:
```
python scripts/perf/run-profile.py --sample 25 --reps 1 --label baseline-25r-10f-100rules
```

## Scenario driver

`run-scenario.py` runs one performance scenario up its ladder of step sizes on DEV and stops at the
first failing step.

```
python scripts/perf/run-scenario.py --scenario S1..S6 [--ladder 100,500,2000] [--label baseline]
                                    [--sample N] [--trace-settle 600]
```

| Flag | Default | Description |
|---|---|---|
| `--scenario` | (required) | S1 to S6 |
| `--ladder` | the scenario's ladder below | Comma list of step sizes |
| `--label` | baseline | Report label (used in the file names) |
| `--sample` | 10 for S2 and S3, 5 for the others | Roots sampled per step (S1-S3, S5, S6) |
| `--trace-settle` | 600 | S2, S3: seconds to keep probing for a probe save's diagnostics row before measuring |

Each step: reset the data (`reset-data.py`), generate the step's data and rules (`generate.py`
with the flags below), drive the scenario, and record pass or fail with its error, the per-stage
timings and the counters. After the last step, and also after an error or Ctrl+C, the data is reset
once more and (S2, S3) the `asx_CaptureDiagnostics` switch is put back exactly as it was. If that
final reset fails, the driver logs it (run `reset-data.py` by hand) and keeps the results. The
reports are written from every step that finished, even when the run is interrupted.

| Scenario | Default ladder | A step generates | Driven by |
|---|---|---|---|
| S1 | 100, 500, 2,000, 5,000, 10,000 | `--rows-per-root <step> --profile S1`; `--sample` roots, capped so a step seeds at most 50,000 child rows | `asx_RunRules` (OnUpdate, dry run) with diagnostics on every root |
| S2 | same | the same, `--profile S2` | A real save of each root changing `perf_lookup1id` to another L1 |
| S3 | same | the same, `--profile S3` | A real save of each root writing `perf_text` = `S3FIRE-<n>` (fires the set actions) |
| S4 | 1,000, 10,000, 50,000 | `--records <step> --rows-per-root 1 --profile S4` | A Rule Run per rule (`PERF-RULE-S4-READ`, then `PERF-RULE-S4-WRITE`), paged with `asx_ProcessRunPage` until done; reported as `<step>:no-writes` and `<step>:set-update` |
| S5 | 1, 10, 50 | `--records <sample> --rows-per-root 1 --profile S5 --profile-step <step>` | One `asx_StartDueSchedules` call once every schedule is due |
| S6 | 1 to 7 | `--records <sample> --child-fanout 3 --profile S6 --profile-step <step>` | `asx_RunRules` as S1 |

A step **fails**, and the ladder stops there, when:
- `generate.py` or `reset-data.py` fails (recorded as `setup: ...`);
- a call or save errors or times out (the 2-minute plug-in limit, the 25,000-row cap, ...);
- S1, S6: the median total is above 2,000 ms;
- S2, S3: the probe never wrote a diagnostics row (`enforcement did not settle`), or any save
  has no diagnostics row when the 60-second read window ends (`found M of N diagnostics rows`);
- S4: a run page fails (a repeated record failure or any other error), or the run doesn't finish
  within its page budget;
- S5: the call takes more than 60,000 ms, or fewer schedules were started or continued than were due.

**DEV only.** The driver refuses to run unless `DATAVERSE_URL` (the process environment wins over
`.env`) is the DEV URL in `.env`. It never reads or prints secrets.

**S2, S3 read the diagnostics table.** While the product's `asx_CaptureDiagnostics` environment
variable (Boolean, default no) is on, every save the engine evaluates writes one `asx_rulediagnostic`
row per saved record with its full diagnostics JSON. For S2 and S3 the driver turns it on for the
whole run: it PATCHes the variable's value row to `yes`, or creates one bound to the definition when
there is none. At the end, even after a failed step or Ctrl+C, it puts it back exactly: it PATCHes
the previous value back, or deletes the value row when there was none before. It refuses to start
when the definition is missing or has an inactive or second value row. It never touches the
organization's plug-in trace setting, and S1, S4, S5 and S6 never touch the variable. It needs the
privileges to read and write environment variable values and read `asx_rulediagnostic`.

Before a step's measured saves the driver probes: it saves one sampled root (S2 changes its lookup;
S3 writes `perf_text` without the fire marker) until that root gets a new diagnostics row, retrying
for up to `--trace-settle` seconds. The plug-in reads the switch through a cache that refreshes at
most once a minute, and a freshly published rule can take a few minutes to go live, which is why
`--trace-settle` defaults to 600 seconds. After the saves, the driver reads back one row per
measured save (by the root's record id, created from the probe row on, less every row that was
there before), stopping as soon as every save has one and waiting at most 60 seconds. Each save
counts once: if the engine ran more than once for a save, the slower row is kept and the result
notes `duplicateDiagRows`. Every S3 save creates follow-ups; the per-step reset removes them, and
the perf diagnostics rows too.

**Why a table, not the trace log.** The first version read an `asx-diag` line per save from
`plugintracelogs`, with the trace setting on All. On DEV that log arrived minutes late and dropped
rows (5 saves in a row left only 3 engine rows), so a step had to pass on whatever lines survived.
The diagnostics row is written inside the save itself, so it is there as soon as the save returns
and never dropped: a step now needs every save's row, and every S2 and S3 result records found of
saved (`diagCaptured`, for example `10/10`). The `asx-diag` trace line is still written, as a
troubleshooting aid. S2 and S3 sample 10 roots by default (at the 10,000 step the 50,000-row cap
still limits them to 5).

**S5 waits.** Its schedules run every 15 minutes and Next run on is engine-owned, so each step
waits until they are all due (about 15 minutes, 20 at most; a schedule without a Next run on yet
counts as not due). It refuses to start, and a step fails, while another caller's scheduler
heartbeat is under 20 minutes old: turn the **Rules Engine Scheduler** flow off before S5, wait 20
minutes, and turn it back on afterwards. The driver never switches the flow itself.

**S4 volume.** The 50,000 step holds about 100,000 rows (50,000 roots and a child row each).

### Scenario reports

Written to `docs/perf/reports/` (not committed), dated with the day the run started, so a ladder
that runs past midnight (S4, S5) joins that day's capacity summary. For S4, a call that only reports
a failed record (`FailedRecordId`) processes no records and isn't counted as a page.

- `<date>-<label>-<scenario>.md`: one row per step (result, samples, total and max ms, dominant
  stage, error and, for S2 and S3, the diagnostics rows found of the saves), then a stage table
  and a counter table across the steps.
- `<date>-<label>-<scenario>.csv`: the same per step (S2 and S3 add a `diagCaptured` column), one
  column per counter and per stage.
- `<date>-<label>-<scenario>.json`: the raw step results.
- `<date>-<label>-capacity.md`: rebuilt after every scenario from every `<date>-<label>-S*.json`.
  Per scenario: the last passing step, the first failing step and its error, and the dominant
  stage at the top passing step with its share of the total ms. The page containers
  (`pageEvaluate`, `pageWrite`) count as the dominant stage only when no finer stage was timed.
  When S2 or S3 is included, a last column gives the diagnostics rows found at the top passing
  step, so you can see how many saves its figures rest on.

## Reports

Reports are written to `docs/perf/reports/` as a Markdown file (human-readable summary table)
and a sibling `.csv` (per-stage median/p95/max, suitable for cross-release diffing).
They are not committed.

Filename format: `<date>-<label>.md` / `<date>-<label>.csv`

## Reset vs Teardown

**Between runs** (keep schema + tableconfig tree, wipe data + rules + the perf tables'
`asx_rulediagnostic` rows):
```
python scripts/perf/reset-data.py
```
Then re-run `generate.py` and `run-profile.py` for the next volume configuration.

**Full retire** (rules, data, tableconfig tree, tables, solution, publisher):
```
python scripts/perf/teardown.py [--dry-run]
```
`--dry-run` prints what would be deleted without deleting anything.

> After teardown, re-run the full provision sequence from `create-schema.py` to restore.