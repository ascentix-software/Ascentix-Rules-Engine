# Rules Engine Sample App

Provisions a disposable Order-domain sample (5 `sample_` tables + model-driven app + seed data +
six `asx_` rules) for testing the rules engine and the client form library. The fixture schema is
summarised in `docs/Schema.md` §8.

`create-schema.py` is the **complete fixture-schema provisioning script for a fresh org**: it
creates every `sample_*` table / column / lookup the live client suites (`client/test-dev`,
`client/e2e`, `client/scripts/seed-*`) depend on, including `sample_shipment` (the EXISTS
sibling collection under `sample_order`: `sample_name` PK, `sample_isexpedited`, `sample_shipamount`,
lookup `sample_orderid` → `sample_order`) and `sample_orderline.sample_notes` (the pushdown-volume
shape flag). Column shapes mirror DEV metadata exactly, so re-running on DEV prints `[skip]` for
every step.

## Prerequisites

- `.env` in the repo root with `DATAVERSE_URL` and either `CLIENT_ID` / `CLIENT_SECRET` /
  `TENANT_ID` or the client suites' `SERVICE_PRINCIPAL_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT_ID`
  (`scripts/auth.py` falls back to the long names). Without a service principal, `auth.py` uses
  the shared Dataverse CLI token cache, or device code. If that fails, authenticate with the
  Dataverse CLI first.
- `python -m pip install azure-identity msal msal-extensions`.
- Run all scripts from the **repo root**.
- **Target org:** the scripts hit whatever `DATAVERSE_URL` is in the process environment, which
  overrides the `.env` value, so the fixture schema can be pointed at another org, such as the Tier-C
  trial org, without editing `.env`:
  `DATAVERSE_URL=https://<org>.crm3.dynamics.com/ python scripts/sample-app/create-schema.py`.
  Labels are emitted in the target org's base language, so a French-only org works. Only run
  `create-schema.py` against the trial org: its rules, app and seed data are not wanted there.

## Provision (in order)

```
python scripts/sample-app/create-schema.py     # publisher, solution, 5 tables (incl. sample_shipment), columns (incl. sample_orderline.sample_notes), relationships
python scripts/sample-app/seed-data.py          # customers, products, orders, lines
python scripts/sample-app/author-rules.py       # tableconfig graph + six asx_ rules
python scripts/sample-app/create-app.py         # model-driven app "Rules Engine Sample" + sitemap
python scripts/sample-app/build-order-form.py   # Order form: fields + hidden Handling Instructions + Order Lines subgrid
```

All scripts are idempotent (check-first), so they are safe to re-run. `create-schema.py` ends with a
solution-membership pass (`AddSolutionComponent` for any `sample_*` table not yet in
`RulesEngineSampleApp`). This repairs orgs provisioned while `_dv.py` sent the ignored
`MSCRM.SolutionName` header (fixed to `MSCRM.SolutionUniqueName` 2026-08-22).

> `build-order-form.py` omits the multi-select `sample_ordertags` field (its control class id is
> environment-specific). Add it in the form designer for interactive R2 testing. The rule
> still fires server-side on the seeded ORD-1003 regardless.

## Teardown

```
python scripts/sample-app/teardown.py        # DESTRUCTIVE: removes rules, data, tables, solution
```

> The `teardown.py` script does not remove the model-driven app or form. Delete the **Rules Engine Sample** app manually in the maker portal.

## What the rules demonstrate

| Rule | Shape | Fires on |
|---|---|---|
| R1 SetRequired approval notes | root bool FieldComparison | ORD-1003 (expedited) |
| R2 SetVisible handling | root multi-select | ORD-1003 (Fragile) |
| R3 Block bad email | root EmailAddress validator | ORD-1002 |
| R4 Block no lines | RowCount on child | ORD-1004 |
| R5 Block over credit limit | FieldReference to lookup node | ORD-1002 |
| R6 ShowMessage VIP | multi-level lookup (customer/parent) | ORD-1001, ORD-1003 |
