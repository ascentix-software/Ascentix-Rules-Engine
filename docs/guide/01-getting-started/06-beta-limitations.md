---
title: Beta Limitations
section: Getting Started
order: 106
slug: beta-limitations
---

# Beta Limitations

The Ascentix Rules Engine is in **open beta**. Everything inside the supported
boundary described below is expected to work as documented. If it doesn't, please
[open a GitHub issue](https://github.com/ascentix-software/Ascentix-Rules-Engine/issues).

## 1. What "open beta" means here

The engine is **free and Apache-2.0 licensed**, built and maintained by a
single maintainer. During the beta it is intended for **non-production
environments**. There is no SLA and no warranty: the software is provided
as-is under the Apache-2.0 licence.

## 2. Supported scale and performance budget

The supported ceiling for the beta: about **100 published rules per
environment**, and about **5,000 traversed related rows per save**.

Benchmarking shows that rules within these boundaries evaluate inside the
[2-second budget Microsoft recommends for synchronous plug-ins](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/analyze-performance).
Those tests were not run in your environment; real-world timings depend on the
number of other processes registered on the same events and the volume of data.
Bulk operations (`CreateMultiple`/`UpdateMultiple`) incur that per-record
evaluation cost for every record in the batch.

Beyond this envelope the engine may still work, but it's outside what the beta
has verified. Rule filters are pushed into the Dataverse queries where provably
safe, with column-pruned fetches and per-evaluation caching. Deeper performance
work (cross-execution caching, trigger/channel query filtering) is not part
of the beta.

## 3. Traversal row cap: 25,000. Fails, never truncates

A single rule evaluation will load at most **25,000 matching rows per
related node**. Exceeding the cap **fails the save with a named error**
(identifying the node, the cap, and the root table) rather than silently
evaluating against partial data. Rule filters count toward "matching": a
well-filtered rule works fine against multi-million-row tables as long as the
rows the rule needs stay under the cap. The cap is fixed during the beta and is
not configurable.

## 4. Related-record changes don't re-fire rules

Rules evaluate when the **root table** of the rule is written. Editing a
related record (a child line, a looked-up customer) does **not** re-evaluate
rules whose conditions read that record. The outcome refreshes on the next
root-table write, so put the trigger on the table whose writes should be gated.

## 5. System-context write actions bypass field-level security

A rule configured with **System** evaluation context performs its
Create/Update/Delete actions as SYSTEM, which bypasses field-level security
profiles. Publishing such a rule is privilege-gated: the publisher must hold
the org-wide `SEC_SYSWRITE_PRIV` privilege on each target table. The bypass is
inherent to system-context writes and is disclosed rather than blocked. Treat
users who can publish System-context write rules as customizer-equivalent.

## 6. Enforcement-step drift and recovery

The engine generates its enforcement steps automatically as rules are
published and unpublished. If steps drift from configuration (e.g. rules were
changed while the registration plugin was disabled), the **`asx_SyncSteps`
Custom API** (`Mode=Sync`) reconciles every table in one call and reports any
steps an administrator deactivated, without re-enabling them.

## 7. Uninstalling requires step cleanup first

Generated steps reference the engine's plugin type, so uninstalling the
managed solution is dependency-blocked until they're removed. Run
`asx_SyncSteps` with `Mode=RemoveAll` immediately before uninstalling
(*Administering → Installing, Verifying & Uninstalling*).

## 8. Portal (Power Pages) channel testing

The verification environment has no Power Pages site, so the **Portal** gate is
proven by exclusion only: a Standard caller (a form save, a Web API write) is
shown NOT to be blocked by a Portal-only rule, and the resolver's Portal
branch is unit-tested against a faked execution context. A rule *firing* for a
real portal submission has not been exercised live. Verify Portal-gated rules
in your own environment.

## 9. Browser support

The editor and form library are verified on **Chromium-class browsers**
(Edge, Chrome). Other browsers are untested during the beta.

## 10. No telemetry

By design, the engine collects no data from your environments: no usage data,
no error reports. **A filed issue is the only signal there is.**

## 11. No rule transport between environments

There is no supported dev→test→prod promotion of rule configuration during the
beta, and no GUID-preserving transport path. General-purpose data movement
tools such as the Configuration Migration Tool or the XrmToolBox Data
Transporter can move rule records between environments. Neither has been tested
against the engine's schema, so treat that route as unverified and confirm the
results in a sandbox first.

## 12. Upgrade history is short

The managed-upgrade path is executed once per release cycle on a fresh
verification org. Each beta release is verified to upgrade from its immediate
predecessor only; no upgrade path beyond that is documented.

## 13. How this is verified

Unit and contract suites run in CI on every change. Automated and manual
testing runs against a live environment each release, along with a scripted
fresh-org install/verify/uninstall run.

## 14. Localization

The engine stores and renders localized rule messages, and each release is
spot-checked on one non-English base-language org. Localization is not
systematically verified across languages during the beta.

## 15. The "apply inverse" flag is reserved

The `asx_applyinversewhennotfired` column exists in the schema and is settable,
on a Set Visible or Set Required action's classic form and through the API, but
nothing reads it: no runtime behaviour depends on its value. The Rule Builder
does not show it. It is reserved for possible future use.
