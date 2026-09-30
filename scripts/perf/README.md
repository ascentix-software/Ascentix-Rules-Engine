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
python scripts/perf/generate.py          # lookup pool, perf_root records, child fan-out, asx_rule records
python scripts/perf/run-profile.py       # samples records, calls asx_RunRules, writes report
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

## Reports

Reports are written to `docs/perf/reports/` as a Markdown file (human-readable summary table)
and a sibling `.csv` (per-stage median/p95/max, suitable for cross-release diffing).
They are not committed.

Filename format: `<date>-<label>.md` / `<date>-<label>.csv`

## Reset vs Teardown

**Between runs** (keep schema + tableconfig tree, wipe data + rules):
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