---
title: Beta Limitations
section: Getting Started
order: 106
slug: beta-limitations
---

# Beta Limitations

The engine is in **open beta**. Everything inside the boundary below should work as documented; if
it doesn't, [open a GitHub issue](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues).

## 1. What "open beta" means here

Free and Apache-2.0 licensed, built by a single maintainer, and meant for **non-production
environments** during the beta. No SLA and no warranty.

## 2. Supported scale and performance budget

Supported: about **100 published rules per environment** and about **5,000 related rows read per
save**.

With about 100 rules on the table (*Performance*), a save's rule evaluation stayed inside
[Microsoft's 2-second budget for synchronous plug-ins](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/analyze-performance)
up to about 500 related rows, and took about 5.7 seconds at 5,000. Your timings depend on the other
plug-ins on the same events and on your data.

- Bulk operations (`CreateMultiple`, `UpdateMultiple`) pay that cost for every record in the batch.
- A save whose rule writes many related rows can reach Dataverse's 2-minute limit (§17).

## 3. Traversal row cap: 25,000. Fails, never truncates

One evaluation loads at most **25,000 matching rows per related node**. Past that, the save fails
with an error naming the node, the cap and the table; it never evaluates partial data. The cap is
fixed during the beta.

Only rows that pass the filters applied in the Dataverse query count toward "matching". Applied in
the query:

- **Is Null** and **Is Not Null**.
- **Equals** a literal value.
- **Not Equals** and **Greater Than** / **Less Than** (and "or equal") against a literal number.
- In a collection filter on a date column: all of those operators against a literal date, "now" ±
  an interval, or a date on the rule's own record or a record it looks up (± an interval), as long
  as that record is outside the filtered collection's own branch.
- In a Row Count condition's own search criteria: the before/after operators against a literal
  date.

Everything else is applied after loading, and those rows count toward the cap: **Contains**, **Does
Not Contain**, **Not Equals** and before/after on text, a date-like value compared with a non-date
column, a comparison with another column or a field reference, and any OR group containing one of
these. Publishing such a rule shows a `TRAV_PUSHDOWN` warning: check that rule against the cap.

## 4. Related-record changes don't re-fire rules

Rules run when the rule's **own table** is written. Editing a related record (an order line, a
looked-up customer) doesn't re-run rules that read it; the result refreshes on the next write to the
rule's table.

## 5. System-context write actions bypass field-level security

A rule with **System** evaluation context writes as SYSTEM, which bypasses field-level security.
Authors can publish these without business-table privilege checks, so give the Author role only to
people trusted to decide that.

## 6. Enforcement-step drift and recovery

If enforcement steps drift from the published rules (for example, rules changed while the
registration plug-in was off), call `asx_SyncSteps` with `Mode=Sync`. It reconciles every table and
reports steps an administrator deactivated, without turning them back on.

## 7. Uninstalling requires step cleanup first

Run `asx_SyncSteps` with `Mode=RemoveAll` right before uninstalling, or the uninstall is blocked
(*Installing, Verifying & Uninstalling*).

## 8. Portal (Power Pages) channel testing

The **Portal** channel hasn't been tested against a live Power Pages site. Verify Portal-only rules
in your own environment.

## 9. Browser support

Verified on **Edge and Chrome**. Other browsers are untested during the beta.

## 10. No telemetry

The engine collects nothing from your environments. **A filed issue is the only signal there is.**

## 11. No rule transport between environments

There's no supported way to promote rules from dev to test to prod. Tools such as the Configuration
Migration Tool or XrmToolBox's Data Transporter can copy rule records, but neither has been tested
with the engine's tables; check the result in a sandbox first.

## 12. Upgrade history is short

Each beta release is verified to upgrade from the release just before it, and no further back.

## 13. How this is verified

Automated suites run on every change, and each release is tested against a live environment,
including a fresh install, verify and uninstall.

## 14. Localization

Localized rule messages are supported. Each release is spot-checked on one non-English org, not
across all languages.

## 15. On-demand Rule Run limits

| Limit | Value |
|---|---|
| Records per `asx_ProcessRunPage` call | 500, or 60 seconds, whichever comes first |
| Blocked/Failed records kept per run | the first 50, each message cut to 1,000 characters |
| Record ids in a **Records it's given** run | 250 |
| Active runs per rule | 1 (a second is refused until the first is cancelled or finishes) |

- A failed write rolls back its whole page, which then runs again without that record. A page with
  many failing writes takes many calls.
- An **All records that match "Only if"** run reads the **whole table**, a page at a time; **Only
  if** is checked per record, not in the query. On a large table, keep **Only if** tight.

**Schedules** (*Scheduling Rules*) start ordinary Rule Runs, so the same limits apply, plus:

- a scheduled run starts **within 15 minutes** of its time;
- each `asx_StartDueSchedules` call takes at most **50** due schedules and about **60 seconds**; the
  rest wait for the next call;
- the add-on drives runs for about **12 minutes** per check, so a large backlog spans several
  checks;
- a rule has at most **one** schedule.

## 16. The "apply inverse" flag is reserved

`asx_applyinversewhennotfired` can be set but nothing reads it, and the Rule Builder doesn't show
it. It's reserved for future use.

## 17. No write limit on set actions

A set action writes every filtered row, with no cap. A very large set can pass the platform's
2-minute limit for a save, which fails the save: in testing, 2,667 rows took 48 seconds and 6,667
rows passed the limit (*Performance*). Bound sets with the Rows filter and the rule's
conditions, and use **Preview on a record** to see how many rows a record would write. Rows are
sent one request at a time unless **Bulk writes** is on (§18).

## 18. Bulk writes are off by default

The engine can send two or more creates or updates of one table as a single `CreateMultiple` or
`UpdateMultiple` request. That makes set actions and **On demand** runs faster, but Microsoft
[doesn't support bulk messages in plug-in code](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/bulk-operations#not-supported-for-use-in-plug-ins).
So it ships off, and every write is a single request.

To use it, set the **Bulk writes** environment variable (`asx_BulkWrites`) to **Yes**. It applies
to the whole environment within a minute. Turning it on means accepting Microsoft's support
position for those writes.

