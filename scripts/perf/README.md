# Perf Profiling Harness

A dev-only performance-profiling fixture for the Ascentix Rules Engine.
Provisions a dedicated `perf` solution (7 tables + 15-node tableconfig tree) in the DEV
environment, generates configurable data volumes and rules, drives `asx_RunRules` with
diagnostics enabled, and writes timestamped profiling reports.


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
| `--rules N` | 100 | Number of `asx_rule` records to create |
| `--records N` | 100 | Number of `perf_root` records |
| `--child-fanout N` | 10 | Children per parent at **each** child level. Multiplicative, so `--records 25 --child-fanout 10` seeds 25 roots, 250, 2,500 and 25,000 children |
| `--lookup-breadth N` | 4 | Sibling lookup nodes to exercise per root (max 6) |
| `--seed N` | 1234 | Random seed for deterministic reproducibility |

Example:
```
python scripts/perf/generate.py --records 25 --child-fanout 10 --rules 100 --lookup-breadth 4
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